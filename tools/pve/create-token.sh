#!/usr/bin/env bash
# Run on the Proxmox host. Creates a dedicated user and API token for homedash with the
# PVEAuditor (read) and PVEVMUser (power actions) roles, then prints the values to paste
# into the installer (var_homedash_pve_token_id / var_homedash_pve_token_secret).
#
#   bash create-token.sh [user@realm] [tokenname]
#
# Change what it grants by editing ROLES below. Nothing is changed until you confirm.

set -euo pipefail

USER_ID="${1:-homedash@pve}"
TOKEN_NAME="${2:-ui}"
ROLES=(PVEAuditor PVEVMUser)

command -v pveum >/dev/null || { echo "pveum not found: run this on a Proxmox VE host." >&2; exit 1; }

echo "This will:"
echo "  - create user ${USER_ID} (if missing)"
echo "  - grant ${ROLES[*]} on / to the user"
echo "  - create API token ${USER_ID}!${TOKEN_NAME} (privilege separation off, so it inherits the user's roles)"
read -rp "Continue? [y/N] " answer
[[ "${answer,,}" == "y" ]] || { echo "Aborted."; exit 1; }

pveum user list --output-format json | grep -q "\"userid\":\"${USER_ID}\"" || pveum user add "${USER_ID}" --comment "homedash"
pveum acl modify / --users "${USER_ID}" --roles "$(IFS=,; echo "${ROLES[*]}")"

echo
echo "Token (the secret is shown once):"
pveum user token add "${USER_ID}" "${TOKEN_NAME}" --privsep 0
echo
echo "Use var_homedash_pve_token_id=${USER_ID}!${TOKEN_NAME}"
