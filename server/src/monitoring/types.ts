// The normalised model every monitoring tool is reduced to. Anything that can say "this is up/down" (a check) or
// "this alert is firing" (an alert) plugs in through a Provider; Overview, the notifier and the timeline read only the merged result.
export type Status = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';

export interface Check { key: string; name: string; status: Status; since: number | null; detail: string; url: string | null; ping?: number | null }
export interface MonAlert { key: string; name: string; level: 'info' | 'warn' | 'error'; state: 'firing' | 'pending'; since: number | null; summary: string; instances: number; url: string | null }
export interface Polled { checks: Check[]; alerts: MonAlert[] }

export interface Provider {
  kind: string;
  label: string;
  /** False when this provider's checks already raise alerts elsewhere (Uptime Kuma, through noteMonitors in events.ts). */
  raisesChecks: boolean;
  configured(): boolean;
  /** Throws on failure. An error must never come back as an empty result: that would read as "all clear". */
  poll(): Promise<Polled>;
}

export interface SourceState {
  id: string; kind: string; label: string; managed: 'config';
  ok: boolean; stale: boolean; error: string | null; checkedAt: number; checks: number; alerts: number;
}
export interface Merged {
  sources: SourceState[];
  checks: (Check & { source: string })[];
  alerts: (MonAlert & { source: string })[];
  checkedAt: number;
}
