#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/community-scripts/DevScripts/main"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

# Copyright (c) 2021-2026 community-scripts ORG
# Author: lokeshramchand-ctrl
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/lokeshramchand-ctrl/homedash

APP="homedash"
var_tags="${var_tags:-dashboard;monitoring}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"
#var_arm64="${var_arm64:-no}" # unset = ask the user; set yes/no only when verified

export var_homedash_port="${var_homedash_port:-3000}"
export var_homedash_admin_user="${var_homedash_admin_user:-}"
export var_homedash_admin_password="${var_homedash_admin_password:-}"
export var_homedash_pve_url="${var_homedash_pve_url:-}"
export var_homedash_pve_node="${var_homedash_pve_node:-$(hostname)}"
export var_homedash_pve_token_id="${var_homedash_pve_token_id:-}"
export var_homedash_pve_token_secret="${var_homedash_pve_token_secret:-}"
export var_homedash_grafana_url="${var_homedash_grafana_url:-}"
export var_homedash_grafana_token="${var_homedash_grafana_token:-}"
export var_homedash_kuma_url="${var_homedash_kuma_url:-}"
export var_homedash_kuma_api_key="${var_homedash_kuma_api_key:-}"
export var_homedash_metrics="${var_homedash_metrics:-yes}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/homedash ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  NODE_VERSION="22" setup_nodejs

  if check_for_gh_release "homedash" "lokeshramchand-ctrl/homedash"; then
    msg_info "Stopping Service"
    systemctl stop homedash
    msg_ok "Stopped Service"

    create_backup /opt/homedash/server/.env

    CLEAN_INSTALL=1 CLEAN_INSTALL_KEEP="data" fetch_and_deploy_gh_release "homedash" "lokeshramchand-ctrl/homedash" "tarball"

    restore_backup

    msg_info "Building homedash"
    cd /opt/homedash
    $STD npm ci
    $STD npm run build
    rm -rf node_modules
    cd server
    $STD npm ci
    $STD npm run build
    $STD npm prune --omit=dev
    msg_ok "Built homedash"

    msg_info "Starting Service"
    systemctl start homedash
    msg_ok "Started Service"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:${var_homedash_port}${CL}"
