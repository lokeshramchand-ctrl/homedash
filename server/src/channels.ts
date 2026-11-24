// Alert delivery channels. notify.ts decides WHAT to send and WHEN (categories, mute, de-duplication, hourly cap);
// each adapter here only knows HOW to deliver one message to one service.
//
//   ntfy, Gotify, Discord, Slack, Telegram, e-mail (SMTP), Apprise (one URL that fans out to ~80 services),
//   and a generic JSON webhook for anything else.
//
// Credentials come from the server settings (homedash.yaml renders them to the variables named in each adapter).
// Nothing secret is ever returned by the API: describe() masks the target.
import nodemailer from 'nodemailer';
import { cfg } from './config.js';

export type Level = 'info' | 'warn' | 'error';
export interface Msg { title: string; message: string; level: Level; category: string; priority: number; tags: string[]; clickUrl?: string }
export interface Channel {
  id: string;
  label: string;
  /** Which settings must be present for this channel to exist. */
  needs: string;
  configured(): boolean;
  /** A short, non-secret description of where messages go (shown in the UI). */
  target(): string;
  send(m: Msg): Promise<void>;
}

const TIMEOUT = 10_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const EMOJI: Record<Level, string> = { error: '🔴', warn: '🟠', info: '🟢' };
const COLOR: Record<Level, number> = { error: 0xe5484d, warn: 0xf5a524, info: 0x30a46c };

async function http(name: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new Error(`${name} unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`${name} ${res.status}: ${clip((await res.text().catch(() => '')).replace(/\s+/g, ' '), 140)}`);
  return res;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** Host part only, so the UI can say where a webhook goes without exposing its secret path. */
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return 'configured'; } };

const c = cfg.channels;

export const CHANNELS: Channel[] = [
  {
    id: 'ntfy', label: 'ntfy', needs: 'ntfy.url, ntfy.topic',
    configured: () => !!(cfg.ntfy.url && cfg.ntfy.topic),
    target: () => `${hostOf(cfg.ntfy.url)} / ${cfg.ntfy.topic}`,
    send: async (m) => {
      await http('ntfy', `${cfg.ntfy.url}/`, {
        ...json({ topic: cfg.ntfy.topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags, ...(cfg.ntfy.clickUrl ? { click: cfg.ntfy.clickUrl } : {}) }),
        headers: { 'Content-Type': 'application/json', ...(cfg.ntfy.token ? { Authorization: `Bearer ${cfg.ntfy.token}` } : {}) },
      });
    },
  },
  {
    id: 'gotify', label: 'Gotify', needs: 'gotify.url, gotify.token',
    configured: () => !!(c.gotify.url && c.gotify.token),
    target: () => hostOf(c.gotify.url),
    // Gotify priority: 0-10, notifications on phones start at 5.
    send: async (m) => {
      await http('Gotify', `${c.gotify.url}/message`, {
        ...json({ title: m.title, message: m.message, priority: m.level === 'error' ? 8 : m.level === 'warn' ? 5 : 2, extras: { 'client::display': { contentType: 'text/plain' } } }),
        headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': c.gotify.token },
      });
    },
  },
  {
    id: 'discord', label: 'Discord', needs: 'discord.webhook_url',
    configured: () => /^https:\/\/([a-z]+\.)?discord(app)?\.com\/api\/webhooks\//.test(c.discord.webhookUrl),
    target: () => 'webhook',
    send: async (m) => {
      await http('Discord', c.discord.webhookUrl, json({
        username: c.discord.username || 'homedash',
        allowed_mentions: { parse: [] }, // alert text must never ping @everyone
        embeds: [{ title: clip(`${EMOJI[m.level]} ${m.title}`, 256), description: clip(m.message, 3800), color: COLOR[m.level], timestamp: new Date().toISOString(), footer: { text: `homedash · ${m.category}` }, ...(m.clickUrl ? { url: m.clickUrl } : {}) }],
      }));
    },
  },
  {
    id: 'slack', label: 'Slack', needs: 'slack.webhook_url',
    configured: () => /^https:\/\/hooks\.slack(-gov)?\.com\//.test(c.slack.webhookUrl),
    target: () => 'incoming webhook',
    send: async (m) => {
      await http('Slack', c.slack.webhookUrl, json({
        text: `${EMOJI[m.level]} ${m.title}: ${m.message}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: clip(`${EMOJI[m.level]} ${m.title}`, 150), emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: clip(m.message.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!), 2900) } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `homedash · ${m.category}` }] },
        ],
      }));
    },
  },
  {
    id: 'telegram', label: 'Telegram', needs: 'telegram.bot_token, telegram.chat_id',
    configured: () => !!(c.telegram.botToken && c.telegram.chatId),
    target: () => `chat ${c.telegram.chatId}`,
    send: async (m) => {
      const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
      await http('Telegram', `https://api.telegram.org/bot${c.telegram.botToken}/sendMessage`, json({
        chat_id: c.telegram.chatId, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: m.level === 'info',
        text: clip(`${EMOJI[m.level]} <b>${esc(m.title)}</b>\n${esc(m.message)}`, 4000),
      }));
    },
  },
  {
    id: 'email', label: 'E-mail (SMTP)', needs: 'email.host, email.from, email.to',
    configured: () => !!(c.email.host && c.email.from && c.email.to.length),
    target: () => c.email.to.join(', '),
    send: async (m) => {
      const tx = nodemailer.createTransport({
        host: c.email.host, port: c.email.port, secure: c.email.secure, requireTLS: !c.email.secure && c.email.starttls,
        ...(c.email.user ? { auth: { user: c.email.user, pass: c.email.password } } : {}),
        tls: { rejectUnauthorized: !c.email.insecureTls }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 20_000,
      });
      try {
        await tx.sendMail({
          from: c.email.from, to: c.email.to, subject: `[homedash] ${m.title}`.replace(/[\r\n]+/g, ' '),
          text: `${m.message}\n\nCategory: ${m.category}\nLevel: ${m.level}\nTime: ${new Date().toISOString()}${m.clickUrl ? `\n${m.clickUrl}` : ''}\n`,
          headers: { 'X-Priority': m.level === 'error' ? '1' : m.level === 'warn' ? '2' : '4', 'Auto-Submitted': 'auto-generated' },
        });
      } catch (e) {
        throw new Error(`SMTP: ${clip((e as Error).message, 160)}`);
      } finally { tx.close(); }
    },
  },
  {
    id: 'apprise', label: 'Apprise', needs: 'apprise.url (+ key or urls)',
    configured: () => !!(c.apprise.url && (c.apprise.key || c.apprise.urls.length)),
    target: () => (c.apprise.key ? `${hostOf(c.apprise.url)} / ${c.apprise.key}` : `${hostOf(c.apprise.url)} (${c.apprise.urls.length} targets)`),
    // Apprise API: POST /notify/<key> for saved configurations, or POST /notify with an urls list for stateless use.
    send: async (m) => {
      const type = m.level === 'error' ? 'failure' : m.level === 'warn' ? 'warning' : 'success';
      const path = c.apprise.key ? `/notify/${encodeURIComponent(c.apprise.key)}` : '/notify';
      await http('Apprise', `${c.apprise.url}${path}`, json({
        title: m.title, body: m.message, type, format: 'text', ...(c.apprise.tag ? { tag: c.apprise.tag } : {}),
        ...(c.apprise.key ? {} : { urls: c.apprise.urls.join(',') }),
      }));
    },
  },
  {
    id: 'webhook', label: 'Webhook (JSON)', needs: 'webhook.url',
    configured: () => /^https?:\/\//.test(c.webhook.url),
    target: () => hostOf(c.webhook.url),
    send: async (m) => {
      await http('Webhook', c.webhook.url, {
        ...json({ source: 'homedash', title: m.title, message: m.message, level: m.level, category: m.category, priority: m.priority, time: new Date().toISOString() }),
        headers: { 'Content-Type': 'application/json', ...(c.webhook.secret ? { Authorization: `Bearer ${c.webhook.secret}` } : {}) },
      });
    },
  },
];

export const channelById = (id: string) => CHANNELS.find((x) => x.id === id);
export const anyChannelConfigured = () => CHANNELS.some((x) => x.configured());
