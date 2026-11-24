// The catalogue of service tiles: one place that says which kinds exist, what each needs, where it usually listens and how
// to recognise it. The config parser, the YAML validator, the "Add service" form and auto-discovery all read this.
// Pure data (no imports) so the CLI can use it too.
export type Cat = 'Containers' | 'Network' | 'Media' | 'Downloads' | 'Smart home' | 'Cloud' | 'Backup' | 'Power' | 'Other';
export type Field = 'token' | 'username' | 'password' | 'ups';

export interface KindInfo {
  kind: string; label: string; category: Cat;
  ports: number[]; https?: boolean;
  /** fields the user must give / may give */
  needs: Field[]; optional: Field[];
  /** how to get the credential, shown under the field */
  hint: string;
  /** how to recognise it when scanning a guest: GET path, then the body must match `match` (case-insensitive), or the status be in `status` */
  probe?: { path: string; match?: string; status?: number[] };
}

export const KINDS: KindInfo[] = [
  { kind: 'docker', label: 'Docker', category: 'Containers', ports: [2375], needs: [], optional: ['token'], hint: 'Docker Engine API, ideally through a read-only socket proxy. No credential needed.', probe: { path: '/version', match: 'ApiVersion' } },
  { kind: 'portainer', label: 'Portainer', category: 'Containers', ports: [9443, 9000], https: true, needs: ['token'], optional: [], hint: 'Portainer: My account → Access tokens.', probe: { path: '/api/system/status', match: 'InstanceID' } },
  { kind: 'pihole', label: 'Pi-hole', category: 'Network', ports: [80], needs: [], optional: ['password', 'token'], hint: 'Pi-hole v6: web password (an app password works). v5: API token (Settings → API).', probe: { path: '/admin/', match: 'Pi-hole' } },
  { kind: 'adguard', label: 'AdGuard Home', category: 'Network', ports: [80, 3000], needs: ['username', 'password'], optional: [], hint: 'The AdGuard Home web login.', probe: { path: '/', match: 'AdGuard Home' } },
  { kind: 'npm', label: 'Nginx Proxy Manager', category: 'Network', ports: [81], needs: ['username', 'password'], optional: [], hint: 'An NPM user (an e-mail address) with view access.', probe: { path: '/api/', match: '"status":"OK"' } },
  { kind: 'traefik', label: 'Traefik', category: 'Network', ports: [8080], needs: [], optional: ['username', 'password'], hint: 'Traefik API/dashboard (api.insecure or behind basic auth).', probe: { path: '/api/version', match: 'Codename|Version' } },
  { kind: 'jellyfin', label: 'Jellyfin', category: 'Media', ports: [8096], needs: [], optional: ['token'], hint: 'Optional API key (Dashboard → API Keys) adds streams and library counts.', probe: { path: '/System/Info/Public', match: 'Jellyfin' } },
  { kind: 'plex', label: 'Plex', category: 'Media', ports: [32400], needs: ['token'], optional: [], hint: 'Your X-Plex-Token.', probe: { path: '/identity', match: 'MediaContainer' } },
  { kind: 'sonarr', label: 'Sonarr', category: 'Media', ports: [8989], needs: ['token'], optional: [], hint: 'Settings → General → API Key.', probe: { path: '/', match: 'Sonarr' } },
  { kind: 'radarr', label: 'Radarr', category: 'Media', ports: [7878], needs: ['token'], optional: [], hint: 'Settings → General → API Key.', probe: { path: '/', match: 'Radarr' } },
  { kind: 'lidarr', label: 'Lidarr', category: 'Media', ports: [8686], needs: ['token'], optional: [], hint: 'Settings → General → API Key.', probe: { path: '/', match: 'Lidarr' } },
  { kind: 'prowlarr', label: 'Prowlarr', category: 'Media', ports: [9696], needs: ['token'], optional: [], hint: 'Settings → General → API Key.', probe: { path: '/', match: 'Prowlarr' } },
  { kind: 'immich', label: 'Immich', category: 'Media', ports: [2283], needs: ['token'], optional: [], hint: 'An admin API key (Account settings → API keys).', probe: { path: '/api/server/ping', match: 'pong' } },
  { kind: 'qbittorrent', label: 'qBittorrent', category: 'Downloads', ports: [8080], needs: ['username', 'password'], optional: [], hint: 'The Web UI login.', probe: { path: '/', match: 'qBittorrent' } },
  { kind: 'homeassistant', label: 'Home Assistant', category: 'Smart home', ports: [8123], needs: ['token'], optional: [], hint: 'Profile → Security → Long-lived access tokens.', probe: { path: '/', match: 'Home Assistant' } },
  { kind: 'nextcloud', label: 'Nextcloud', category: 'Cloud', ports: [80, 443], needs: ['token'], optional: [], hint: 'The "Server info" token: occ config:app:set serverinfo token --value=<secret>.', probe: { path: '/status.php', match: 'installed' } },
  { kind: 'pbs', label: 'Proxmox Backup Server', category: 'Backup', ports: [8007], https: true, needs: ['token'], optional: [], hint: 'API token user@pbs!name:secret with Datastore.Audit and Sys.Audit.', probe: { path: '/', match: 'Proxmox Backup Server' } },
  { kind: 'nut', label: 'UPS (NUT)', category: 'Power', ports: [3493], needs: ['ups'], optional: ['username', 'password'], hint: 'The UPS name from upsc -l, e.g. "ups". URL is tcp://host:3493.' },
  { kind: 'http', label: 'Any HTTP / JSON service', category: 'Other', ports: [], needs: [], optional: ['token'], hint: 'Checks that the URL answers; optionally shows numbers from a JSON answer.' },
];

export const TILE_KIND_IDS = KINDS.map((k) => k.kind);
export const kindInfo = (k: string): KindInfo | undefined => KINDS.find((x) => x.kind === k);

/** Which required fields are missing for this tile? (UI form, YAML validator and the server all use the same rule.) */
export function missingFields(kind: string, v: Partial<Record<Field, string>>): Field[] {
  const info = kindInfo(kind);
  return info ? info.needs.filter((f) => !v[f]) : [];
}
