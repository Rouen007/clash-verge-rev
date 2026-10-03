# 定制版升级与构建策略 (Custom Fork Upgrade Strategy)

本仓库（`Rouen007/clash-verge-rev`）基于上游官方仓库 [`clash-verge-rev/clash-verge-rev`](https://github.com/clash-verge-rev/clash-verge-rev) 维护，包含两项核心定制功能。当官方发布新版本时，不能直接使用官方预编译二进制覆盖，需按本指南拉取上游 Release Tag、核验定制项并重新编译安装。

---

## 一、 必须保留的核心定制项 (Invariants)

每次合并上游版本后，提交前必须核验以下两项定制未被覆盖：

### 1. 主订阅 / 从属订阅 GUI 分流设计 (`SplitRoutingDialog`)
- **前端组件**：
  - `src/components/proxy/split-routing-dialog.tsx`
  - `src/pages/proxies.tsx`（顶部工具栏「分流设计」按钮及 `<SplitRoutingDialog />` 挂载）
  - `src/services/cmds.ts`（`saveSplitRoutingConfig` IPC 调用封装）
  - `src/locales/*/proxies.json`、`src/types/generated/i18n-keys.ts`、`src/types/generated/i18n-resources.ts`
- **后端命令**：
  - `src-tauri/src/cmd/save_profile.rs`（`save_split_routing_config` 实现与校验）
  - `src-tauri/src/lib.rs`（Tauri handler 注册）
- **配置模板**：
  - `template/split-routing/`（`README.md`, `merge.yaml`, `groups.yaml`, `rules.yaml`）

### 2. macOS 自定义应用图标 (`icon-custom.icns`)
- **图标文件**：`src-tauri/icons/icon-custom.icns`
- **打包配置**（`src-tauri/tauri.conf.json`）：
  `bundle.icon` 必须保留 `"icons/icon-custom.icns"`，且**不得**包含 `"icons/icon.icns"` 与 `"icons/Assets.car"`（避免 macOS 优先加载官方默认 `Assets.car` 导致自定义图标失效）：
  ```json
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon-custom.icns",
    "icons/icon.ico"
  ]
  ```

### 3. DNS 覆写默认开启 (Default DNS Override Enabled)
- **后端默认配置与自动确认**：
  - `src-tauri/src/config/verge.rs`：`IVerge::template()` 中 `enable_dns_settings: Some(true)`
  - `src-tauri/src/config/dns.rs`：`dns_settings_for` 中未保存配置的订阅默认 `self.enable_dns_settings.unwrap_or(true)`
  - `src-tauri/src/enhance/mod.rs`：当 `enable_dns_settings` 开启时，自动信任当前订阅的 `dns_source`（免除机场更新 DNS 时自动关闭 DNS 覆写）
  - `src-tauri/src/feat/dns.rs`：手动开启 DNS 覆写时自动写入 `confirmation`
- **前端回退默认值**：
  - `src/components/setting/setting-clash.tsx` 与 `src/components/setting/mods/dns-viewer.tsx` 中 `verge?.enable_dns_settings ?? true`

---

## 二、 标准升级步骤

### 1. 检查版本状态
运行仓库内置的检查脚本，对比当前已安装版本、本地源码版本与 GitHub 官方最新 Release：
```bash
bash ./scripts/check_clash_update.sh
```

### 2. 拉取并合并上游正式版 Tag
优先合并官方发布的最新正式版 Tag（例如 `v2.5.7`），而非尚未发版的 `upstream/dev` HEAD：
```bash
git fetch upstream dev --tags
git merge --no-commit --no-ff <TARGET_TAG>
```

核验定制项是否完整保留：
```bash
grep -n "icon-custom.icns" src-tauri/tauri.conf.json
grep -n "SplitRoutingDialog" src/pages/proxies.tsx
grep -n "save_split_routing_config" src-tauri/src/lib.rs
```

确认无误后提交合并：
```bash
git commit --no-verify -m "Merge upstream <TARGET_TAG> and preserve split routing and custom icon"
```

### 3. 处理环境依赖与 Prebuild（已知坑位）

#### 坑位 A：上游更新 `packageManager` 导致 `pnpm ENOEXEC`
当上游 `package.json` 升级 `"packageManager": "pnpm@X.Y.Z"` 时，本机 pnpm 自动下载新版本至 `~/Library/pnpm/.tools/pnpm/X.Y.Z/` 后若未执行 `install.js`，会报 `spawnSync .../bin/pnpm ENOEXEC`。
```bash
PNPM_VER=$(node -p "require('./package.json').packageManager.split('@')[1]")
if [ -f "$HOME/Library/pnpm/.tools/pnpm/${PNPM_VER}/node_modules/pnpm/install.js" ]; then
  node "$HOME/Library/pnpm/.tools/pnpm/${PNPM_VER}/node_modules/pnpm/install.js"
fi
pnpm --version
```

#### 坑位 B：Cargo 拉取 Git 依赖 SSH 认证失败
若本机 `.gitconfig` 配置了 `url."git@github.com:".insteadOf "https://github.com/"`，Cargo 内置的 libgit2 拉取 `clash-verge-service-ipc` 等 Git 依赖时会认证失败。
- 确保 `.cargo/config.toml` 包含：
  ```toml
  [net]
  git-fetch-with-cli = true
  ```

#### 执行 Prebuild
拉取配套版本的 `clash-verge-service` 二进制与 GeoIP/GeoSite 资源：
```bash
pnpm run prebuild
```

### 4. 编译 macOS `.app` Bundle
仅打包 `.app`（跳过 `.dmg` 镜像与在线更新签名包）：
```bash
CARGO_NET_GIT_FETCH_WITH_CLI=true NODE_OPTIONS='--max-old-space-size=4096' pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'
```

构建产物路径：
`target/release/bundle/macos/Clash Verge.app`

### 5. 安装与验证
1. 同步替换到 `/Applications/Clash Verge.app`：
   ```bash
   rsync -a --delete "target/release/bundle/macos/Clash Verge.app/" "/Applications/Clash Verge.app/"
   ```
2. 校验已安装版本号与自定义图标：
   ```bash
   defaults read "/Applications/Clash Verge.app/Contents/Info.plist" CFBundleShortVersionString
   ls -la "/Applications/Clash Verge.app/Contents/Resources/icon-custom.icns"
   ```
3. 若升级后 Service IPC 版本跨越较大且提示服务需更新，可执行：
   ```bash
   sudo "/Applications/Clash Verge.app/Contents/Resources/resources/clash-verge-service-install"
   ```
4. 推送更新后的代码至个人 GitHub 仓库：
   ```bash
   git push origin dev
   ```
