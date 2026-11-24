import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, loadConfig } from './api';
import { Logo } from './components/Brand';
import { CommandPalette } from './components/CommandPalette';
import type { Command } from './components/CommandPalette';
import { Icon, Spinner } from './components/ui';
import type { IconName } from './components/ui';
import { RefreshCtx, SearchCtx, ToastProvider, useHash, useQuery, useToast } from './hooks';
import Diagnostics from './pages/Diagnostics';
import Gpu from './pages/Gpu';
import GuestDetail from './pages/GuestDetail';
import Capacity from './pages/Capacity';
import Health from './pages/Health';
import Netmap from './pages/Netmap';
import Node from './pages/Node';
import Protection from './pages/Protection';
import Scenes from './pages/Scenes';
import Notifications from './pages/Notifications';
import Tasks from './pages/Tasks';
import Guests from './pages/Guests';
import Grafana from './pages/Grafana';
import Kuma from './pages/Kuma';
import Logs from './pages/Logs';
import Login from './pages/Login';
import Nginx from './pages/Nginx';
import Overview from './pages/Overview';
import { TwoStepGate, TwoStepSheet } from './components/TwoStep';
import Access from './pages/Access';
import Nodes from './pages/Nodes';
import { ClusterPicker } from './components/Cluster';
import { select, selectedCluster, selectedNode } from './selection';
import Crowdsec from './pages/Crowdsec';
import Data from './pages/Data';
import Llama from './pages/Llama';
import Tiles from './pages/Tiles';
import type { AppConfig, Features, Guest } from './types';

const ALL_NAV: { id: string; label: string; icon: IconName; group: string; feature?: keyof Features }[] = [
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
  { id: 'kuma', label: 'Uptime', icon: 'pulse', group: 'Monitoring' },
  { id: 'grafana', label: 'Grafana', icon: 'analytics', group: 'Monitoring' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'alert', group: 'Monitoring' },
  { id: 'logs', label: 'Logs', icon: 'list', group: 'Monitoring' },
  { id: 'crowdsec', label: 'CrowdSec', icon: 'lock', group: 'Security', feature: 'crowdsec' },
  { id: 'data', label: 'Data', icon: 'disk', group: 'Services', feature: 'data' },
  { id: 'tiles', label: 'Service tiles', icon: 'grid', group: 'Services', feature: 'tiles' },
  { id: 'llama', label: 'LLM server', icon: 'cpu', group: 'Services', feature: 'llama' },
  { id: 'access', label: 'Access', icon: 'settings', group: 'Settings' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', group: 'Settings' },
];
const SEARCH_HINT: Record<string, string> = {
  overview: 'Search guests…', node: 'Filter interfaces…', guests: 'Search name, vmid or tag…', tasks: 'Filter tasks…', nginx: 'Search domain, upstream or file…',
  crowdsec: 'Search…', tiles: 'Search services…', access: 'Search…', data: 'Search…', llama: 'Search…',
  cluster: 'Search…', scenes: 'Search…', health: 'Search…', capacity: 'Search…', protection: 'Search guests…', netmap: 'Search guest, IP or MAC…',
  grafana: 'Search dashboards, folders or tags…', kuma: 'Search monitors…', logs: 'Filter messages…', gpu: 'Search…', diagnostics: 'Search…', notifications: 'Search…',
};

type ThemePref = 'system' | 'light' | 'dark';
const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];
const systemTheme = (): 'light' | 'dark' => (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const THEME_ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<ThemePref, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

// Flat brand colours; a stable hash of the username picks one, so each user keeps the same
// solid-colour monogram across sessions. No gradients — just the initials, cleanly set.
const AVATAR_COLORS = ['#ed272e', '#0870b9', '#3eb850', '#5a6fc9', '#0b7a8c', '#c27a16'];
function avatarColor(user: string): string {
  let h = 0;
  for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ user }: { user: string }) {
  return <span className="avatar" style={{ background: avatarColor(user) }}>{user.slice(0, 2).toUpperCase()}</span>;
}

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState('');
  const [enroll, setEnroll] = useState(false);
  const [codeStep, setCodeStep] = useState(false);
  const [config, setConfig] = useState<AppConfig>({});
  const toast = useToast();

  useEffect(() => {
    refresh();
    loadConfig().then(setConfig);
    const expired = () => setUser((u) => { if (u) toast.error('Session expired — please sign in again'); return null; });
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the first factor (or an SSO redirect) the server says whether a code or enrolment is still needed.
  function refresh() {
    api.me()
      .then((u) => { setRole(u.role ?? ''); setEnroll(u.mfa === 'enroll'); setCodeStep(false); setUser(u.username); })
      .catch((e) => { setCodeStep((e as { code?: string }).code === 'MFA_REQUIRED'); setUser(null); });
  }

  if (user === undefined) return <div className="boot"><Spinner size={28} /></div>;
  if (user === null) return <Login key={codeStep ? 'code' : 'password'} onLogin={refresh} initialStep={codeStep ? 'code' : 'password'} />;
  const signOut = () => { api.logout().catch(() => { /* already gone */ }).finally(() => { setEnroll(false); setUser(null); }); };
  if (enroll) return <TwoStepGate user={user} onDone={refresh} onSignOut={signOut} />;
  return <Shell user={user} role={role} config={config} onLogout={() => setUser(null)} />;
}

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

function Shell({ user, role, config, onLogout }: { user: string; role: string; config: AppConfig; onLogout: () => void }) {
  const [twoStep, setTwoStep] = useState(false);
  const toast = useToast();
  // Which cluster and node are selected. Changing either remounts the page so every query starts afresh.
  const [sel, setSel] = useState({ cluster: selectedCluster(), node: selectedNode() });
  useEffect(() => {
    const f = () => setSel({ cluster: selectedCluster(), node: selectedNode() });
    window.addEventListener('cluster:changed', f);
    return () => window.removeEventListener('cluster:changed', f);
  }, []);
  const clusters = useQuery(api.clusters, [sel.cluster], 30_000);
  useEffect(() => {
    const d = clusters.data;
    if (!d) return;
    // First visit, or the remembered cluster no longer exists: settle on the server's current one.
    if (!sel.cluster || !d.clusters.some((c) => c.id === sel.cluster)) select(d.current);
  }, [clusters.data, sel.cluster]);
  // A risky action that needs a second person's approval: tell the user where to follow it up.
  useEffect(() => {
    const f = (e: Event) => {
      const a = (e as CustomEvent<{ summary?: string; status?: string }>).detail;
      toast.success(a?.status === 'approved' ? 'Approved: open Access > Approvals and press Run' : `Waiting for approval: ${a?.summary ?? 'this action'}. It is listed under Access > Approvals.`);
    };
    window.addEventListener('approval:required', f);
    return () => window.removeEventListener('approval:required', f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const features = useQuery(api.features, [], 0);
  const NAV = useMemo(() => ALL_NAV.filter((n) => !n.feature || features.data?.[n.feature]), [features.data]);
  const GROUPS = useMemo(() => [...new Set(NAV.map((n) => n.group))], [NAV]);
  const [tick, setTick] = useState(0);
  const [spin, setSpin] = useState(false);
  const bump = useCallback(() => { setTick((t) => t + 1); setSpin(true); setTimeout(() => setSpin(false), 700); }, []);
  const [theme, setTheme] = useState<ThemePref>(() => {
    try { return (localStorage.getItem('theme-pref') as ThemePref) || 'system'; } catch { return 'system'; }
  });
  const parts = useHash();
  const page = parts[0] || 'overview';

  // "system" tracks the OS; "light"/"dark" pin it. Follows live OS changes when on system.
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? systemTheme() : theme; };
    apply();
    try { localStorage.setItem('theme-pref', theme); } catch { /* storage unavailable */ }
    if (theme !== 'system' || typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const cycleTheme = () => setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]);

  async function logout() {
    try { await api.logout(); } catch { /* cookie may already be gone */ }
    onLogout();
  }

  const current = NAV.find((n) => n.id === page) ?? NAV[0];
  const [q, setQ] = useState('');
  const pendingQ = useRef('');
  useEffect(() => { setQ(pendingQ.current); pendingQ.current = ''; }, [current.id]);
  const onSearch = (v: string) => { setQ(v); if (current.id === 'overview' && v) location.hash = '#/guests'; };

  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); }, [page]);
  useEffect(() => {
    if (!menu) return;
    const f = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [menu]);
  const [guests, setGuests] = useState<Guest[]>([]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  useEffect(() => {
    if (palette) api.guests().then(setGuests).catch(() => setGuests([]));
  }, [palette]);

  const commands = useMemo<Command[]>(() => {
    const go = (id: string, search = '') => () => { pendingQ.current = search; if (location.hash === `#/${id}`) setQ(search); else location.hash = `#/${id}`; };
    return [
      ...NAV.map((n) => ({ id: `nav-${n.id}`, label: n.label, group: 'Go to', icon: n.icon, run: go(n.id) })),
      { id: 'act-refresh', label: 'Refresh data', group: 'Actions', icon: 'refresh', run: bump },
      { id: 'act-theme', label: `Theme: ${THEME_LABEL[theme].replace(' theme', '')} — switch`, group: 'Actions', icon: THEME_ICON[theme], run: cycleTheme },
      { id: 'act-logout', label: 'Sign out', group: 'Actions', icon: 'logout', run: logout },
      ...guests.map((g) => ({ id: `guest-${g.vmid}`, label: g.name, hint: `${g.type} ${g.vmid} · ${g.status}`, group: 'Guests', icon: 'server' as const, run: go(`guests/${g.vmid}`) })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guests, theme, bump]);

  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('nav') === 'mini'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('nav', collapsed ? 'mini' : 'full'); } catch { /* storage unavailable */ } }, [collapsed]);
  const inc = useQuery(api.incidents, [], 30_000);
  const alerts = inc.data?.filter((i) => i.status === 'down').length ?? 0;
  const crumbs = [current.group, current.label, ...(page === 'guests' && parts[1] ? [`#${parts[1]}`] : [])];

  return (
    <RefreshCtx.Provider value={{ tick, bump }}>
     <SearchCtx.Provider value={{ q, setQ }}>
      <div className={`app ${collapsed ? 'mini' : ''} ${menu ? 'drawer' : ''}`}>
        <aside className="side" aria-label="Primary">
          <div className="side-brand">
            <a href="#/overview" aria-label="homedash, overview" className="side-logo">
              <Logo className="side-wordmark" />
              <img className="side-mark" src="./brand/favicon.svg" alt="" aria-hidden="true" width={30} height={30} />
            </a>
          </div>
          <nav className="side-nav">
            {GROUPS.map((grp) => (
              <div key={grp} className="side-group">
                <p className="side-label">{grp}</p>
                {NAV.filter((n) => n.group === grp).map((n) => (
                  <a key={n.id} href={`#/${n.id}`} title={collapsed ? n.label : undefined} className={`side-link ${current.id === n.id ? 'active' : ''}`} aria-current={current.id === n.id ? 'page' : undefined}>
                    <Icon name={n.icon} size={18} /><span>{n.label}</span>
                    {n.id === 'kuma' && alerts > 0 && <em className="side-count">{alerts}</em>}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <button className="side-link" onClick={cycleTheme} title="Cycle System / Light / Dark"><Icon name={THEME_ICON[theme]} size={18} /><span>{THEME_LABEL[theme]}</span></button>
            <button className="side-link hide-sm" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><span className={`chev ${collapsed ? 'flip' : ''}`}><Icon name="back" size={18} /></span><span>Collapse</span></button>
          </div>
        </aside>
        <div className="side-scrim" onClick={() => setMenu(false)} />

        <div className="main">
          <header className="topbar">
            <button className="icon-btn show-sm" onClick={() => setMenu(true)} aria-label="Open navigation"><Icon name="list" /></button>
            <ol className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((c, i) => <li key={i} className={i === crumbs.length - 1 ? 'cur' : ''}>{c}</li>)}
            </ol>
            <ClusterPicker data={clusters.data} cluster={sel.cluster} node={sel.node} />
            <label className="search topsearch hide-sm">
              <Icon name="search" size={16} />
              <input value={q} onChange={(e) => onSearch(e.target.value)} placeholder={SEARCH_HINT[current.id]} aria-label="Search" />
              {q ? <button onClick={() => setQ('')} aria-label="Clear search"><Icon name="x" size={14} /></button> : <kbd onClick={() => setPalette(true)}>Ctrl K</kbd>}
            </label>
            <div className="head-actions">
              <button className="icon-btn show-sm" onClick={() => setPalette(true)} aria-label="Search"><Icon name="search" size={17} /></button>
              <button className="icon-btn" onClick={bump} aria-label="Refresh data" title="Refresh"><span className={spin ? 'spin' : ''}><Icon name="refresh" size={17} /></span></button>
              <a className="icon-btn bell" href="#/kuma" aria-label={`${alerts} monitors down`} title={alerts ? `${alerts} monitor${alerts === 1 ? '' : 's'} down` : 'No active incidents'}>
                <Icon name="bell" size={17} />{alerts > 0 && <i className="bell-dot">{alerts}</i>}
              </a>
              <div className="me">
                <Avatar user={user} />
                <div className="hide-sm"><b>{user}</b><small>{ROLE_LABEL[role] ?? 'Administrator'}</small></div>
                {features.data?.mfa && <button className="icon-btn" onClick={() => setTwoStep(true)} aria-label="Two-step sign-in" title="Two-step sign-in"><Icon name="lock" size={17} /></button>}
                <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out"><Icon name="logout" size={17} /></button>
              </div>
            </div>
          </header>

          <main className="content" key={`${parts.join('/')}|${sel.cluster}|${sel.node}`}>
            {page === 'overview' && <Overview />}
            {page === 'node' && <Node tab={parts[1]} />}
            {page === 'guests' && (parts[1] && /^\d+$/.test(parts[1]) ? <GuestDetail vmid={Number(parts[1])} tab={parts[2]} /> : <Guests />)}
            {page === 'tasks' && <Tasks />}
            {page === 'cluster' && <Nodes />}
            {page === 'gpu' && <Gpu />}
            {page === 'diagnostics' && <Diagnostics />}
            {page === 'scenes' && <Scenes />}
            {page === 'health' && <Health />}
            {page === 'protection' && <Protection />}
            {page === 'capacity' && <Capacity />}
            {page === 'netmap' && <Netmap />}
            {page === 'nginx' && <Nginx />}
            {page === 'grafana' && <Grafana uid={parts[1]} />}
            {page === 'kuma' && <Kuma statusUrl={config.kumaStatusUrl} />}
            {page === 'logs' && <Logs />}
            {page === 'notifications' && <Notifications role={role} />}
            {page === 'access' && <Access role={role} user={user} />}
            {page === 'crowdsec' && <Crowdsec />}
            {page === 'data' && <Data parts={parts.slice(1)} />}
            {page === 'llama' && <Llama />}
            {page === 'tiles' && <Tiles role={role} />}
            {!NAV.some((n) => n.id === page) && <Overview />}
          </main>
        </div>
      </div>
      {twoStep && <TwoStepSheet user={user} onClose={() => setTwoStep(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
     </SearchCtx.Provider>
    </RefreshCtx.Provider>
  );
}
