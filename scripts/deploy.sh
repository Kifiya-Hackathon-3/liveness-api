#!/usr/bin/env bash
# Deploy liveness-check on a Linux server: git clone/pull, Go build, optional systemd.
#
# Default clone URL is the GitHub origin (Kifiya-Hackathon-3/liveness-api). Override GIT_URL for forks.
#
# Quick start (full deploy under /opt, systemd as user "liveness"):
#   sudo bash scripts/deploy.sh
#   # optional: BRANCH=develop sudo -E bash scripts/deploy.sh
#
# User directory (no systemd):
#   export INSTALL_DIR="$HOME/liveness-check"
#   bash scripts/deploy.sh --no-systemd
#
# TLS via systemd env file (create after first deploy):
#   sudo tee /etc/liveness-check/env <<'EOF'
#   PORT=5501
#   TLS_CERT_FILE=/etc/letsencrypt/live/your.domain/fullchain.pem
#   TLS_KEY_FILE=/etc/letsencrypt/live/your.domain/privkey.pem
#   EOF
#   sudo systemctl restart liveness-check
#
# Dry run:
#   bash scripts/deploy.sh --plan-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# sudo / deploy scripts often get a minimal PATH (no /usr/local/go/bin). Put common Go locations first.
__prepend_go_to_path() {
  local d candidates=()
  [[ -n "${GOROOT:-}" ]] && candidates+=("${GOROOT}/bin")
  candidates+=(
    /usr/local/go/bin
    /usr/local/bin
    /usr/bin
    /snap/bin
  )
  # Debian/Ubuntu golang-*-go packages sometimes ship here:
  local libgo
  for libgo in /usr/lib/go-*/bin; do
    [[ -d "$libgo" ]] && candidates+=("$libgo")
  done
  for d in "${candidates[@]}"; do
    [[ -x "$d/go" ]] || continue
    case ":$PATH:" in
      *":$d:"*) ;;
      *) export PATH="$d:$PATH" ;;
    esac
    return 0
  done
  return 0
}
__prepend_go_to_path

# --- canonical GitHub repo (this origin; go.mod module path may differ) ---
GIT_REPO_SLUG="Kifiya-Hackathon-3/liveness-api"
GIT_DEFAULT_URL="https://github.com/${GIT_REPO_SLUG}.git"
# SSH: GIT_URL='git@github.com:Kifiya-Hackathon-3/liveness-api.git' sudo -E bash scripts/deploy.sh

# --- configurable (environment overrides defaults) ---
GIT_URL="${GIT_URL:-$GIT_DEFAULT_URL}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/liveness-check}"
DEPLOY_USER="${DEPLOY_USER:-liveness}"
DEPLOY_GROUP="${DEPLOY_GROUP:-$DEPLOY_USER}"
SYSTEMD_UNIT_NAME="${SYSTEMD_UNIT_NAME:-liveness-check}"
ENV_FILE_SYSTEMD="${ENV_FILE_SYSTEMD:-/etc/liveness-check/env}"

PLAN_ONLY=0
NO_SYSTEMD=0

usage() {
  cat <<'USAGE'
Usage: [VAR=...] scripts/deploy.sh [options]

Options:
  --plan-only     Print the steps only; do not change the system.
  --no-systemd    Git sync + go build only (no systemd).
  -h, --help      Show this help.

Common environment:
  GIT_URL         Override clone URL (default: https://github.com/Kifiya-Hackathon-3/liveness-api.git).
  BRANCH          Branch to deploy (default: main).
  INSTALL_DIR     Target directory (default: /opt/liveness-check).
  DEPLOY_USER     Service account name (default: liveness).

Examples:
  sudo bash scripts/deploy.sh
  GIT_URL='git@github.com:Kifiya-Hackathon-3/liveness-api.git' sudo -E bash scripts/deploy.sh
  INSTALL_DIR=$HOME/app bash scripts/deploy.sh --no-systemd
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan-only) PLAN_ONLY=1 ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

fail() { echo "error: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
plan() { printf 'PLAN: %s\n' "$*"; }

check_go() {
  if ! command -v go >/dev/null; then
    __prepend_go_to_path
  fi
  if ! command -v go >/dev/null; then
    fail "go not found. Install Go 1.22+ from https://go.dev/dl/ (tarball -> /usr/local/go), or export GOROOT and PATH. If you use sudo and Go is already installed for your user, run: sudo env \"PATH=\${PATH}:/usr/local/go/bin\" bash scripts/deploy.sh"
  fi
  log "Using $(go version | awk '{print $1, $2, $3}') ($(command -v go))"
}

check_git() {
  command -v git >/dev/null || fail "git not in PATH"
}

# Git 2.35+ refuses root (or another user) in a repo owned by the service user after install_systemd chown.
_git_ensure_safe_directory() {
  local dir="$1"
  [[ -d "$dir/.git" ]] || return 0
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    plan "git config --global --add safe.directory \"\$(cd \"$dir\" && pwd)\"  # avoid dubious ownership"
    return 0
  fi
  local canon
  canon="$(cd "$dir" && pwd)"
  if git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$canon"; then
    return 0
  fi
  git config --global --add safe.directory "$canon"
  log "git: marked safe.directory $canon (runner vs repo owner differ)"
}

git_sync() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Git: update $INSTALL_DIR (branch $BRANCH)"
    _git_ensure_safe_directory "$INSTALL_DIR"
    if [[ "$PLAN_ONLY" -eq 1 ]]; then
      plan "cd \"$INSTALL_DIR\" && git fetch origin && git checkout \"$BRANCH\" && git reset --hard \"origin/$BRANCH\""
      return
    fi
    cd "$INSTALL_DIR"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
    return
  fi

  [[ -n "${GIT_URL:-}" ]] || fail "GIT_URL is empty and $INSTALL_DIR is not a git repo"

  log "Git: shallow clone $GIT_URL (origin, branch $BRANCH) -> $INSTALL_DIR"
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    plan "mkdir -p \"$(dirname "$INSTALL_DIR")\" && git clone --branch \"$BRANCH\" --depth 1 \"$GIT_URL\" \"$INSTALL_DIR\""
    return
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$GIT_URL" "$INSTALL_DIR"
  _git_ensure_safe_directory "$INSTALL_DIR"
}

build_binary() {
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    plan "cd \"$INSTALL_DIR\" && go build -trimpath -ldflags='-s -w' -o bin/liveness-check ."
    return
  fi
  cd "$INSTALL_DIR"
  [[ -f go.mod ]] && [[ -f main.go ]] || fail "missing go.mod/main.go in $INSTALL_DIR"
  mkdir -p bin
  go build -trimpath -ldflags='-s -w' -o bin/liveness-check .
  log "Built $INSTALL_DIR/bin/liveness-check"
}

write_env_reference() {
  local ex="$INSTALL_DIR/deploy.env.example"
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    plan "write $ex if missing"
    return
  fi
  if [[ -f "$ex" ]]; then
    return
  fi
  cat >"$ex" <<'EOF'
# Systemd: copy settings into /etc/liveness-check/env (see EnvironmentFile in unit)
# Behind nginx TLS: LISTEN_ADDR=127.0.0.1:5501 (see scripts/production-https.sh)
# PORT=5501
# LISTEN_ADDR=:5501
# TLS_CERT_FILE=/etc/letsencrypt/live/example.com/fullchain.pem
# TLS_KEY_FILE=/etc/letsencrypt/live/example.com/privkey.pem
# API_BASE=https://api.example.com
# SUBJECT_ID=sub_demo
# API_TOKEN=
EOF
  log "Wrote $INSTALL_DIR/deploy.env.example"
}

install_systemd() {
  [[ "$NO_SYSTEMD" -eq 0 ]] || return 0

  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    plan "create user $DEPLOY_USER if missing; chown -R $DEPLOY_USER:$DEPLOY_GROUP \"$INSTALL_DIR\""
    plan "create $ENV_FILE_SYSTEMD if missing; write /etc/systemd/system/${SYSTEMD_UNIT_NAME}.service"
    plan "systemctl daemon-reload && systemctl enable --now $SYSTEMD_UNIT_NAME"
    return
  fi

  [[ "$(id -u)" -eq 0 ]] || fail "systemd setup needs root — run with sudo, or pass --no-systemd"

  if ! id "$DEPLOY_USER" &>/dev/null; then
    if useradd --help 2>&1 | grep -q home-dir; then
      useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin --no-create-home "$DEPLOY_USER"
    else
      useradd --system -d "$INSTALL_DIR" -s /usr/sbin/nologin -M "$DEPLOY_USER"
    fi
    log "Created system user $DEPLOY_USER"
  fi

  mkdir -p "$(dirname "$ENV_FILE_SYSTEMD")"
  if [[ ! -f "$ENV_FILE_SYSTEMD" ]]; then
    umask 077
    touch "$ENV_FILE_SYSTEMD"
    chmod 640 "$ENV_FILE_SYSTEMD"
    chown root:"$DEPLOY_GROUP" "$ENV_FILE_SYSTEMD" 2>/dev/null || chown root:root "$ENV_FILE_SYSTEMD"
    umask 022
    log "Created empty $ENV_FILE_SYSTEMD (add PORT, TLS_*, etc.)"
  fi

  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"

  local unit="/etc/systemd/system/${SYSTEMD_UNIT_NAME}.service"
  cat >"$unit" <<EOF
[Unit]
Description=Liveness Check UI (Go)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-$ENV_FILE_SYSTEMD
ExecStart=$INSTALL_DIR/bin/liveness-check
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  log "Installed systemd unit $unit"
  systemctl daemon-reload
  systemctl enable "$SYSTEMD_UNIT_NAME"
  systemctl restart "$SYSTEMD_UNIT_NAME"
  systemctl --no-pager --full status "$SYSTEMD_UNIT_NAME" || true
  log "Follow logs: journalctl -u $SYSTEMD_UNIT_NAME -f"
}

# --- main ---
if [[ "$PLAN_ONLY" -eq 1 ]]; then
  log "=== Deployment plan (dry run) ==="
else
  log "=== liveness-check deploy ==="
fi

check_git
check_go

if [[ "$PLAN_ONLY" -eq 0 && "$(id -u)" -eq 0 ]]; then
  mkdir -p "$INSTALL_DIR"
fi

git_sync
build_binary
write_env_reference
install_systemd

if [[ "$PLAN_ONLY" -eq 0 && "$NO_SYSTEMD" -eq 1 ]]; then
  log "Run manually:"
  log "  cd $INSTALL_DIR && ./bin/liveness-check"
fi

log "=== finished ==="
