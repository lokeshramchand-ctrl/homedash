import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Delta, SparkBars, SparkLine, Ticks } from './Charts';
import { Icon } from './ui';
import type { IconName } from './ui';

// Components used by the ported pages (CrowdSec, Data manager, LLM, log analytics). Kept next to ui.tsx
// so the base set stays small. Side-panel class names use the `dsheet-` prefix (`sheet-` is the mobile menu).

export interface SheetSection { id: string; title: string; icon?: IconName; body: ReactNode }

export function Sheet({ title, eyebrow, sub, onClose, sections, children, footer, size = 'md' }: {
  title: string; eyebrow?: string; sub?: ReactNode; onClose: () => void;
  sections?: SheetSection[]; children?: ReactNode; footer?: ReactNode; size?: 'md' | 'lg';
}) {
  const body = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState(sections?.[0]?.id);
  const [leaving, setLeaving] = useState(false);
  // Parents re-render on every poll; keep the latest onClose without re-running the open/close effect.
  const closeCb = useRef(onClose);
  closeCb.current = onClose;
  const leaveRef = useRef(false);
  const close = () => {
    if (leaveRef.current) return;
    leaveRef.current = true;
    setLeaving(true);
    const quick = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => closeCb.current(), quick ? 0 : 190);
  };
  const closeFn = useRef(close);
  closeFn.current = close;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeFn.current(); } };
    window.addEventListener('keydown', f);
    return () => { window.removeEventListener('keydown', f); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, []);
  const onScroll = () => {
    const el = body.current;
    if (!el || !sections) return;
    const top = el.getBoundingClientRect().top + 24;
    let cur = sections[0]?.id;
    for (const s of sections) {
      const node = el.querySelector<HTMLElement>(`[data-sec="${s.id}"]`);
      if (node && node.getBoundingClientRect().top <= top) cur = s.id;
    }
    setActive(cur);
  };
  const jump = (id: string) => {
    body.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };
  return createPortal(
    <div className={`dsheet-scrim ${leaving ? 'leaving' : ''}`} onMouseDown={close}>
      <aside className={`dsheet-panel sheet-${size}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header className="dsheet-head">
          <div className="grow">
            {eyebrow && <p className="dsheet-eyebrow">{eyebrow}</p>}
            <h2>{title}</h2>
            {sub && <p className="muted small">{sub}</p>}
          </div>
          <button ref={closeRef} className="icon-btn dsheet-x" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
        </header>
        <div className={`dsheet-main ${sections && sections.length > 1 ? 'has-toc' : ''}`}>
          {sections && sections.length > 1 && (
            <nav className="dsheet-toc" aria-label="On this page">
              <p>On this page</p>
              {sections.map((s) => (
                <button key={s.id} className={active === s.id ? 'on' : ''} aria-current={active === s.id ? 'true' : undefined} onClick={() => jump(s.id)}>
                  {s.icon && <Icon name={s.icon} size={15} />}<span>{s.title}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="dsheet-body" ref={body} onScroll={onScroll}>
            {sections?.map((s) => (
              <section key={s.id} className="dsheet-sec" data-sec={s.id}>
                <h3>{s.icon && <span className="dsheet-sec-ic"><Icon name={s.icon} size={15} /></span>}{s.title}</h3>
                {s.body}
              </section>
            ))}
            {children}
          </div>
        </div>
        {footer && <footer className="dsheet-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

export function DocRow({ k, v, copy, mono = false }: { k: ReactNode; v: ReactNode; copy?: string; mono?: boolean }) {
  return (
    <div className="doc-row">
      <span className="doc-k">{k}</span>
      <span className={`doc-v ${mono ? 'mono' : ''}`}>{v}</span>
      {copy ? <CopyButton text={copy} compact /> : <span />}
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-bar"><span>{label ?? 'shell'}</span><CopyButton text={code} compact /></div>
      <pre>{code}</pre>
    </div>
  );
}

export function CopyButton({ text, compact }: { text: string; compact?: boolean }) {
  const [ok, setOk] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }).catch(() => { /* clipboard blocked */ }); };
  return compact
    ? <button className={`icon-btn sm copy ${ok ? 'done' : ''}`} onClick={copy} aria-label={ok ? 'Copied' : 'Copy'} title={ok ? 'Copied' : 'Copy'}><span key={String(ok)} className="pop"><Icon name={ok ? 'check' : 'copy'} size={15} /></span>{ok && <span className="copied-note" role="status">Copied</span>}</button>
    : <button className={`btn btn-sm btn-ghost copy ${ok ? 'done' : ''}`} onClick={copy}><span key={String(ok)} className="pop"><Icon name={ok ? 'check' : 'copy'} size={15} /></span>{ok ? 'Copied' : 'Copy'}</button>;
}

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

export function Stat({ icon, label, value, unit, sub, href, spark, sparkKind = 'bars', trend, tone, title }: {
  icon: IconName; label: string; value: ReactNode; unit?: string; sub?: ReactNode; href?: string;
  spark?: number[]; sparkKind?: 'bars' | 'line'; trend?: 'up' | 'down'; tone?: 'red' | 'green' | 'amber'; title?: string;
}) {
  // Trend pill: change across the spark window; `trend` names the healthy direction.
  const sv = spark?.filter(Number.isFinite) ?? [];
  const pill = trend && sv.length > 3 ? <Delta now={avg(sv.slice(-3))} since={avg(sv.slice(0, 3))} good={trend} /> : null;
  const inner = (
    <>
      <div className="stat-top"><span className="stat-ic"><Icon name={icon} size={16} /></span><span className="stat-label">{label}</span>{href && <span className="stat-go"><Icon name="arrow" size={14} /></span>}</div>
      <div className="stat-row">
        <div className="stat-value"><span key={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined} className="num-in">{value}</span>{unit && <small>{unit}</small>}</div>
        {spark && (sparkKind === 'line' ? <SparkLine values={spark} /> : <SparkBars values={spark} />)}
      </div>
      {(sub || pill) && <p className="stat-sub">{pill && <span className="stat-trend">{pill}</span>}{sub}</p>}
    </>
  );
  const cls = `stat ${tone ? `stat-${tone}` : ''}`;
  return href ? <a className={cls} href={href} title={title}>{inner}</a> : <div className={cls} title={title}>{inner}</div>;
}
