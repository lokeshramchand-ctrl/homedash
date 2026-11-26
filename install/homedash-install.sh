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

mkdir -p /etc/homedash
chmod 700 /etc/homedash

if [[ -n "${var_homedash_config_b64:-}" ]]; then
  # A complete homedash.yaml was supplied (base64) by the caller: use it as is.
  echo "${var_homedash_config_b64}" | base64 -d >/etc/homedash/homedash.yaml
else
  var_homedash_pve_url=$(prompt_input_required "Proxmox API URL (https://<host>:8006):" "https://CHANGE_ME:8006" 120 "var_homedash_pve_url")
  var_homedash_pve_token_id=$(prompt_input_required "Proxmox API token ID (user@realm!name):" "homedash@pve!ui" 120 "var_homedash_pve_token_id")
  if [[ -z "${var_homedash_pve_token_secret:-}" ]]; then
    read -rsp "${TAB3}Proxmox API token secret: " var_homedash_pve_token_secret || true
    echo
  fi
  if [[ -z "${var_homedash_grafana_url:-}${var_homedash_kuma_url:-}${var_homedash_loki_url:-}" ]] && prompt_confirm "Connect Grafana, Uptime Kuma or Loki now?" "n" 30; then
    var_homedash_grafana_url=$(prompt_input "Grafana URL (http://<host>:3000), empty to skip:" "" 60)
    var_homedash_grafana_token=$(prompt_input "Grafana service account token:" "" 60)
    var_homedash_kuma_url=$(prompt_input "Uptime Kuma URL (http://<host>:3001), empty to skip:" "" 60)
    var_homedash_kuma_api_key=$(prompt_input "Uptime Kuma API key:" "" 60)
    var_homedash_loki_url=$(prompt_input "Loki URL (http://<host>:3100), empty to skip:" "" 60)
  fi

  # Secrets go to secrets.env (mode 600); homedash.yaml only refers to them as ${NAME}.
  umask 077
  {
    echo "PVE_TOKEN_SECRET=${var_homedash_pve_token_secret}"
    [[ -n "${var_homedash_grafana_token:-}" ]] && echo "GRAFANA_TOKEN=${var_homedash_grafana_token}"
    [[ -n "${var_homedash_kuma_api_key:-}" ]] && echo "KUMA_API_KEY=${var_homedash_kuma_api_key}"
  } >/etc/homedash/secrets.env
  umask 022

  {
    echo "# Written by the installer. Edit, then: homedash-config validate && homedash-config apply --restart"
    echo "# Every available option is documented in /opt/homedash/infra/homedash.example.yaml"
    echo "server:"
    echo "  port: ${var_homedash_port}"
    echo "  host: 0.0.0.0"
    echo "  https: false"
    echo "  serve_dist: /opt/homedash/dist"
    echo "  database: /opt/homedash/data/homedash.db"
    echo "proxmox:"
    echo "  url: ${var_homedash_pve_url}"
    echo "  node: ${var_homedash_pve_node}"
    echo "  token_id: ${var_homedash_pve_token_id}"
    echo "  token_secret: \${PVE_TOKEN_SECRET}"
    echo "  insecure_tls: true"
    if [[ -n "${var_homedash_grafana_url:-}" ]]; then
      echo "grafana:"
      echo "  url: ${var_homedash_grafana_url}"
      echo "  token: \${GRAFANA_TOKEN}"
    fi
    if [[ -n "${var_homedash_kuma_url:-}" ]]; then
      echo "kuma:"
      echo "  url: ${var_homedash_kuma_url}"
      echo "  api_key: \${KUMA_API_KEY}"
    fi
    if [[ -n "${var_homedash_loki_url:-}" ]]; then
      echo "loki:"
      echo "  url: ${var_homedash_loki_url}"
    fi
    echo "nginx:"
    echo "  manage: true"
    echo "metrics:"
    echo "  enabled: $([[ "${var_homedash_metrics}" == "yes" ]] && echo true || echo false)"
  } >/etc/homedash/homedash.yaml
fi
chmod 600 /etc/homedash/homedash.yaml
var_homedash_admin_password="${var_homedash_admin_password:-$(random_password 16)}"

msg_info "Building homedash"
cd /opt/homedash || exit
$STD npm ci
$STD npm run build
rm -rf node_modules
cd server || exit
$STD npm ci
$STD npm run build
$STD npm prune --omit=dev
msg_ok "Built homedash"

msg_info "Configuring homedash"
cat <<'EOF' >/usr/local/bin/homedash-config
#!/usr/bin/env bash
exec /usr/bin/node --disable-warning=ExperimentalWarning /opt/homedash/server/build/homedash-config.js "$@"
EOF
chmod 755 /usr/local/bin/homedash-config
mkdir -p /opt/homedash/data
$STD homedash-config apply
cd /opt/homedash/server || exit
NEW_PASSWORD="${var_homedash_admin_password}" $STD node --disable-warning=ExperimentalWarning --env-file=.env build/create-user.js "${var_homedash_admin_user}" admin
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
echo -e "${INFO}${YW}Turn on more features by editing /etc/homedash/homedash.yaml, then: homedash-config apply --restart${CL}"

motd_ssh
customize
cleanup_lxc
