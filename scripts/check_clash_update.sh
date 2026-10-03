#!/bin/bash
set -euo pipefail

APP_PATH="/Applications/Clash Verge.app"
SRC_PATH="/Users/rouen/Documents/coding/clash-verge-rev-latest-build"
PROXY_URL="${CLASH_PROXY_URL:-http://127.0.0.1:7897}"

echo "=== Clash Verge Rev 升级检查 ==="

# 1. 检查已安装 App 版本
if [ -d "$APP_PATH" ]; then
  INSTALLED_VER=$(defaults read "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "未知")
  echo "当前安装版本: $INSTALLED_VER ($APP_PATH)"
else
  echo "当前安装版本: 未找到 $APP_PATH"
fi

# 2. 检查本地源码版本与 commit
if [ -d "$SRC_PATH" ]; then
  SRC_VER=$(node -p "require('$SRC_PATH/package.json').version" 2>/dev/null || echo "未知")
  SRC_COMMIT=$(git -C "$SRC_PATH" rev-parse --short HEAD 2>/dev/null || echo "未知")
  echo "本地源码版本: $SRC_VER (commit: $SRC_COMMIT)"
fi

# 3. 检查 GitHub 官方最新 Release
echo -n "正在查询 GitHub 官方最新版本... "
RELEASE_INFO=$(curl -s --max-time 6 -x "$PROXY_URL" "https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest" 2>/dev/null || curl -s --max-time 6 "https://api.github.com/repos/clash-verge-rev/clash-verge-rev/releases/latest" 2>/dev/null || echo "{}")

LATEST_TAG=$(echo "$RELEASE_INFO" | grep '"tag_name":' | head -n 1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || echo "")
PUBLISHED_AT=$(echo "$RELEASE_INFO" | grep '"published_at":' | head -n 1 | sed -E 's/.*"published_at": *"([^"]+)".*/\1/' || echo "")

if [ -n "$LATEST_TAG" ]; then
  echo "已获取"
  echo "官方最新 Release: $LATEST_TAG (发布时间: $PUBLISHED_AT)"
  if [ -n "${INSTALLED_VER:-}" ] && [ "v$INSTALLED_VER" = "$LATEST_TAG" ]; then
    echo "状态: 本地已安装最新版本。"
  else
    echo "状态: 发现新版本！可升级至 ${LATEST_TAG}。"
  fi
else
  echo "请求超时或网络不可达。"
fi
