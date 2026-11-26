#!/usr/bin/env bash
# Run on the Proxmox host. Installs the OPTIONAL host-side add-ons that `homedash-config apply` rendered inside the
# homedash container (see addons: in /etc/homedash/homedash.yaml):
#
#   alloy      Grafana Alloy: ships the host journal, nginx logs and every LXC guest's journal to Loki
#   crowdsec   a timer that publishes a read-only CrowdSec snapshot into the homedash container
#   node       prometheus-node-exporter listen address
#
#   bash host-addons.sh [--yes] [--dry-run] <homedash-ctid> [alloy] [crowdsec] [node]
#
# Safe by design: asks before each add-on (--yes answers for you), backs up every file it replaces to
# /var/backups/homedash, is idempotent (re-running changes nothing that is already in place), checks it is on a
# Proxmox VE node with free disk and network first, logs to /var/log/homedash-host.log and cleans up on exit.
# Read it before running it: curl https://raw.githubusercontent.com/lokeshramchand-ctrl/homedash/main/tools/pve/host-addons.sh

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

DRY=0
POS=()
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) POS+=("$a") ;;
  esac
done
CT="${POS[0]:-}"
[[ "$CT" =~ ^[0-9]+$ ]] || die "usage: host-addons.sh [--yes] [--dry-run] <homedash-ctid> [alloy] [crowdsec] [node]"
SELECTED=("${POS[@]:1}")
want() { if [[ ${#SELECTED[@]} -gt 0 ]]; then [[ " ${SELECTED[*]} " == *" $1 "* ]]; else return 0; fi; }

require_root
require_pve
command -v pct >/dev/null || die "pct not found"
pct status "$CT" 2>/dev/null | grep -q running || die "container $CT does not exist or is not running"
require_space / 500
mkdir -p "$BACKUP_DIR"
info "homedash host add-ons for container $CT (log: $LOG_FILE)"

R=/etc/homedash/rendered/host
WORK=$(mktmp)
pct exec "$CT" -- test -d "$R" || die "nothing rendered yet: in the container run  homedash-config apply"
pct exec "$CT" -- tar -C "$R" -cf - . | tar -C "$WORK" -xf -

run() { if [[ $DRY -eq 1 ]]; then info "  [dry-run] $*"; else "$@"; fi; }
put() { if [[ $DRY -eq 1 ]]; then info "  [dry-run] install $2"; else install_if_changed "$@"; fi; }

# ---------------------------------------------------------------- Alloy
if want alloy && [[ -f "$WORK/alloy/config.alloy" ]]; then
  info "== Alloy (log shipper)"
  if confirm "Install/update Alloy on this host and ship logs to Loki?"; then
    if ! command -v alloy >/dev/null; then
      require_network apt.grafana.com
      info "  adding the Grafana apt repository (signed key) and installing alloy"
      if [[ $DRY -eq 0 ]]; then
        apt-get install -y gpg curl >/dev/null
        mkdir -p /etc/apt/keyrings
        key="$WORK/grafana.gpg.key"
        curl -fsSL -o "$key" https://apt.grafana.com/gpg.key
        gpg --dearmor <"$key" >/etc/apt/keyrings/grafana.gpg.new
        mv -f /etc/apt/keyrings/grafana.gpg.new /etc/apt/keyrings/grafana.gpg
        # one line, rewritten (not appended) so re-running never duplicates it
        echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" >/etc/apt/sources.list.d/grafana.list
        apt-get update -qq && apt-get install -y alloy >/dev/null
      fi
    fi
    put "$WORK/alloy/config.alloy" /etc/alloy/config.alloy 0644
    put "$WORK/alloy/alloy-override.conf" /etc/systemd/system/alloy.service.d/10-homedash.conf 0644
    if [[ -f "$WORK/alloy/alloy-guest-sources" ]]; then
      put "$WORK/alloy/alloy-guest-sources" /usr/local/sbin/alloy-guest-sources 0755
      put "$WORK/alloy/alloy-guest-sources.service" /etc/systemd/system/alloy-guest-sources.service 0644
      put "$WORK/alloy/alloy-guest-sources.timer" /etc/systemd/system/alloy-guest-sources.timer 0644
      [[ -f /etc/alloy/guests.alloy || $DRY -eq 1 ]] || echo "// generated" >/etc/alloy/guests.alloy
    fi
    if id alloy >/dev/null 2>&1; then run usermod -aG adm,systemd-journal alloy; fi
    if [[ -f /etc/default/alloy ]] && ! grep -q '^CONFIG_FILE="/etc/alloy"' /etc/default/alloy; then
      backup_file /etc/default/alloy
      run sed -i 's|^CONFIG_FILE=.*|CONFIG_FILE="/etc/alloy"|' /etc/default/alloy
    fi
    run systemctl daemon-reload
    run systemctl enable --now alloy
    run systemctl restart alloy
    [[ -f "$WORK/alloy/alloy-guest-sources" ]] && run systemctl enable --now alloy-guest-sources.timer
    info "  note: LXC guests need a persistent journal (mkdir -p /var/log/journal && systemctl restart systemd-journald)"
  else info "  skipped"; fi
fi

# ---------------------------------------------------------------- CrowdSec snapshot
if want crowdsec && [[ -f "$WORK/crowdsec/crowdsec-snapshot" ]]; then
  info "== CrowdSec snapshot (feeds the CrowdSec page)"
  if confirm "Install the snapshot timer? It runs cscli (read-only) and copies the result into container $CT"; then
    put "$WORK/crowdsec/crowdsec-snapshot" /usr/local/sbin/homedash-crowdsec-snapshot 0755
    put "$WORK/crowdsec/crowdsec-snapshot.service" /etc/systemd/system/homedash-crowdsec-snapshot.service 0644
    put "$WORK/crowdsec/crowdsec-snapshot.timer" /etc/systemd/system/homedash-crowdsec-snapshot.timer 0644
    if [[ $DRY -eq 0 ]]; then mkdir -p /etc/homedash; echo "HOMEDASH_CTID=$CT" >/etc/homedash/host.env; fi
    run systemctl daemon-reload
    run systemctl enable --now homedash-crowdsec-snapshot.timer
    run systemctl start homedash-crowdsec-snapshot.service || warn "first run failed: journalctl -u homedash-crowdsec-snapshot"
  else info "  skipped"; fi
fi

# ---------------------------------------------------------------- node exporter
if want node && [[ -f "$WORK/prometheus/prometheus-node-exporter" ]]; then
  info "== prometheus-node-exporter listen address"
  if confirm "Install prometheus-node-exporter (if missing) and apply the listen address?"; then
    if ! command -v prometheus-node-exporter >/dev/null; then run apt-get install -y prometheus-node-exporter; fi
    put "$WORK/prometheus/prometheus-node-exporter" /etc/default/prometheus-node-exporter 0644
    run systemctl restart prometheus-node-exporter
  else info "  skipped"; fi
fi

info "Done. Backups of replaced files: $BACKUP_DIR. Stack files (Loki, Prometheus, Grafana) are in the container under"
info "/etc/homedash/rendered/stack/ : pct pull $CT /etc/homedash/rendered/stack/<file> <local-file>"
