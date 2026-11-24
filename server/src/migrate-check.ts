// Pre-flight for moving a guest to another node. Pure: the caller passes what Proxmox reported.
// "block" stops the migration (it would fail or lose the guest's state); "warn" is allowed but worth reading.
export interface CheckInput {
  type: 'qemu' | 'lxc'; running: boolean; withLocalDisks: boolean; memMax: number; reserveBytes: number;
  localDisks: { volid: string; size: number }[];
  /** hostpciN / usbN entries and anything else Proxmox calls a local resource */
  localResources: string[];
  target?: { name: string; online: boolean; maxmem: number; mem: number; allowed: boolean; reason: string | null };
}
export interface Check { id: string; level: 'block' | 'warn' | 'info'; text: string }

const gb = (b: number) => `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`;

export function migrationChecks(i: CheckInput): Check[] {
  const out: Check[] = [];
  const disks = i.localDisks.filter((d) => d.volid);
  const size = disks.reduce((a, d) => a + (d.size || 0), 0);

  if (i.type === 'lxc') {
    if (i.running) out.push({ id: 'lxc-restart', level: 'info', text: 'Containers cannot be live-migrated: it is stopped, moved and started again on the target (a short outage).' });
    if (disks.length) out.push({ id: 'lxc-local', level: 'warn', text: `Its storage is local to this node (${gb(size)}). Proxmox copies it to the target storage while the container is stopped, which can take a while.` });
  } else if (disks.length) {
    if (i.running && !i.withLocalDisks) {
      out.push({ id: 'local-disks', level: 'block', text: `This VM has ${disks.length} disk${disks.length === 1 ? '' : 's'} on storage only this node can see (${gb(size)}: ${disks.slice(0, 3).map((d) => d.volid).join(', ')}). Tick "copy local disks" to live-migrate it, or move the disks to shared storage first.` });
    } else if (i.withLocalDisks) {
      out.push({ id: 'local-copy', level: 'warn', text: `${gb(size)} of local disk will be copied to the target over the network${i.running ? '; the VM keeps running but disk and network traffic will be slower until it finishes' : ''}.` });
    } else {
      out.push({ id: 'local-offline', level: 'warn', text: `Its disks (${gb(size)}) are on local storage: tick "copy local disks" so they move with it; otherwise Proxmox refuses.` });
    }
  }

  const pass = i.localResources.filter((r) => /^(hostpci|usb|serial|parallel)\d*$/i.test(r) || /pci|usb|passthrough/i.test(r));
  if (pass.length && i.type === 'qemu') {
    const list = pass.slice(0, 4).join(', ');
    out.push(i.running
      ? { id: 'passthrough-live', level: 'block', text: `It uses passthrough hardware (${list}). A running VM with passed-through devices cannot be live-migrated: shut it down first, and the target needs the same device at the same address.` }
      : { id: 'passthrough', level: 'warn', text: `It uses passthrough hardware (${list}). The target node must have the same device at the same address, and nothing else may be using it.` });
  }

  const t = i.target;
  if (t) {
    if (!t.online) out.push({ id: 'target-offline', level: 'block', text: `${t.name} is offline.` });
    else if (!t.allowed) out.push({ id: 'target-refused', level: 'block', text: `Proxmox says ${t.name} cannot take this guest${t.reason ? `: ${t.reason}` : ''}.` });
    if (t.online && i.memMax > 0) {
      const free = t.maxmem - t.mem - i.reserveBytes;
      if (i.memMax > t.maxmem) out.push({ id: 'ram-never', level: 'block', text: `The guest is configured for ${gb(i.memMax)} of RAM; ${t.name} only has ${gb(t.maxmem)}.` });
      else if (i.memMax > free) out.push({ id: 'ram-tight', level: 'warn', text: `${t.name} has about ${gb(Math.max(free, 0))} of RAM to spare (after keeping a reserve for the host) and the guest is configured for ${gb(i.memMax)}. It may fail to start, or push the node into swapping.` });
    }
  }
  return out;
}

export const blockers = (c: Check[]) => c.filter((x) => x.level === 'block');
