---
name: clash-verge-upgrade
description: 检查、合并、编译并升级本地定制版 Clash Verge Rev（保留 GUI 分流设计与自定义 macOS 图标）。当用户询问 Clash 官方是否升级、要求更新或编译 Clash Verge 客户端时使用。
---

# Clash Verge Rev 定制版升级工作流

本机使用的 **Clash Verge Rev** 是基于官方仓库深度定制的本地构建版本（非纯官方二进制直接覆盖），包含两项必须保留的核心私有特性：
1. **GUI 分流设计 (`SplitRoutingDialog`)**：支持在代理页面可视化配置主订阅与从属订阅（如 YToo / EqualVPN）的按域名分流。
2. **macOS 自定义图标 (`icon-custom.icns`)**：使用自定义 App 图标而非官方默认图标与 `Assets.car`。

---

## 目录与仓库结构

- **编译工作区（主用）**：`/Users/rouen/Documents/coding/clash-verge-rev-latest-build`（分支：`dev`）
- **主仓库目录**：`/Users/rouen/Documents/coding/clash-verge-rev`
- **Git 远端**：
  - `origin`：`git@github.com:Rouen007/clash-verge-rev.git`（个人定制仓库）
  - `upstream`：`git@github.com:clash-verge-rev/clash-verge-rev.git`（官方上游仓库）
- **本地安装路径**：`/Applications/Clash Verge.app`
- **关联分流技能**：`~/.codex/skills/tradingview-ytoo-routing/SKILL.md`（升级后用于校验 TradingView / IBKR 分流）

---

## 标准升级流程

### 第一步：检查本地与官方最新版本

运行自带检查脚本：
```bash
bash ~/.agents/skills/clash-verge-upgrade/scripts/check_clash_update.sh
```
该脚本会输出：
- 当前 `/Applications/Clash Verge.app` 已安装版本；
- 本地源码库 `package.json` 版本与当前 commit；
- GitHub 官方最新 Release tag 与发布时间。

如果官方已有新正式版 Tag（例如 `v2.5.7`），继续执行合并与构建。默认优先合并**官方正式版 Release Tag**（而非尚未发版的不稳定 `upstream/dev` HEAD），除非用户明确要求追最新 `dev` 提交。

---

### 第二步：拉取并合并上游版本

在 `/Users/rouen/Documents/coding/clash-verge-rev-latest-build` 中操作：

```bash
cd /Users/rouen/Documents/coding/clash-verge-rev-latest-build
git fetch upstream dev --tags
git merge --no-commit --no-ff <TARGET_TAG>
```

#### 必须核验的定制项（Invariants）
在提交 merge 前，必须确认以下定制内容未被上游覆盖：
1. **自定义图标配置 (`src-tauri/tauri.conf.json`)**：
   - `bundle.icon` 数组中必须保留 `"icons/icon-custom.icns"`，且**不能**包含 `"icons/icon.icns"` 或 `"icons/Assets.car"`（否则 macOS Tahoe / Sequoia 会优先读取 `Assets.car` 导致自定义图标失效）。
   - 确认 `src-tauri/icons/icon-custom.icns` 文件存在。
2. **GUI 分流设计组件**：
   - `src/components/proxy/split-routing-dialog.tsx` 存在；
   - `src/pages/proxies.tsx` 中仍引用并渲染 `<SplitRoutingDialog />`；
   - `src/services/cmds.ts` 中包含 `saveSplitRoutingConfig`；
   - `src-tauri/src/cmd/save_profile.rs` 与 `src-tauri/src/lib.rs` 中注册了 `save_split_routing_config` 命令。
3. **DNS 覆写默认开启**：
   - `src-tauri/src/config/verge.rs` 中 `enable_dns_settings: Some(true)`；
   - `src-tauri/src/config/dns.rs` 中 `self.enable_dns_settings.unwrap_or(true)`；
   - `src-tauri/src/enhance/mod.rs` 与 `src-tauri/src/feat/dns.rs` 中开启 `enable_dns_settings` 时自动确认 `dns_source`，防止订阅自带 DNS 更新时被自动关闭覆写；
   - `src/components/setting/setting-clash.tsx` 与 `src/components/setting/mods/dns-viewer.tsx` 默认回退 `true`。

确认无误后提交合并：
```bash
git commit --no-verify -m "Merge upstream <TARGET_TAG> and preserve split routing and custom icon"
```

---

### 第三步：环境自检与 Prebuild（已知坑位修复）

#### 坑位 1：上游升级 `packageManager` 导致 `pnpm ENOEXEC`
当上游 `package.json` 更新 `"packageManager": "pnpm@X.Y.Z"` 时，本机 pnpm 自动下载新版本到 `/Users/rouen/Library/pnpm/.tools/pnpm/X.Y.Z/` 后可能因未执行 `install.js` 报 `spawnSync .../bin/pnpm ENOEXEC`。
- **修复命令**：
  ```bash
  PNPM_VER=$(node -p "require('./package.json').packageManager.split('@')[1]")
  if [ -f "/Users/rouen/Library/pnpm/.tools/pnpm/${PNPM_VER}/node_modules/pnpm/install.js" ]; then
    node "/Users/rouen/Library/pnpm/.tools/pnpm/${PNPM_VER}/node_modules/pnpm/install.js"
  fi
  pnpm --version
  ```

#### 坑位 2：Cargo 拉取 Git 依赖 SSH 认证失败
本机 `.gitconfig` 配置了 `url."git@github.com:".insteadOf "https://github.com/"`，Cargo 内置 libgit2 拉取 `clash-verge-service-ipc` 时会报错。
- **修复方案**：确保 `.cargo/config.toml` 顶部包含：
  ```toml
  [net]
  git-fetch-with-cli = true
  ```
  并在构建时传入 `CARGO_NET_GIT_FETCH_WITH_CLI=true`。

#### 执行 Prebuild
更新服务端二进制（如 `clash-verge-service`）及资源文件：
```bash
pnpm run prebuild
```

---

### 第四步：编译 macOS 应用包

仅构建 `.app` Bundle（跳过 `.dmg` 镜像与在线更新签名包以节省时间并避免报错）：
```bash
CARGO_NET_GIT_FETCH_WITH_CLI=true NODE_OPTIONS='--max-old-space-size=4096' pnpm tauri build --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'
```

构建产物位于：
`/Users/rouen/Documents/coding/clash-verge-rev-latest-build/target/release/bundle/macos/Clash Verge.app`

验证构建产物版本号与自定义图标：
```bash
defaults read "/Users/rouen/Documents/coding/clash-verge-rev-latest-build/target/release/bundle/macos/Clash Verge.app/Contents/Info.plist" CFBundleShortVersionString
ls -la "/Users/rouen/Documents/coding/clash-verge-rev-latest-build/target/release/bundle/macos/Clash Verge.app/Contents/Resources/icon-custom.icns"
```

---

### 第五步：平滑替换安装与验证

1. **替换 `/Applications/Clash Verge.app`**：
   ```bash
   rsync -a --delete "/Users/rouen/Documents/coding/clash-verge-rev-latest-build/target/release/bundle/macos/Clash Verge.app/" "/Applications/Clash Verge.app/"
   ```
2. **重启应用与校验分流**：
   - 如用户同意重启客户端，可平滑重启 Clash Verge；
   - 若升级包含了 `clash-verge-service-ipc` 大版本变更且出现 Service IPC 连接报错，提醒或协助用户执行：
     ```bash
     sudo "/Applications/Clash Verge.app/Contents/Resources/resources/clash-verge-service-install"
     ```
   - 运行 `~/.codex/skills/tradingview-ytoo-routing/scripts/verify_tv_route.sh` 确认代理端口（`127.0.0.1:7897`）及 TradingView 分流正常工作。
3. **Git 推送原则**：
   - 默认只保留在本地 Git 分支，除非用户明确指示推送到 GitHub（`git push origin dev`）。
