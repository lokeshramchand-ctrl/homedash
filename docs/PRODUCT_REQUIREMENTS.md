# Product requirements

homedash is the control plane above an existing homelab: it reads, correlates and, where authorised, operates other tools. It does not replace them and links to their own interfaces for depth.

## Personas
| Persona | Needs | Served by today |
|---|---|---|
| Homelab administrator | Proxmox clusters, guests, storage, backups, health | Datacenter and Insights pages |
| Developer | Inventory, databases, logs, API health, dependencies | Data, Logs, Service registry, Alerts and sources |
| Security and network administrator | CrowdSec, firewall, identity, exposed services | CrowdSec, Identity; firewall is a gateway-health template only |
| Viewer | Availability, incidents, read-only | Overview, Uptime, public status page, Services (mobile) |

## Requirements and status
| Requirement | Status |
|---|---|
| One list of problems from every connected tool, with alerts, silences and maintenance windows | done |
| Connect a new tool without code when it has a web address | done (custom HTTP source, 11 templates) |
| Service inventory with owner, criticality, dependencies, health | done (registry) |
| Find what a failure affects | done for recorded dependencies |
| Inspect an OIDC provider and check it against homedash | done |
| Declared capabilities per integration, permission per capability | not started |
| Incidents with timeline, acknowledgement, resolution | not started |
| Configuration snapshots and drift | not started |
| Network module (interfaces, DHCP, VPN, topology) | not started |
| Real-time updates | not started |

## Non-negotiables (unchanged)
Secrets never reach the browser or logs. Nothing changes a firewall, schema or infrastructure without an explicit, audited action. Missing data is shown as missing. Unverified integrations say so.
