# Grafana

homedash talks to Grafana in both directions.

| Direction | What it does | Settings |
|---|---|---|
| **homedash reads Grafana** | The *Grafana* page lists dashboards, embeds panels and runs queries. | `GRAFANA_URL`, `GRAFANA_PUBLIC_URL`, `GRAFANA_TOKEN`, `GRAFANA_DS_UID` |
| **Grafana reads homedash** | `GET /metrics` exposes guests, host, monitors and errors in Prometheus format. | `METRICS_TOKEN` |

## 1. Let Grafana show homedash data

1. Set `METRICS_TOKEN` in `/opt/homedash/.env` (the installer can generate one) and run `systemctl restart homedash`.
2. Add the job from [`prometheus-scrape.yml`](prometheus-scrape.yml) to your Prometheus config and reload Prometheus.
3. In Grafana: **Dashboards → New → Import**, upload [`homedash-dashboard.json`](homedash-dashboard.json) and pick your Prometheus data source.

Check the endpoint by hand:

```sh
curl -H "Authorization: Bearer $METRICS_TOKEN" http://HOMEDASH_IP:3000/metrics
```

### Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `homedash_up` | | process is serving |
| `homedash_database_up` | | SQLite answers |
| `homedash_proxmox_up` | | Proxmox API answers |
| `homedash_errors_24h` | | error events in the last 24 h |
| `homedash_guest_running` | `vmid`, `name`, `type` | 1 running, 0 stopped |
| `homedash_guest_cpu_ratio` | same | 0..1 |
| `homedash_guest_memory_used_bytes` / `_max_bytes` | same | |
| `homedash_guest_uptime_seconds` | same | |
| `homedash_host_cpu_ratio` | `node` | 0..1 |
| `homedash_host_memory_used_bytes` / `_total_bytes` | `node` | |
| `homedash_host_disk_used_bytes` / `_total_bytes` | `node` | root disk |
| `homedash_host_uptime_seconds` | `node` | |
| `homedash_monitor_up` | `monitor`, `type` | Uptime Kuma state |
| `homedash_monitor_response_ms` | `monitor`, `type` | Uptime Kuma response time |
| `homedash_nginx_sites` | | `server_name` entries found |

## 2. Show Grafana inside homedash

1. In Grafana create a **service account** with the *Viewer* role and copy its token into `GRAFANA_TOKEN`.
2. Set `allow_embedding = true` in the `[security]` section of `grafana.ini` so panels can be framed.
3. `GRAFANA_URL` is how the homedash container reaches Grafana; `GRAFANA_PUBLIC_URL` is what your browser opens. Add the public origin to `FRAME_SRC`.
4. Optional: set `GRAFANA_DS_UID` to your Prometheus data source UID to enable the metrics explorer.
