#!/usr/bin/env bash
# Run on the Proxmox host. Creates a dedicated user and a PRIVILEGE-SEPARATED API token for homedash and prints the
# values for the installer (var_homedash_pve_token_id / var_homedash_pve_token_secret).
#
#   bash create-token.sh [--yes] [--write-access] [--path /pool/mypool] [user@realm] [tokenname]
#
# Least privilege: the token (not just the user) gets the ACL, so it can never exceed what is listed here.
#   default        PVEAuditor (read everything)
#   --write-access adds PVEVMUser (start/stop/reboot/snapshot) for guests homedash should control
#   --path         limits both to one path (e.g. /pool/lab or /vms/100) instead of the whole datacenter ("/")
# Idempotent: an existing user/ACL is left alone, and an existing token is NEVER recreated or rotated; delete it
# yourself (pveum user token remove) if you need a fresh secret. Nothing changes until you confirm.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

ACL_PATH="/"
ROLES=(PVEAuditor)
POS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --write-access) ROLES+=(PVEVMUser) ;;
    --path) ACL_PATH="${2:?--path needs a value}"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) POS+=("$1") ;;
  esac
  shift
done
USER_ID="${POS[0]:-homedash@pve}"
TOKEN_NAME="${POS[1]:-ui}"
[[ "$USER_ID" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] || die "user must look like name@realm"
[[ "$TOKEN_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid token name"
[[ "$ACL_PATH" =~ ^/[A-Za-z0-9_./-]*$ ]] || die "invalid ACL path"

require_root
require_pve
command -v pveum >/dev/null || die "pveum not found"

echo "This will:"
echo "  - create user ${USER_ID} if missing"
echo "  - create API token ${USER_ID}!${TOKEN_NAME} with privilege separation ON (if missing)"
echo "  - grant ${ROLES[*]} on ${ACL_PATH} to the token and the user"
confirm "Continue?" || die "aborted, nothing was changed"

if pveum user list --output-format json | grep -q "\"userid\":\"${USER_ID}\""; then
  info "user ${USER_ID} already exists"
else
  pveum user add "${USER_ID}" --comment "homedash"
  info "created user ${USER_ID}"
fi
ROLE_CSV="$(IFS=,; echo "${ROLES[*]}")"
# ACL on the user AND the token: with privilege separation the effective rights are the intersection of the two.
pveum acl modify "${ACL_PATH}" --users "${USER_ID}" --roles "${ROLE_CSV}"
pveum acl modify "${ACL_PATH}" --tokens "${USER_ID}!${TOKEN_NAME}" --roles "${ROLE_CSV}" 2>/dev/null || true

if pveum user token list "${USER_ID}" --output-format json | grep -q "\"tokenid\":\"${TOKEN_NAME}\""; then
  warn "token ${USER_ID}!${TOKEN_NAME} already exists: its secret is not shown again. Remove it first to get a new one."
else
  pveum user token add "${USER_ID}" "${TOKEN_NAME}" --privsep 1
  pveum acl modify "${ACL_PATH}" --tokens "${USER_ID}!${TOKEN_NAME}" --roles "${ROLE_CSV}"
  echo
  echo "The secret above is shown once. Use:"
  echo "  var_homedash_pve_token_id=${USER_ID}!${TOKEN_NAME}"
fi
info "done (log: ${LOG_FILE})"
