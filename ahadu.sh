#!/usr/bin/env bash
# Wrapper: keep Go (and your login PATH) when elevating — many installs live in /usr/local/go/bin.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for d in /usr/local/go/bin /snap/bin; do
  if [[ -x "$d/go" ]]; then
    case ":${PATH:-}:" in *":$d:"*) ;; *) export PATH="$d:$PATH" ;; esac
  fi
done
if [[ "$(id -u)" -eq 0 ]]; then
  exec bash "$ROOT/scripts/deploy.sh" "$@"
fi
exec sudo env "PATH=$PATH" bash "$ROOT/scripts/deploy.sh" "$@"
