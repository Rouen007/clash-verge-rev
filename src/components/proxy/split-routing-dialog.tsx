import {
  AddRounded,
  DeleteOutlineRounded,
  RouteRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import yaml from 'js-yaml'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseSplitChipEditor } from '@/components/base'
import { useProfiles } from '@/hooks/use-profiles'
import { readProfileFile, saveProfileFiles } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

const STORAGE_KEY = 'clash-verge-split-routing-v1'
const MANAGED_PREFIX = 'SplitRoute | '
const PROVIDER_PREFIX = `${MANAGED_PREFIX}Provider | `
const AUTO_SUFFIX = ' | Auto'

interface SplitRoute {
  id: string
  name: string
  profileUid: string
  domains: string
}

interface SplitRouteStore {
  [profileUid: string]: SplitRoute[]
}

interface Props {
  open: boolean
  onClose: () => void
}

const splitDomains = (value: string) =>
  value
    .split(/[\n,;\r]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const normalizeDomain = (value: string) => {
  let domain = value.trim().toLowerCase()
  domain = domain.replace(/^https?:\/\//, '')
  domain = domain.split('/')[0] ?? ''
  domain = domain.replace(/^\*\./, '').replace(/\.$/, '')
  return domain
}

const isValidDomain = (value: string) => {
  if (!value || value.includes(',') || value.includes(' ')) return false
  if (value.includes(':') || value.includes('/')) return false
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    value,
  )
}

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const loadStore = (): SplitRouteStore => {
  if (typeof localStorage === 'undefined') return {}
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as SplitRouteStore
  } catch {
    return {}
  }
}

const saveStore = (store: SplitRouteStore) => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // The generated Clash configuration is the source of truth. A full
    // browser storage quota must not turn a successful runtime update into a
    // misleading save failure.
  }
}

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const asSequence = (value: unknown): any[] =>
  Array.isArray(value) ? value : []

const routeNames = (route: SplitRoute) => {
  const base = `${MANAGED_PREFIX}${route.name.trim()}`
  return {
    provider: `${PROVIDER_PREFIX}${route.name.trim()}`,
    auto: `${base}${AUTO_SUFFIX}`,
    group: base,
  }
}

const providerConfig = (route: SplitRoute, profile?: IProfileItem) => {
  const names = routeNames(route)
  return {
    type: 'file',
    path: `./profiles/${profile?.file ?? ''}`,
    'health-check': {
      enable: true,
      url: 'https://www.gstatic.com/generate_204',
      interval: 300,
      timeout: 5000,
      lazy: true,
    },
    override: {
      'additional-prefix': `${names.provider} | `,
    },
  }
}

const buildGroups = (routes: SplitRoute[]) =>
  routes.flatMap((route) => {
    const names = routeNames(route)
    return [
      {
        name: names.group,
        type: 'select',
        proxies: [names.auto],
        use: [names.provider],
      },
      {
        name: names.auto,
        type: 'url-test',
        use: [names.provider],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 80,
        lazy: false,
      },
    ]
  })

const buildRules = (routes: SplitRoute[]) =>
  routes.flatMap((route) => {
    const target = routeNames(route).group
    return splitDomains(route.domains).map(
      (domain) => `DOMAIN-SUFFIX,${normalizeDomain(domain)},${target}`,
    )
  })

const removeManagedProviders = (value: unknown) =>
  Object.fromEntries(
    Object.entries(asRecord(value)).filter(
      ([name]) => !name.startsWith(MANAGED_PREFIX),
    ),
  )

const isManagedGroup = (item: unknown) =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as { name?: unknown }).name === 'string' &&
  (item as { name: string }).name.startsWith(MANAGED_PREFIX)

const isManagedRule = (item: unknown) =>
  typeof item === 'string' &&
  item.split(',').slice(2).join(',').startsWith(MANAGED_PREFIX)

const updateMergeFile = (
  source: string,
  routes: SplitRoute[],
  profiles: IProfileItem[],
) => {
  const document = asRecord(yaml.load(source))
  const currentProviders = removeManagedProviders(document['proxy-providers'])
  const nextProviders = Object.fromEntries(
    routes.map((route) => {
      const profile = profiles.find((item) => item.uid === route.profileUid)
      const config = providerConfig(route, profile)
      return [routeNames(route).provider, config]
    }),
  )

  const mergedProviders = { ...currentProviders, ...nextProviders }
  if (Object.keys(mergedProviders).length) {
    document['proxy-providers'] = mergedProviders
  } else {
    delete document['proxy-providers']
  }

  return yaml.dump(document, { noRefs: true, lineWidth: -1 })
}

const updateSequenceFile = (
  source: string,
  field: 'groups' | 'rules',
  routes: SplitRoute[],
) => {
  const document = asRecord(yaml.load(source))
  const prepend = asSequence(document.prepend).filter(
    (item) =>
      !(field === 'groups' ? isManagedGroup(item) : isManagedRule(item)),
  )
  const append = asSequence(document.append).filter(
    (item) =>
      !(field === 'groups' ? isManagedGroup(item) : isManagedRule(item)),
  )
  const deleted = asSequence(document.delete).filter(
    (item) => typeof item !== 'string' || !item.startsWith(MANAGED_PREFIX),
  )

  document.prepend = [
    ...(field === 'groups' ? buildGroups(routes) : buildRules(routes)),
    ...prepend,
  ]
  document.append = append
  document.delete = deleted

  return yaml.dump(document, { noRefs: true, lineWidth: -1 })
}

const normalizeRoutes = (routes: SplitRoute[]) =>
  routes.map((route) => ({
    ...route,
    name: route.name.trim(),
    domains: splitDomains(route.domains)
      .map(normalizeDomain)
      .filter(Boolean)
      .join('\n'),
  }))

export const SplitRoutingDialog = ({ open, onClose }: Props) => {
  const { t } = useTranslation()
  const { profiles } = useProfiles()
  const [drafts, setDrafts] = useState<SplitRouteStore>({})
  const [loading, setLoading] = useState(false)
  const currentUid = profiles?.current

  const currentProfile = useMemo(
    () => profiles?.items?.find((item) => item.uid === profiles.current),
    [profiles],
  )
  const subordinateProfiles = useMemo(
    () =>
      (profiles?.items ?? []).filter(
        (item) =>
          item.uid !== profiles?.current &&
          !!item.file &&
          (item.type === 'remote' || item.type === 'local'),
      ),
    [profiles],
  )

  const storedRoutes = useMemo(
    () => (currentUid ? (loadStore()[currentUid] ?? []) : []),
    [currentUid],
  )
  const routes = currentUid ? (drafts[currentUid] ?? storedRoutes) : []

  const updateRoutes = useCallback(
    (updater: (current: SplitRoute[]) => SplitRoute[]) => {
      if (!currentUid) return
      setDrafts((current) => ({
        ...current,
        [currentUid]: updater(current[currentUid] ?? storedRoutes),
      }))
    },
    [currentUid, storedRoutes],
  )

  const addRoute = () => {
    const profile = subordinateProfiles[0]
    updateRoutes((current) => [
      ...current,
      {
        id: createId(),
        name: profile?.name ?? '',
        profileUid: profile?.uid ?? '',
        domains: '',
      },
    ])
  }

  const updateRoute = (id: string, patch: Partial<SplitRoute>) => {
    updateRoutes((current) =>
      current.map((route) =>
        route.id === id ? { ...route, ...patch } : route,
      ),
    )
  }

  const removeRoute = (id: string) => {
    updateRoutes((current) => current.filter((route) => route.id !== id))
  }

  const save = useLockFn(async () => {
    if (!currentUid || !currentProfile) return
    const normalized = normalizeRoutes(routes)
    const names = new Set<string>()
    const invalid = normalized.some((route) => {
      const domains = splitDomains(route.domains)
      const profile = subordinateProfiles.find(
        (item) => item.uid === route.profileUid,
      )
      const duplicateName = names.has(route.name.toLowerCase())
      names.add(route.name.toLowerCase())
      return (
        !route.name ||
        route.name.includes(',') ||
        route.name.includes('\n') ||
        duplicateName ||
        !route.profileUid ||
        !profile?.file ||
        !domains.length ||
        domains.some((domain) => !isValidDomain(domain))
      )
    })
    if (invalid) {
      showNotice.error(t('proxies.splitRouting.feedback.invalid'))
      return
    }

    const mergeUid = currentProfile.option?.merge
    const rulesUid = currentProfile.option?.rules
    const groupsUid = currentProfile.option?.groups
    if (!mergeUid || !rulesUid || !groupsUid) {
      showNotice.error(t('proxies.splitRouting.feedback.missingEnhancements'))
      return
    }

    setLoading(true)
    try {
      const [merge, rules, groups] = await Promise.all([
        readProfileFile(mergeUid),
        readProfileFile(rulesUid),
        readProfileFile(groupsUid),
      ])
      const nextMerge = updateMergeFile(merge, normalized, subordinateProfiles)
      const nextRules = updateSequenceFile(rules, 'rules', normalized)
      const nextGroups = updateSequenceFile(groups, 'groups', normalized)

      const outcome = await saveProfileFiles([
        { index: mergeUid, fileData: nextMerge },
        { index: rulesUid, fileData: nextRules },
        { index: groupsUid, fileData: nextGroups },
      ])
      if (outcome.status !== 'valid') {
        throw new Error('split routing enhancement validation failed')
      }

      const store = loadStore()
      store[currentUid] = normalized
      saveStore(store)
      setDrafts((current) => ({ ...current, [currentUid]: normalized }))
      showNotice.success(t('proxies.splitRouting.feedback.saved'))
      onClose()
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  })

  const hasEnhancements = Boolean(
    currentProfile?.option?.merge &&
      currentProfile.option.rules &&
      currentProfile.option.groups,
  )

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <RouteRounded color="primary" />
        {t('proxies.splitRouting.title')}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info">{t('proxies.splitRouting.description')}</Alert>

          {currentProfile && (
            <Typography variant="body2" color="text.secondary">
              {t('proxies.splitRouting.primaryProfile', {
                name: currentProfile.name || currentProfile.file,
              })}
            </Typography>
          )}

          {!currentProfile && (
            <Alert severity="warning">
              {t('proxies.splitRouting.feedback.noCurrentProfile')}
            </Alert>
          )}
          {currentProfile && !hasEnhancements && (
            <Alert severity="warning">
              {t('proxies.splitRouting.feedback.missingEnhancements')}
            </Alert>
          )}
          {!subordinateProfiles.length && (
            <Alert severity="warning">
              {t('proxies.splitRouting.feedback.noSubordinateProfiles')}
            </Alert>
          )}

          {routes.map((route) => {
            const profile = subordinateProfiles.find(
              (item) => item.uid === route.profileUid,
            )
            return (
              <Box
                key={route.id}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.5,
                }}
              >
                <Stack spacing={1.5}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TextField
                      size="small"
                      fullWidth
                      label={t('proxies.splitRouting.fields.routeName')}
                      value={route.name}
                      onChange={(event) =>
                        updateRoute(route.id, { name: event.target.value })
                      }
                    />
                    <IconButton
                      color="error"
                      aria-label={t('proxies.splitRouting.actions.delete')}
                      onClick={() => removeRoute(route.id)}
                    >
                      <DeleteOutlineRounded />
                    </IconButton>
                  </Box>
                  <FormControl size="small" fullWidth>
                    <InputLabel>
                      {t('proxies.splitRouting.fields.subscription')}
                    </InputLabel>
                    <Select
                      label={t('proxies.splitRouting.fields.subscription')}
                      value={route.profileUid}
                      onChange={(event) => {
                        const nextProfile = subordinateProfiles.find(
                          (item) => item.uid === event.target.value,
                        )
                        updateRoute(route.id, {
                          profileUid: event.target.value,
                          name: route.name || nextProfile?.name || '',
                        })
                      }}
                    >
                      {route.profileUid && !profile && (
                        <MenuItem value={route.profileUid}>
                          {t(
                            'proxies.splitRouting.feedback.missingSubscription',
                          )}
                        </MenuItem>
                      )}
                      {subordinateProfiles.map((item) => (
                        <MenuItem key={item.uid} value={item.uid}>
                          {item.name || item.file}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Box>
                    <Typography variant="body2" sx={{ mb: 0.5 }}>
                      {t('proxies.splitRouting.fields.domains')}
                    </Typography>
                    <BaseSplitChipEditor
                      value={route.domains}
                      onChange={(domains) => updateRoute(route.id, { domains })}
                      placeholder={t(
                        'proxies.splitRouting.fields.domainPlaceholder',
                      )}
                      helperText={t('proxies.splitRouting.fields.domainHint')}
                      defaultMode="advanced"
                      showModeToggle={false}
                      ariaLabel={t('proxies.splitRouting.fields.domains')}
                    />
                  </Box>
                  {profile && (
                    <Typography variant="caption" color="text.secondary">
                      {t('proxies.splitRouting.fields.file', {
                        file: profile.file,
                      })}
                    </Typography>
                  )}
                </Stack>
              </Box>
            )
          })}

          <Button
            variant="outlined"
            startIcon={<AddRounded />}
            onClick={addRoute}
            disabled={!subordinateProfiles.length || loading}
          >
            {t('proxies.splitRouting.actions.add')}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t('proxies.splitRouting.persistenceHint')}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          {t('shared.actions.cancel')}
        </Button>
        <Button variant="contained" onClick={save} loading={loading}>
          {t('shared.actions.save')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
