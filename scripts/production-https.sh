#!/usr/bin/env bash
# Fetch https://github.com/Kifiya-Hackathon-3/liveness-api, deploy the Go app, terminate TLS with nginx + Let's Encrypt.
#
# Prerequisites (on the remote VPS):
#   - Debian/Ubuntu, root or sudo
#   - DNS: A (and AAAA if you use IPv6) for DOMAIN → this machine's public IP
#   - Firewall: allow TCP 80, 443 (and 22 for SSH). Do NOT expose 5501 publicly when using this script.
#
# Usage:
#   export DOMAIN=liveness.example.com
#   export CERTBOT_EMAIL=admin@example.com          # optional; else LE registers without email
#   sudo bash scripts/production-https.sh
#
# Re-run after DNS change or to update app: same command (idempotent).
#
# Optional environment:
#   INSTALL_DIR=/opt/liveness-check   BRANCH=main   GIT_URL=https://github.com/Kifiya-Hackathon-3/liveness-api.git
#   SKIP_APT=1                        skip apt-get install (packages already present)
#   DISABLE_NGINX_DEFAULT=1           remove sites-enabled/default (default: 1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/liveness-check}"
BRANCH="${BRANCH:-main}"
GIT_URL="${GIT_URL:-https://github.com/Kifiya-Hackathon-3/liveness-api.git}"
DISABLE_NGINX_DEFAULT="${DISABLE_NGINX_DEFAULT:-1}"
ENV_FILE="${ENV_FILE:-/etc/liveness-check/env}"
NGINX_SITE="${NGINX_SITE:-liveness-check}"

fail() { echo "error: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || fail "run as root: sudo bash $0"
[[ -n "$DOMAIN" ]] || fail "set DOMAIN, e.g. export DOMAIN=liveness.example.com"

if [[ "${SKIP_APT:-0}" != "1" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y nginx certbot python3-certbot-nginx git curl ca-certificates
fi

command -v nginx >/dev/null || fail "nginx not installed"
command -v certbot >/dev/null || fail "certbot not installed"

# go.mod requires Go 1.22+; stock apt is often older — install official toolchain to /usr/local/go if needed.
export PATH="/usr/local/go/bin:${PATH}"
if ! command -v go >/dev/null 2>&1 || ! go version | grep -qE 'go1\.(2[2-9]|[3-9][0-9])'; then
  _arch="$(uname -m)"
  case "$_arch" in
    x86_64) _goarch=amd64 ;;
    aarch64|arm64) _goarch=arm64 ;;
    *) fail "unsupported machine $_arch — install Go 1.22+ and re-run, or export GO_TARBALL URL for linux-${_arch}" ;;
  esac
  GO_TARBALL="${GO_TARBALL:-https://go.dev/dl/go1.22.12.linux-${_goarch}.tar.gz}"
  log "Installing Go from $GO_TARBALL -> /usr/local/go"
  rm -rf /usr/local/go
  curl -fsSL "$GO_TARBALL" | tar -C /usr/local -xzf -
fi
command -v go >/dev/null || fail "go missing after install"
go version

# Build + systemd (deploy.sh: git clone/pull, build, systemd unit)
export GIT_URL BRANCH INSTALL_DIR
log "=== app deploy (git + build + systemd) ==="
bash "$SCRIPT_DIR/deploy.sh"

# Bind the Go server to loopback only; TLS is on nginx.
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
ensure_kv() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}
ensure_kv PORT 5501
ensure_kv LISTEN_ADDR 127.0.0.1:5501
chmod 640 "$ENV_FILE" || true
systemctl restart liveness-check
log "App listens on 127.0.0.1:5501 (see $ENV_FILE)"

log "=== nginx site ==="
NGINX_AVAIL="/etc/nginx/sites-available/$NGINX_SITE"
NGINX_EN="/etc/nginx/sites-enabled/$NGINX_SITE"
sed "s/__DOMAIN__/${DOMAIN}/g" "$SCRIPT_DIR/nginx-liveness.conf.template" >"$NGINX_AVAIL"
ln -sf "$NGINX_AVAIL" "$NGINX_EN"

if [[ "$DISABLE_NGINX_DEFAULT" == "1" ]] && [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  log "Removed default nginx site (DISABLE_NGINX_DEFAULT=1)"
fi

nginx -t
systemctl reload nginx

log "=== Let's Encrypt (certbot nginx plugin) ==="
CERT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
if [[ -n "$CERTBOT_EMAIL" ]]; then
  CERT_ARGS+=(--email "$CERTBOT_EMAIL")
else
  CERT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERT_ARGS[@]}"

systemctl reload nginx
log "=== done ==="
log "Open: https://${DOMAIN}/"
log "Set API and tokens in $ENV_FILE (API_BASE, API_TOKEN, ...) then: systemctl restart liveness-check"
