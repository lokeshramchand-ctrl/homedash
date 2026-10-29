#!/usr/bin/env bash
# Run on a Proxmox host. Creates a throwaway Debian 13 container, runs the real install script in it
# (with tools/dev/shim.sh standing in for the framework helpers) and prints the result.
#
#   bash tools/dev/test-ct.sh [--keep] [vmid] [ip/cidr] [gateway] [bridge]
#
# Defaults: vmid 9999, 10.10.10.199/24 via 10.10.10.1 on bridge vnet1. The container is destroyed at the
# end unless --keep is given. An existing vmid is never touched.

set -euo pipefail

KEEP=0
[[ "${1:-}" == "--keep" ]] && { KEEP=1; shift; }
VMID="${1:-9999}"
IP="${2:-10.10.10.199/24}"
GW="${3:-10.10.10.1}"
BRIDGE="${4:-vnet1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$(pveam list local | awk '/debian-13-standard/ {print $1; exit}')"
TAG="homedash-test"

[[ -n "$TEMPLATE" ]] || { echo "No debian-13-standard template in local storage (pveam download local debian-13-standard_13.6-1_amd64.tar.zst)." >&2; exit 1; }
if pct status "$VMID" >/dev/null 2>&1 || qm status "$VMID" >/dev/null 2>&1; then
  echo "ID $VMID already exists; refusing to touch it." >&2; exit 1
fi

destroy() {
  if pct config "$VMID" 2>/dev/null | grep -q "tags: .*${TAG}"; then
    pct stop "$VMID" >/dev/null 2>&1 || true
    pct destroy "$VMID" --purge >/dev/null && echo "Destroyed container $VMID."
  fi
}
[[ $KEEP -eq 1 ]] || trap destroy EXIT

echo "Creating container $VMID ($IP)..."
pct create "$VMID" "$TEMPLATE" --hostname homedash-test --cores 1 --memory 1024 --swap 0 --rootfs local-lvm:4 \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP},gw=${GW}" --unprivileged 1 --features nesting=1 --tags "$TAG" --onboot 0 >/dev/null
pct start "$VMID"
for _ in $(seq 1 30); do pct exec "$VMID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done

( cd "$ROOT" && git ls-files -co --exclude-standard | tar czf /tmp/homedash-src.tar.gz -T - )
pct push "$VMID" /tmp/homedash-src.tar.gz /root/homedash-src.tar.gz
pct push "$VMID" "$ROOT/install/homedash-install.sh" /root/install.sh
pct push "$VMID" "$ROOT/tools/dev/shim.sh" /root/shim.sh
rm -f /tmp/homedash-src.tar.gz

echo "Running the install script..."
pct exec "$VMID" -- env \
  var_homedash_port=3000 var_homedash_admin_user=admin var_homedash_admin_password=test-password-123 \
  var_homedash_pve_node=pve var_homedash_metrics=yes \
  var_homedash_grafana_url= var_homedash_grafana_token= var_homedash_kuma_url= var_homedash_kuma_api_key= \
  "var_homedash_pve_url=${var_homedash_pve_url:-https://10.10.10.1:8006}" \
  "var_homedash_pve_token_id=${var_homedash_pve_token_id:-homedash@pve!ui}" \
  "var_homedash_pve_token_secret=${var_homedash_pve_token_secret:-unset}" \
  bash -c 'FUNCTIONS_FILE_PATH="$(cat /root/shim.sh)" bash /root/install.sh'

echo
echo "Container $VMID is up at http://${IP%/*}:3000 (login admin / test-password-123)"
[[ $KEEP -eq 1 ]] && echo "Kept. Remove with: pct stop $VMID && pct destroy $VMID --purge"
exit 0
