#!/usr/bin/env bash
# Deploy liveness-api behind nginx with TLS.
#
# Two modes:
#   A) Let's Encrypt — needs a hostname (DOMAIN) and DNS pointing here.
#   B) Public IP only — USE_IP=1, self-signed cert (browsers warn; OK for demos / internal).
#
# Prerequisites (VPS):
#   - Debian/Ubuntu, run as root
#   - Firewall: TCP 80 + 443 open (and 22 for SSH). Do not expose 5501 publicly.
#
# Domain + Let's Encrypt:
#   export DOMAIN=liveness.example.com
#   export CERTBOT_EMAIL=admin@example.com   # optional
#   sudo bash scripts/production-https.sh
#
# Machine IP only (self-signed):
#   sudo USE_IP=1 bash scripts/production-https.sh
#   # or pin the listen address used in the cert:
#   sudo USE_IP=1 SERVER_IP=185.222.240.66 bash scripts/production-https.sh
#
# Optional: INSTALL_DIR BRANCH GIT_URL SKIP_APT DISABLE_NGINX_DEFAULT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
USE_IP="${USE_IP:-0}"
SERVER_IP="${SERVER_IP:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/liveness-check}"
BRANCH="${BRANCH:-main}"
GIT_URL="${GIT_URL:-https://github.com/Kifiya-Hackathon-3/liveness-api.git}"
DISABLE_NGINX_DEFAULT="${DISABLE_NGINX_DEFAULT:-1}"
ENV_FILE="${ENV_FILE:-/etc/liveness-check/env}"
NGINX_SITE="${NGINX_SITE:-liveness-check}"

fail() { echo "error: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || fail "run as root: sudo bash $0"

MODE=""
if [[ -n "$DOMAIN" ]]; then
  MODE=letsencrypt
elif [[ "$USE_IP" == "1" ]] || [[ -n "$SERVER_IP" ]]; then
  MODE=selfsigned_ip
else
  fail "Either set DOMAIN=my.host for Let's Encrypt, or USE_IP=1 for HTTPS on this server's IP (self-signed)."
fi

detect_server_ip() {
  if [[ -n "$SERVER_IP" ]]; then
    echo "$SERVER_IP"
    return
  fi
  local ip=""
  ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  [[ -n "$ip" ]] || fail "Could not detect public IPv4; set SERVER_IP=1.2.3.4 explicitly."
  echo "$ip"
}

write_selfsigned_cert() {
  local ip="$1"
  local ssl_dir="/etc/nginx/ssl/liveness-check"
  mkdir -p "$ssl_dir"
  log "Generating self-signed certificate (CN/SAN: $ip) in $ssl_dir"
  if openssl req -help 2>&1 | grep -q -- '-addext'; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$ssl_dir/privkey.pem" \
      -out "$ssl_dir/fullchain.pem" \
      -subj "/CN=${ip}" \
      -addext "subjectAltName=IP:${ip}"
  else
    local cnf
    cnf="$(mktemp)"
    cat >"$cnf" <<EOF
[req]
distinguished_name = req_dn
req_extensions = v3_req
prompt = no
[req_dn]
CN = ${ip}
[v3_req]
subjectAltName = IP:${ip}
EOF
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$ssl_dir/privkey.pem" \
      -out "$ssl_dir/fullchain.pem" \
      -config "$cnf" -extensions v3_req
    rm -f "$cnf"
  fi
  chmod 600 "$ssl_dir/privkey.pem"
  chmod 644 "$ssl_dir/fullchain.pem"
}

if [[ "${SKIP_APT:-0}" != "1" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  if [[ "$MODE" == "letsencrypt" ]]; then
    apt-get install -y nginx certbot python3-certbot-nginx git curl ca-certificates openssl
  else
    apt-get install -y nginx git curl ca-certificates openssl
  fi
fi

command -v nginx >/dev/null || fail "nginx not installed"
if [[ "$MODE" == "letsencrypt" ]]; then
  command -v certbot >/dev/null || fail "certbot not installed"
fi

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

export GIT_URL BRANCH INSTALL_DIR
log "=== app deploy (git + build + systemd) ==="
bash "$SCRIPT_DIR/deploy.sh"

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

NGINX_AVAIL="/etc/nginx/sites-available/$NGINX_SITE"
NGINX_EN="/etc/nginx/sites-enabled/$NGINX_SITE"

if [[ "$MODE" == "selfsigned_ip" ]]; then
  SERVER_IP="$(detect_server_ip)"
  log "=== TLS: self-signed for IP $SERVER_IP ==="
  write_selfsigned_cert "$SERVER_IP"
  cp -f "$SCRIPT_DIR/nginx-liveness-ip.conf" "$NGINX_AVAIL"
else
  log "=== nginx site (HTTP only — certbot adds HTTPS) ==="
  sed "s/__DOMAIN__/${DOMAIN}/g" "$SCRIPT_DIR/nginx-liveness.conf.template" >"$NGINX_AVAIL"
fi

ln -sf "$NGINX_AVAIL" "$NGINX_EN"

if [[ "$DISABLE_NGINX_DEFAULT" == "1" ]] && [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  log "Removed default nginx site (DISABLE_NGINX_DEFAULT=1)"
fi

nginx -t
systemctl reload nginx

if [[ "$MODE" == "letsencrypt" ]]; then
  log "=== Let's Encrypt (certbot) ==="
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
else
  log "=== done (self-signed) ==="
  log "Open: https://${SERVER_IP}/"
  log "Your browser will warn about the certificate — Advanced → proceed (or install this CA on clients)."
  log "For phones to trust the camera/API reliably, use a real domain + Let's Encrypt (DOMAIN=...) instead."
fi

log "Set API and tokens in $ENV_FILE (API_BASE, API_TOKEN, ...) then: systemctl restart liveness-check"
