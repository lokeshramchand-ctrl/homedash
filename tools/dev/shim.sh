# shellcheck shell=bash
# Stand-in for the community-scripts framework functions, so install/homedash-install.sh can be run
# unmodified inside a plain Debian container (see test-ct.sh). Not part of the submission.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
STD=""
TAB3="   "
CL="" INFO="" YW="" GN="" BGN="" GATEWAY="" CREATING=""
color() { :; }
verb_ip6() { :; }
catch_errors() { trap 'echo "install failed at line $LINENO: $BASH_COMMAND" >&2' ERR; }
setting_up_container() { :; }
network_check() { getent hosts deb.nodesource.com >/dev/null && echo "network ok"; }
update_os() { apt-get update -qq; apt-get install -y -qq curl ca-certificates openssl >/dev/null; }
msg_info() { echo "... $*"; }
msg_ok() { echo " ok $*"; }
msg_warn() { echo "warn $*"; }
msg_error() { echo "ERROR $*" >&2; }
setup_nodejs() {
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  node --version
}
fetch_and_deploy_gh_release() {
  mkdir -p "/opt/$1"
  tar xzf /root/homedash-src.tar.gz -C "/opt/$1"
}
prompt_input() { local v="${4:-}"; if [[ -n "$v" && -n "${!v:-}" ]]; then echo "${!v}"; else echo "${2:-}"; fi; }
prompt_input_required() { local v="${4:-}"; if [[ -n "$v" && -n "${!v:-}" ]]; then echo "${!v}"; else echo "$2"; fi; }
prompt_confirm() { return 1; }
random_password() { head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }
motd_ssh() { :; }
customize() { :; }
cleanup_lxc() { apt-get clean; }
