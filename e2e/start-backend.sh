#!/usr/bin/env bash
# Starts the mock Proxmox and the built backend (serving dist/) for the browser tests, and creates a test user.
# Needs: npm run build (root) and cd server && npm run build.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="${E2E_WORK:-$(mktemp -d)}"
export PORT="${PORT:-3911}" HOST=127.0.0.1 TRUST_PROXY=false COOKIE_SECURE=false
export SERVE_DIST="$PWD/dist" DB_PATH="$WORK/e2e.db" BACKUP_DIR="$WORK/backups"
export PVE_URL=http://127.0.0.1:8911 PVE_NODE=pve PVE_TOKEN_ID=t@pve!t PVE_TOKEN_SECRET=x
export SECRETS_KEY=0123456789abcdef0123456789abcdef0123456789abcdef
node e2e/mock-pve.mjs > "$WORK/mock.log" 2>&1 &
NEW_PASSWORD="${E2E_PASS:?set E2E_PASS (at least 12 characters)}" node --disable-warning=ExperimentalWarning server/build/create-user.js "${E2E_USER:-admin}" admin --no-2fa
exec node --disable-warning=ExperimentalWarning server/build/index.js
