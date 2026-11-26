// The side menu: one list for the app shell and for anything that needs a page's name or icon (such as "Your most used").
import type { IconName } from './components/ui';
import type { Features } from './types';

export interface NavItem { id: string; label: string; icon: IconName; group: string; feature?: keyof Features; admin?: boolean }

export const ALL_NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'grid', group: 'Workspace' },
  { id: 'node', label: 'Node', icon: 'node', group: 'Datacenter' },
  { id: 'cluster', label: 'Cluster', icon: 'network', group: 'Datacenter' },
  { id: 'guests', label: 'Guests', icon: 'server', group: 'Datacenter' },
  { id: 'gpu', label: 'GPU & passthrough', icon: 'cpu', group: 'Datacenter' },
  { id: 'tasks', label: 'Task log', icon: 'tasks', group: 'Datacenter' },
  { id: 'scenes', label: 'Scenes & schedules', icon: 'play', group: 'Datacenter' },
  { id: 'health', label: 'Health', icon: 'pulse', group: 'Insights' },
  { id: 'protection', label: 'Protection', icon: 'lock', group: 'Insights' },
  { id: 'capacity', label: 'Capacity', icon: 'disk', group: 'Insights' },
  { id: 'netmap', label: 'Network map', icon: 'network', group: 'Insights' },
  { id: 'nginx', label: 'Nginx sites', icon: 'globe', group: 'Services' },
  { id: 'monitoring', label: 'Alerts & sources', icon: 'analytics', group: 'Monitoring' },
  { id: 'kuma', label: 'Uptime', icon: 'pulse', group: 'Monitoring' },
  { id: 'grafana', label: 'Grafana', icon: 'analytics', group: 'Monitoring' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'alert', group: 'Monitoring' },
  { id: 'logs', label: 'Logs', icon: 'list', group: 'Monitoring' },
  { id: 'crowdsec', label: 'CrowdSec', icon: 'lock', group: 'Security', feature: 'crowdsec' },
  { id: 'data', label: 'Data', icon: 'disk', group: 'Services', feature: 'data' },
  { id: 'tiles', label: 'Services', icon: 'grid', group: 'Services', feature: 'tiles' },
  { id: 'llama', label: 'LLM server', icon: 'cpu', group: 'Services', feature: 'llama' },
  { id: 'access', label: 'Access', icon: 'settings', group: 'Settings' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', group: 'Settings' },
  { id: 'setup', label: 'Setup', icon: 'check', group: 'Settings', admin: true },
  { id: 'backups', label: 'Backups and audit', icon: 'disk', group: 'Settings', admin: true },
];
