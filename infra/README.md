# infra

Templates that `homedash-config apply` renders from `/etc/homedash/homedash.yaml`. Nothing here is applied by hand.

| Folder | Becomes | Needs |
|---|---|---|
| `nginx/` | vhosts in `nginx.sites_dir`, snippets in `nginx.conf_dir` | nginx in the homedash container |
| `alloy/` | Alloy config, guest journal generator, units | Proxmox host (`tools/pve/host-addons.sh`) |
| `crowdsec/` | snapshot script, timer, Grafana dashboard | Proxmox host |
| `prometheus/` | `prometheus.yml`, node-exporter defaults | Prometheus container, host |
| `loki/` | `loki-config.yml` | Loki container |
| `grafana/` | provisioning files | Grafana container |

Template syntax: `{{path}}`, `{{#if x}}..{{else}}..{{/if}}`, `{{#unless x}}`, `{{#each list}}{{.}} {{.field}}{{/each}}`. JSON files are copied verbatim.
Add a file here and a line in `targets()` in `server/src/homedash-config.ts` to ship a new one.
