import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api, looksLikeToken, normalizeUrl, setBaseUrl, setExpiredHandler, setToken } from './api';

const KEY = 'serverUrl';
const TOKEN_KEY = 'apiToken';

type Status = 'loading' | 'out' | 'in';

interface Session {
  status: Status;
  user: string | null;
  serverUrl: string;
  notice: string | null;
  signIn: (url: string, username: string, password: string) => Promise<void>;
  signInWithToken: (url: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export const useSession = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setExpiredHandler(() => {
      setUser(null);
      setStatus((s) => { if (s === 'in') setNotice('Session expired. Please sign in again.'); return 'out'; });
    });
    (async () => {
      let saved = '';
      try { saved = (await SecureStore.getItemAsync(KEY)) ?? ''; } catch { /* storage unavailable */ }
      if (!saved) { setStatus('out'); return; }
      setServerUrl(saved);
      setBaseUrl(saved);
      try { setToken((await SecureStore.getItemAsync(TOKEN_KEY)) ?? ''); } catch { /* no saved token */ }
      try {
        const me = await api.me();
        setUser(me.username);
        setStatus('in');
      } catch {
        setStatus('out');
      }
    })();
  }, []);

  const signIn = useCallback(async (rawUrl: string, username: string, password: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('Enter your dashboard address');
    setBaseUrl(url);
    const r = await api.login(username.trim(), password);
    try { await SecureStore.setItemAsync(KEY, url); } catch { /* remembered next time only if storage works */ }
    setServerUrl(url);
    setNotice(null);
    setUser(r.username);
    setStatus('in');
  }, []);

  const signInWithToken = useCallback(async (rawUrl: string, rawToken: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('Enter your dashboard address');
    if (!looksLikeToken(rawToken)) throw new Error('That does not look like a homedash API token (it starts with hd_)');
    setBaseUrl(url);
    setToken(rawToken);
    let me: { username: string };
    try { me = await api.me(); } catch (e) { setToken(''); throw e; }
    try { await SecureStore.setItemAsync(KEY, url); await SecureStore.setItemAsync(TOKEN_KEY, rawToken.trim()); } catch { /* remembered next time only if storage works */ }
    setServerUrl(url);
    setNotice(null);
    setUser(me.username);
    setStatus('in');
  }, []);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* cookie may already be gone */ }
    setToken('');
    try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch { /* nothing stored */ }
    setUser(null);
    setNotice(null);
    setStatus('out');
  }, []);

  const value = useMemo(() => ({ status, user, serverUrl, notice, signIn, signInWithToken, signOut }), [status, user, serverUrl, notice, signIn, signInWithToken, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
