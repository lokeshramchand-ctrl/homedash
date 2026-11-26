// Where may a user-created data connection point? A session must not turn "Test connection" into a way to
// make the hypervisor connect to arbitrary addresses (cloud metadata, loopback services, other VLANs).
//   - always refused: link-local (169.254/16, fe80::/10, covers cloud metadata), unspecified, multicast
//   - DATASOURCE_ALLOWED_NETS set (CIDRs, comma separated): every resolved address must fall inside one
//   - otherwise: loopback is refused for UI-created connections; connections declared in .env are trusted
// Connections declared in .env (source "env") are written by the server owner and skip the allow-list.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from '../errors.js';
import type { ConnConfig } from './core/types.js';

export function buildBlockList(cidrs: string[]): BlockList {
  const bl = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const fam = isIP(addr) === 6 ? 'ipv6' : isIP(addr) === 4 ? 'ipv4' : null;
    if (!fam) throw new Error(`DATASOURCE_ALLOWED_NETS: "${c}" is not an IP or CIDR`);
    if (bits === undefined) bl.addAddress(addr, fam);
    else bl.addSubnet(addr, Number(bits), fam);
  }
  return bl;
}

const ALWAYS_REFUSED = buildBlockList(['169.254.0.0/16', '0.0.0.0/8', '224.0.0.0/4', 'fe80::/10', 'ff00::/8', '::']);
const LOOPBACK = buildBlockList(['127.0.0.0/8', '::1']);

/** Host names a connection would dial: its host field, or every host in its connection URI. */
export function hostsOf(c: ConnConfig): string[] {
  const out: string[] = [];
  if (c.host) out.push(c.host);
  if (c.uri) {
    const m = /^[a-z][a-z0-9+.\-]*:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(c.uri);
    if (m) for (let h of m[1].split(',')) {
      h = h.trim();
      if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
      else if (/^[^:]+:\d+$/.test(h)) h = h.slice(0, h.lastIndexOf(':'));
      if (h) out.push(h);
    }
  }
  return out;
}

export function checkAddress(ip: string, allowed: BlockList | null, trusted: boolean): string | null {
  const fam = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (ALWAYS_REFUSED.check(ip, fam)) return `${ip} is a link-local or reserved address`;
  if (trusted) return null;
  if (allowed) return allowed.check(ip, fam) ? null : `${ip} is outside DATASOURCE_ALLOWED_NETS`;
  if (LOOPBACK.check(ip, fam)) return `${ip} is a loopback address`;
  return null;
}

/** Throws 403 DESTINATION_NOT_ALLOWED when a user-created connection points somewhere it may not. */
export async function assertDestinationAllowed(c: ConnConfig, allowedNets: string[], trusted: boolean, resolve = lookup): Promise<void> {
  const allowed = allowedNets.length ? buildBlockList(allowedNets) : null;
  for (const host of hostsOf(c)) {
    let addrs: string[];
    if (isIP(host)) addrs = [host];
    else {
      try { addrs = (await resolve(host, { all: true })).map((r) => r.address); }
      catch { continue; } // unresolvable: the connection attempt will fail on its own
    }
    for (const a of addrs) {
      const why = checkAddress(a, allowed, trusted);
      if (why) throw new HttpError(403, 'DESTINATION_NOT_ALLOWED', `Connections to ${host} are not allowed (${why})`);
    }
  }
}
