# shellcheck shell=bash
# Shared helpers for the Proxmox host scripts in tools/pve (sourced, not run).
# Provides: logging to /var/log, pre-flight checks, confirmation prompts (--yes aware), backups, cleanup trap.

LOG_FILE="${LOG_FILE:-/var/log/homedash-host.log}"
ASSUME_YES="${ASSUME_YES:-0}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/homedash}"
_TMP_DIRS=()

log()  { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
info() { printf '%s\n' "$*"; log "INFO  $*"; }
warn() { printf 'warning: %s\n' "$*" >&2; log "WARN  $*"; }
die()  { printf 'error: %s\n' "$*" >&2; log "ERROR $*"; exit 1; }

mktmp() { local d; d=$(mktemp -d); _TMP_DIRS+=("$d"); printf '%s' "$d"; }
_cleanup() { local d; for d in "${_TMP_DIRS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; }
trap _cleanup EXIT
trap 'die "interrupted"' INT TERM

require_root() { [[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"; }

# Refuse to run anywhere but a Proxmox VE node, and note the version in the log.
require_pve() {
  command -v pveversion >/dev/null || die "pveversion not found: this must run on a Proxmox VE host"
  log "PVE $(pveversion | head -n1)"
}

# require_space <path> <MB>
require_space() {
  local free; free=$(df -Pm "$1" 2>/dev/null | awk 'NR==2{print $4}')
  [[ -n "$free" && "$free" -ge "$2" ]] || die "less than $2 MB free on $1"
}

# require_network <host>: apt and key downloads need it
require_network() { getent hosts "$1" >/dev/null 2>&1 || die "cannot resolve $1 (no network or DNS?)"; }

confirm() { # confirm "question"
  [[ "$ASSUME_YES" == "1" ]] && return 0
  [[ -t 0 ]] || die "not a terminal: pass --yes to proceed without questions"
  local a; read -rp "$1 [y/N] " a; [[ "${a,,}" == "y" ]]
}

# backup_file <path>: copy an existing file to $BACKUP_DIR/<timestamp>/ before it is replaced
backup_file() {
  [[ -e "$1" ]] || return 0
  local dest
  dest="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)$(dirname "$1")"
  mkdir -p "$dest" && cp -a "$1" "$dest/" && log "BACKUP $1 -> $dest"
}

# install_if_changed <src> <dest> <mode>: idempotent; backs up what it replaces
install_if_changed() {
  if cmp -s "$1" "$2" 2>/dev/null; then info "  unchanged $2"; return 0; fi
  backup_file "$2"
  install -D -m "$3" "$1" "$2"
  info "  installed $2"
}
