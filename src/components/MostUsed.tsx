import { api } from '../api';
import { Card, CardHead, Icon } from './ui';
import type { IconName } from './ui';
import { Logo } from './ServiceForm';
import { useQuery, useToast } from '../hooks';
import { ALL_NAV } from '../nav';

interface Resolved { key: string; label: string; href: string; icon: IconName | null; external: boolean; tile: { kind: string; id: string } | null }

/**
 * "Your most used": the pages and services this person opens most, learned from their own use. Only an id is stored on the server,
 * only this person can read it, and they can clear it here. Nothing is shown until there is something to show.
 */
export function MostUsed() {
  const toast = useToast();
  const top = useQuery(() => api.usageTop(10), [], 0);
  const tiles = useQuery(api.tiles, [], 0);

  const items = (top.data?.items ?? []).flatMap((u): Resolved[] => {
    const [kind, id] = u.item.split(':');
    if (kind === 'page') {
      const n = ALL_NAV.find((x) => x.id === id);
      return n ? [{ key: u.item, label: n.label, href: `#/${n.id}`, icon: n.icon, external: false, tile: null }] : [];
    }
    if (kind === 'tile') {
      const t = tiles.data?.find((x) => x.id === id);
      return t?.link ? [{ key: u.item, label: t.name, href: t.link, icon: null, external: true, tile: { kind: t.kind, id: t.id } }] : [];
    }
    return [];
  }).slice(0, 6);

  if (!items.length) return null;

  async function clear() {
    try { await api.usageReset(); toast.success('Your history is cleared'); top.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <Card>
      <CardHead title="Your most used" sub="What you open most. Only you can see this." right={<button className="btn btn-sm btn-ghost" onClick={clear}>Clear my history</button>} />
      <div className="mu-row">
        {items.map((i) => (
          <a key={i.key} className="mu-item" href={i.href} {...(i.external ? { target: '_blank', rel: 'noopener noreferrer', onClick: () => void api.usageCount(`tile:${i.tile!.id}`) } : {})}>
            {i.tile ? <Logo kind={i.tile.kind} label={i.label} size={26} /> : i.icon ? <Icon name={i.icon} size={18} /> : null}
            <span>{i.label}</span>
          </a>
        ))}
      </div>
    </Card>
  );
}
