#!/usr/bin/env bash
# One-time Pi provisioning for Ripple Prod (review before run).
# Intended host: Raspberry Pi OS aarch64. Run as a sudo-capable admin (e.g. odeusys).
set -euo pipefail

APP_USER="github-runner"
APP_DIR="/home/${APP_USER}/apps/ripple"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as a normal sudo user, not root." >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "Missing user ${APP_USER}" >&2
  exit 1
fi

echo "==> Packages (ffmpeg)"
sudo apt-get update
sudo apt-get install -y ffmpeg curl ca-certificates gnupg rsync

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v24\.'; then
  echo "==> Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Corepack / pnpm"
sudo corepack enable
sudo -u "${APP_USER}" -H bash -lc 'corepack prepare pnpm@10.14.0 --activate'

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "==> yt-dlp (official binary to /usr/local/bin)"
  arch="$(uname -m)"
  case "${arch}" in
    aarch64|arm64) ytdlp_asset="yt-dlp_linux_aarch64" ;;
    *) ytdlp_asset="yt-dlp" ;;
  esac
  tmp="$(mktemp)"
  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlp_asset}" -o "${tmp}"
  sudo install -m 755 "${tmp}" /usr/local/bin/yt-dlp
  rm -f "${tmp}"
fi

echo "==> App directory"
sudo mkdir -p "${APP_DIR}/data"
sudo chown -R "${APP_USER}:${APP_USER}" "/home/${APP_USER}/apps"

echo "==> ripplectl + sudoers"
sudo install -m 755 "${REPO_ROOT}/deploy/ripplectl" /usr/local/sbin/ripplectl
sudo install -m 440 "${REPO_ROOT}/deploy/ripple-runner.sudoers" /etc/sudoers.d/ripple-runner
sudo visudo -cf /etc/sudoers.d/ripple-runner

NODE_BIN="$(command -v node)"
echo "==> systemd unit (ExecStart node=${NODE_BIN})"
tmp_unit="$(mktemp)"
sed "s|^ExecStart=/usr/bin/node|ExecStart=${NODE_BIN}|" "${REPO_ROOT}/deploy/ripple.service" > "${tmp_unit}"
sudo install -m 644 "${tmp_unit}" /etc/systemd/system/ripple.service
rm -f "${tmp_unit}"
sudo systemctl daemon-reload
sudo systemctl enable ripple.service

echo "==> Verify sudo -n ripplectl (service may be inactive until first deploy)"
sudo -u "${APP_USER}" -H sudo -n /usr/local/sbin/ripplectl status || true
if sudo -u "${APP_USER}" -H sudo -n /usr/bin/systemctl reboot 2>/dev/null; then
  echo "ERROR: github-runner must NOT be able to reboot via sudo -n" >&2
  exit 1
fi

echo "==> Optional: remove leftover runner installer tarball if present"
if [[ -f /home/github-runner/actions-runner/actions-runner-linux-arm64-*.tar.gz ]]; then
  echo "Found runner tarball(s) — delete manually after confirming runner works:"
  ls -lh /home/github-runner/actions-runner/actions-runner-linux-arm64-*.tar.gz || true
fi

echo "Provisioning complete. Create GitHub Environment Prod secrets, then cut a release tag."
