import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { MihomoWebSocket } from 'tauri-plugin-mihomo-api'

const MAX_CLOSED_CONNS_NUM = 500
const CONNECTION_UPDATE_THROTTLE_MS = 500
const CONNECTION_RECONNECT_DELAY_MS = 1_000
const DOMAIN_TRAFFIC_WINDOW_MS = 24 * 60 * 60 * 1000
const DOMAIN_TRAFFIC_BUCKET_MS = 60 * 1000
const DOMAIN_TRAFFIC_STORAGE_KEY = 'clash-verge-domain-traffic-24h'
const DOMAIN_TRAFFIC_PERSIST_INTERVAL_MS = 5_000

type ConnectionMetadata = IConnectionsItem['metadata']
type ConnectionListener = () => void

const metadataValue = (value?: string) => value || ''

const initConnData: ConnectionMonitorData = {
  uploadTotal: 0,
  downloadTotal: 0,
  activeConnections: [],
  closedConnections: [],
}

interface ConnectionMonitorData {
  uploadTotal: number
  downloadTotal: number
  activeConnections: IConnectionsItem[]
  closedConnections: IConnectionsItem[]
}

interface ConnectionSummaryData {
  activeConnectionCount: number
}

interface DomainTrafficUsage {
  domain: string
  upload: number
  download: number
}

interface DomainTrafficBucket {
  timestamp: number
  domains: Record<string, { upload: number; download: number }>
}

const initConnSummaryData: ConnectionSummaryData = {
  activeConnectionCount: 0,
}

const loadDomainTrafficBuckets = (): DomainTrafficBucket[] => {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(DOMAIN_TRAFFIC_STORAGE_KEY) || '[]',
    ) as DomainTrafficBucket[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let domainTrafficBuckets = loadDomainTrafficBuckets()
let domainTrafficSnapshot: DomainTrafficUsage[] = []
let lastDomainTrafficPersistAt = 0
const domainTrafficListeners = new Set<ConnectionListener>()

const pruneDomainTrafficBuckets = (now: number) => {
  const cutoff = now - DOMAIN_TRAFFIC_WINDOW_MS
  domainTrafficBuckets = domainTrafficBuckets.filter(
    (bucket) => bucket.timestamp > cutoff,
  )
}

const rebuildDomainTrafficSnapshot = (now: number) => {
  pruneDomainTrafficBuckets(now)
  const totals = new Map<string, { upload: number; download: number }>()

  for (const bucket of domainTrafficBuckets) {
    for (const [domain, usage] of Object.entries(bucket.domains)) {
      const total = totals.get(domain) || { upload: 0, download: 0 }
      total.upload += usage.upload
      total.download += usage.download
      totals.set(domain, total)
    }
  }

  domainTrafficSnapshot = [...totals.entries()]
    .map(([domain, usage]) => ({ domain, ...usage }))
    .sort((left, right) =>
      right.upload + right.download - (left.upload + left.download),
    )
  domainTrafficListeners.forEach((listener) => listener())
}

const persistDomainTrafficBuckets = (now: number) => {
  if (typeof window === 'undefined') return
  if (now - lastDomainTrafficPersistAt < DOMAIN_TRAFFIC_PERSIST_INTERVAL_MS) return
  lastDomainTrafficPersistAt = now
  try {
    window.localStorage.setItem(
      DOMAIN_TRAFFIC_STORAGE_KEY,
      JSON.stringify(domainTrafficBuckets),
    )
  } catch {
    // Storage may be unavailable or full; in-memory statistics still work.
  }
}

const domainForConnection = (connection: IConnectionsItem) => {
  const host = connection.metadata.host?.trim()
  const remoteDestination = connection.metadata.remoteDestination?.trim()
  const destinationIP = connection.metadata.destinationIP?.trim()
  // Mihomo's host/remoteDestination fields are preferred over raw IPs.
  return host || remoteDestination || destinationIP || 'Unknown'
}

const recordDomainTrafficDeltas = (
  connections: IConnectionsItem[],
  previousById: Map<string, IConnectionsItem>,
) => {
  const now = Date.now()
  const bucketTimestamp =
    Math.floor(now / DOMAIN_TRAFFIC_BUCKET_MS) * DOMAIN_TRAFFIC_BUCKET_MS
  let bucket = domainTrafficBuckets.find(
    (item) => item.timestamp === bucketTimestamp,
  )

  for (const connection of connections) {
    const previous = previousById.get(connection.id)
    if (!previous) continue

    const upload = Math.max(0, connection.upload - previous.upload)
    const download = Math.max(0, connection.download - previous.download)
    if (upload === 0 && download === 0) continue

    if (!bucket) {
      bucket = { timestamp: bucketTimestamp, domains: {} }
      domainTrafficBuckets.push(bucket)
    }

    const domain = domainForConnection(connection)
    const usage = bucket.domains[domain] || { upload: 0, download: 0 }
    usage.upload += upload
    usage.download += download
    bucket.domains[domain] = usage
  }

  rebuildDomainTrafficSnapshot(now)
  persistDomainTrafficBuckets(now)
}

let connectionData: ConnectionMonitorData = initConnData
let connectionSummary: ConnectionSummaryData = initConnSummaryData
let connectionSocket: MihomoWebSocket | null = null
let connectionConnecting = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingMessageData: string | null = null
let lastFlushAt = 0

const connectionListeners = new Set<ConnectionListener>()
const summaryListeners = new Set<ConnectionListener>()

const notifyConnectionListeners = () => {
  connectionListeners.forEach((listener) => listener())
}

const notifySummaryListeners = () => {
  summaryListeners.forEach((listener) => listener())
}

const hasConnectionSubscribers = () =>
  connectionListeners.size > 0 ||
  summaryListeners.size > 0 ||
  domainTrafficListeners.size > 0

const sameMetadata = (left: ConnectionMetadata, right: ConnectionMetadata) =>
  metadataValue(left.network) === metadataValue(right.network) &&
  metadataValue(left.type) === metadataValue(right.type) &&
  metadataValue(left.host) === metadataValue(right.host) &&
  metadataValue(left.sourceIP) === metadataValue(right.sourceIP) &&
  metadataValue(left.sourcePort) === metadataValue(right.sourcePort) &&
  metadataValue(left.destinationPort) ===
    metadataValue(right.destinationPort) &&
  metadataValue(left.destinationIP) === metadataValue(right.destinationIP) &&
  metadataValue(left.remoteDestination) ===
    metadataValue(right.remoteDestination) &&
  metadataValue(left.process) === metadataValue(right.process) &&
  metadataValue(left.processPath) === metadataValue(right.processPath)

const normalizeMetadata = (
  metadata: ConnectionMetadata,
  previous?: ConnectionMetadata,
): ConnectionMetadata => {
  if (previous && sameMetadata(previous, metadata)) return previous

  return {
    network: metadata.network || '',
    type: metadata.type || '',
    host: metadata.host || '',
    sourceIP: metadata.sourceIP || '',
    sourcePort: metadata.sourcePort || '',
    destinationPort: metadata.destinationPort || '',
    destinationIP: metadata.destinationIP || '',
    remoteDestination: metadata.remoteDestination || '',
    process: metadata.process || '',
    processPath: metadata.processPath || '',
  }
}

const sameChains = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

const normalizeChains = (chains: string[], previous?: string[]) => {
  if (previous && sameChains(previous, chains)) return previous
  return chains.slice()
}

const normalizeConnection = (
  connection: IConnectionsItem,
  previous?: IConnectionsItem,
): IConnectionsItem => {
  const metadata = normalizeMetadata(connection.metadata, previous?.metadata)
  const chains = normalizeChains(connection.chains || [], previous?.chains)
  const upload = connection.upload ?? 0
  const download = connection.download ?? 0
  const curUpload = previous ? upload - previous.upload : 0
  const curDownload = previous ? download - previous.download : 0
  const rule = connection.rule || ''
  const rulePayload = connection.rulePayload || ''
  const start = connection.start || ''

  if (
    previous &&
    previous.metadata === metadata &&
    previous.chains === chains &&
    previous.upload === upload &&
    previous.download === download &&
    previous.curUpload === curUpload &&
    previous.curDownload === curDownload &&
    previous.rule === rule &&
    previous.rulePayload === rulePayload &&
    previous.start === start
  ) {
    return previous
  }

  return {
    id: connection.id,
    metadata,
    upload,
    download,
    start,
    chains,
    rule,
    rulePayload,
    curUpload,
    curDownload,
  }
}

const mergeConnectionSnapshot = (
  payload: IConnections,
  previous: ConnectionMonitorData = initConnData,
): ConnectionMonitorData => {
  const nextConnections = payload.connections ?? []
  const previousActive = previous.activeConnections ?? []
  const previousClosed = previous.closedConnections ?? []
  const previousActiveById = new Map<string, IConnectionsItem>()

  for (let i = 0; i < previousActive.length; i++) {
    const previousConnection = previousActive[i]
    previousActiveById.set(previousConnection.id, previousConnection)
  }

  recordDomainTrafficDeltas(nextConnections, previousActiveById)

  const activeConnections: IConnectionsItem[] = []
  for (let i = 0; i < nextConnections.length; i++) {
    const connection = nextConnections[i]
    const previousConnection = previousActiveById.get(connection.id)
    if (previousConnection) previousActiveById.delete(connection.id)
    activeConnections.push(normalizeConnection(connection, previousConnection))
  }

  if (previousActiveById.size === 0) {
    return {
      uploadTotal: payload.uploadTotal ?? 0,
      downloadTotal: payload.downloadTotal ?? 0,
      activeConnections,
      closedConnections: previousClosed,
    }
  }

  const removedConnectionCount = previousActiveById.size
  const dropFromClosed = Math.max(
    0,
    previousClosed.length + removedConnectionCount - MAX_CLOSED_CONNS_NUM,
  )
  const closedConnections =
    dropFromClosed >= previousClosed.length
      ? []
      : previousClosed.slice(dropFromClosed)

  const keepFromRemoved = MAX_CLOSED_CONNS_NUM - closedConnections.length
  let skipRemoved = Math.max(0, removedConnectionCount - keepFromRemoved)

  for (let i = 0; i < previousActive.length; i++) {
    const connection = previousActive[i]
    if (!previousActiveById.has(connection.id)) continue
    if (skipRemoved > 0) {
      skipRemoved -= 1
      continue
    }
    closedConnections.push(connection)
  }

  return {
    uploadTotal: payload.uploadTotal ?? 0,
    downloadTotal: payload.downloadTotal ?? 0,
    activeConnections,
    closedConnections,
  }
}

const mergeConnectionSummary = (
  payload: IConnections,
): ConnectionSummaryData => ({
  activeConnectionCount: payload.connections?.length ?? 0,
})

const flushPendingMessage = () => {
  flushTimer = null
  const messageData = pendingMessageData
  pendingMessageData = null
  if (!messageData || !hasConnectionSubscribers()) return

  let payload: IConnections
  try {
    payload = JSON.parse(messageData) as IConnections
  } catch (err) {
    console.error('[Connections] Failed to parse websocket payload', err)
    return
  }

  lastFlushAt = Date.now()
  connectionSummary = mergeConnectionSummary(payload)
  notifySummaryListeners()

  connectionData = mergeConnectionSnapshot(payload, connectionData)
  if (connectionListeners.size > 0) {
    notifyConnectionListeners()
  }
}

const enqueueConnectionMessage = (messageData: string) => {
  pendingMessageData = messageData
  if (flushTimer) return

  const elapsed = Date.now() - lastFlushAt
  if (elapsed >= CONNECTION_UPDATE_THROTTLE_MS) {
    flushPendingMessage()
    return
  }

  flushTimer = window.setTimeout(
    flushPendingMessage,
    CONNECTION_UPDATE_THROTTLE_MS - elapsed,
  )
}

const clearReconnectTimer = () => {
  if (!reconnectTimer) return
  window.clearTimeout(reconnectTimer)
  reconnectTimer = null
}

const closeConnectionSocket = async () => {
  const socket = connectionSocket
  connectionSocket = null
  if (!socket) return

  try {
    await socket.close()
  } catch (err) {
    console.warn('Failed to close connection websocket', err)
  }
}

const scheduleReconnect = () => {
  if (!hasConnectionSubscribers()) return
  if (reconnectTimer) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    void connectConnectionSocket()
  }, CONNECTION_RECONNECT_DELAY_MS)
}

async function reconnectConnectionSocket() {
  if (!hasConnectionSubscribers()) return
  await closeConnectionSocket()
  scheduleReconnect()
}

async function connectConnectionSocket() {
  if (connectionSocket || connectionConnecting) return
  if (!hasConnectionSubscribers()) return

  clearReconnectTimer()
  connectionConnecting = true

  try {
    const socket = await MihomoWebSocket.connect_connections()
    if (!hasConnectionSubscribers()) {
      await socket.close()
      return
    }
    connectionSocket = socket
    socket.addListener((message) => {
      if (connectionSocket !== socket) return
      if (message.type !== 'Text') return
      if (message.data.startsWith('Websocket error')) {
        void reconnectConnectionSocket()
        return
      }

      enqueueConnectionMessage(message.data)
    })
  } catch {
    scheduleReconnect()
  } finally {
    connectionConnecting = false
  }
}

const startConnectionMonitor = () => {
  void connectConnectionSocket()
}

const stopConnectionMonitorIfIdle = () => {
  if (hasConnectionSubscribers()) return

  clearReconnectTimer()
  pendingMessageData = null
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  void closeConnectionSocket()
}

const getConnectionSnapshot = () => connectionData
const getConnectionSummarySnapshot = () => connectionSummary

const subscribeConnectionData = (listener: ConnectionListener) => {
  connectionListeners.add(listener)
  startConnectionMonitor()
  return () => {
    connectionListeners.delete(listener)
    stopConnectionMonitorIfIdle()
  }
}

const subscribeConnectionSummary = (listener: ConnectionListener) => {
  summaryListeners.add(listener)
  startConnectionMonitor()
  return () => {
    summaryListeners.delete(listener)
    stopConnectionMonitorIfIdle()
  }
}

const refreshConnectionData = () => {
  pendingMessageData = null
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  void reconnectConnectionSocket()
}

const clearClosedConnectionData = () => {
  if (connectionData.closedConnections.length === 0) return
  connectionData = {
    ...connectionData,
    closedConnections: [],
  }
  notifyConnectionListeners()
}

export const useConnectionData = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true
  const subscribe = useCallback(
    (listener: ConnectionListener) =>
      enabled ? subscribeConnectionData(listener) : () => {},
    [enabled],
  )
  const data = useSyncExternalStore(
    subscribe,
    getConnectionSnapshot,
    getConnectionSnapshot,
  )
  const response = useMemo(() => ({ data }), [data])
  const refreshGetClashConnection = useCallback(() => {
    refreshConnectionData()
  }, [])
  const clearClosedConnections = useCallback(() => {
    clearClosedConnectionData()
  }, [])

  return {
    response,
    refreshGetClashConnection,
    clearClosedConnections,
  }
}

export const useConnectionSummaryData = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true
  const subscribe = useCallback(
    (listener: ConnectionListener) =>
      enabled ? subscribeConnectionSummary(listener) : () => {},
    [enabled],
  )
  const data = useSyncExternalStore(
    subscribe,
    getConnectionSummarySnapshot,
    getConnectionSummarySnapshot,
  )
  const response = useMemo(() => ({ data }), [data])
  const refreshGetClashConnectionSummary = useCallback(() => {
    refreshConnectionData()
  }, [])

  return {
    response,
    refreshGetClashConnectionSummary,
  }
}

const getDomainTrafficSnapshot = () => domainTrafficSnapshot

const subscribeDomainTraffic = (listener: ConnectionListener) => {
  domainTrafficListeners.add(listener)
  rebuildDomainTrafficSnapshot(Date.now())
  startConnectionMonitor()
  return () => {
    domainTrafficListeners.delete(listener)
    stopConnectionMonitorIfIdle()
  }
}

export const useDomainTrafficUsage24h = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true
  const subscribe = useCallback(
    (listener: ConnectionListener) =>
      enabled ? subscribeDomainTraffic(listener) : () => {},
    [enabled],
  )
  const data = useSyncExternalStore(
    subscribe,
    getDomainTrafficSnapshot,
    getDomainTrafficSnapshot,
  )

  return { data }
}
