#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: lokeshramchand-ctrl
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/lokeshramchand-ctrl/homedash

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt install -y nginx
rm -f /etc/nginx/sites-enabled/default
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs
fetch_and_deploy_gh_release "homedash" "lokeshramchand-ctrl/homedash" "tarball"

var_homedash_admin_user=$(prompt_input "Admin username:" "${var_homedash_admin_user:-admin}" 60)
var_homedash_pve_url=$(prompt_input_required "Proxmox API URL (https://<host>:8006):" "https://CHANGE_ME:8006" 120 "var_homedash_pve_url")
var_homedash_pve_token_id=$(prompt_input_required "Proxmox API token ID (user@realm!name):" "homedash@pve!ui" 120 "var_homedash_pve_token_id")
if [[ -z "${var_homedash_pve_token_secret:-}" ]]; then
  read -rsp "${TAB3}Proxmox API token secret: " var_homedash_pve_token_secret || true
  echo
fi
if [[ -z "${var_homedash_grafana_url:-}${var_homedash_kuma_url:-}" ]] && prompt_confirm "Connect Grafana and Uptime Kuma now?" "n" 30; then
  var_homedash_grafana_url=$(prompt_input "Grafana URL (http://<host>:3000), empty to skip:" "" 60)
  var_homedash_grafana_token=$(prompt_input "Grafana service account token:" "" 60)
  var_homedash_kuma_url=$(prompt_input "Uptime Kuma URL (http://<host>:3001), empty to skip:" "" 60)
  var_homedash_kuma_api_key=$(prompt_input "Uptime Kuma API key:" "" 60)
fi
var_homedash_admin_password="${var_homedash_admin_password:-$(random_password 16)}"

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

msg_info "Configuring homedash"
cat <<EOF >/opt/homedash/server/.env
PORT=${var_homedash_port}
HOST=0.0.0.0
TRUST_PROXY=false
COOKIE_SECURE=false
SERVE_DIST=/opt/homedash/dist
DB_PATH=/opt/homedash/data/homedash.db
PVE_URL=${var_homedash_pve_url}
PVE_NODE=${var_homedash_pve_node}
PVE_TOKEN_ID=${var_homedash_pve_token_id}
PVE_TOKEN_SECRET=${var_homedash_pve_token_secret}
PVE_INSECURE_TLS=true
GRAFANA_URL=${var_homedash_grafana_url}
GRAFANA_PUBLIC_URL=${var_homedash_grafana_url}
GRAFANA_TOKEN=${var_homedash_grafana_token}
KUMA_URL=${var_homedash_kuma_url}
KUMA_API_KEY=${var_homedash_kuma_api_key}
JOURNAL_ENABLED=false
NGINX_MANAGE=true
NGINX_SITES_DIR=/etc/nginx/sites-enabled
EOF
if [[ "${var_homedash_metrics}" == "yes" ]]; then
  echo "METRICS_TOKEN=$(openssl rand -hex 32)" >>/opt/homedash/server/.env
fi
chmod 600 /opt/homedash/server/.env
cd /opt/homedash/server
NEW_PASSWORD="${var_homedash_admin_password}" $STD node --disable-warning=ExperimentalWarning --env-file=.env build/create-user.js "${var_homedash_admin_user}"
msg_ok "Configured homedash"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/homedash.service
[Unit]
Description=homedash
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/homedash/server
EnvironmentFile=/opt/homedash/server/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning build/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now homedash
msg_ok "Created Service"

echo -e "${INFO}${YW}homedash login: ${var_homedash_admin_user} / ${var_homedash_admin_password}${CL}"

motd_ssh
customize
cleanup_lxc
