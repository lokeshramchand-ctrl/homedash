import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { after, before, test } from 'node:test';

const got = []; // everything the mock HTTP server receives
let http, smtp, base;
const smtpMail = [];

before(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url.startsWith('/fail')) { res.statusCode = 500; res.end('boom'); return; }
      res.end('{}');
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${http.address().port}`;

  // A tiny SMTP server: no TLS, no auth, just enough protocol for nodemailer to deliver one message.
  smtp = createTcp((sock) => {
    let data = false, buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (data) { if (buf.endsWith('\r\n.\r\n')) { smtpMail.push(buf); buf = ''; data = false; sock.write('250 queued\r\n'); } return; }
      for (const line of buf.split('\r\n').slice(0, -1)) {
        const l = line.toUpperCase();
        if (l.startsWith('EHLO') || l.startsWith('HELO')) sock.write('250 test\r\n');
        else if (l.startsWith('MAIL') || l.startsWith('RCPT')) sock.write('250 ok\r\n');
        else if (l === 'DATA') { sock.write('354 go\r\n'); data = true; buf = ''; return; }
        else if (l === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
      buf = '';
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    NTFY_URL: base, NTFY_TOPIC: 'alerts', NTFY_TOKEN: 'tok',
    GOTIFY_URL: `${base}/gotify`, GOTIFY_TOKEN: 'gkey',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-100',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_STARTTLS: 'false', SMTP_FROM: 'homedash@example.com', SMTP_TO: 'a@example.com, b@example.com',
    APPRISE_URL: `${base}/apprise`, APPRISE_KEY: 'lab',
    WEBHOOK_URL: `${base}/hook`, WEBHOOK_SECRET: 'sek',
  });
});
after(() => { http.close(); smtp.close(); });

const msg = { title: 'DOWN · Guest', message: 'web <1> & co stopped', level: 'error', category: 'guest', priority: 5, tags: ['rotating_light'] };
const load = async () => (await import('../build/channels.js')).CHANNELS;
const byId = async (id) => (await load()).find((c) => c.id === id);

test('all eight channels are configured from the settings and none leaks a secret in target()', async () => {
  const ch = await load();
  assert.deepEqual(ch.map((c) => c.id), ['ntfy', 'gotify', 'discord', 'slack', 'telegram', 'email', 'apprise', 'webhook']);
  for (const c of ch) {
    assert.equal(c.configured(), true, c.id);
    for (const secret of ['tok', 'gkey', 'sek', '123:abc', 'webhooks/1']) assert.ok(!c.target().includes(secret), `${c.id} target shows ${secret}`);
  }
});

test('ntfy: JSON publish with bearer token', async () => {
  got.length = 0;
  await (await byId('ntfy')).send(msg);
  assert.equal(got[0].body.topic, 'alerts');
  assert.equal(got[0].body.priority, 5);
  assert.equal(got[0].headers.authorization, 'Bearer tok');
});

test('gotify: key header, error maps to a high priority', async () => {
  got.length = 0;
  await (await byId('gotify')).send(msg);
  assert.equal(got[0].url, '/gotify/message');
  assert.equal(got[0].headers['x-gotify-key'], 'gkey');
  assert.equal(got[0].body.priority, 8);
});

test('apprise: saved key route, failure type', async () => {
  got.length = 0;
  await (await byId('apprise')).send(msg);
  assert.equal(got[0].url, '/apprise/notify/lab');
  assert.equal(got[0].body.type, 'failure');
  assert.equal(got[0].body.urls, undefined);
});

test('webhook: generic JSON with bearer secret', async () => {
  got.length = 0;
  await (await byId('webhook')).send(msg);
  assert.equal(got[0].url, '/hook');
  assert.equal(got[0].headers.authorization, 'Bearer sek');
  assert.equal(got[0].body.source, 'homedash');
  assert.equal(got[0].body.level, 'error');
});

test('e-mail: delivers one message to every recipient with a safe subject', async () => {
  smtpMail.length = 0;
  await (await byId('email')).send({ ...msg, title: 'DOWN\r\nBcc: evil@example.com' });
  assert.equal(smtpMail.length, 1);
  assert.match(smtpMail[0], /Subject: \[homedash\] DOWN Bcc: evil@example.com/);
  assert.ok(!/^Bcc:/m.test(smtpMail[0]), 'header injection');
  assert.match(smtpMail[0], /a@example\.com/);
  assert.match(smtpMail[0], /b@example\.com/);
});

test('discord, slack, telegram: payloads (fetch stubbed) escape the message and never ping everyone', async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  try {
    await (await byId('discord')).send(msg);
    await (await byId('slack')).send(msg);
    await (await byId('telegram')).send(msg);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.match(calls[0].body.embeds[0].title, /DOWN/);
  assert.match(calls[1].body.blocks[1].text.text, /&lt;1&gt; &amp; co/);
  assert.equal(calls[2].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(calls[2].body.parse_mode, 'HTML');
  assert.match(calls[2].body.text, /&lt;1&gt; &amp; co/);
});

test('a failing service raises a readable error and does not echo secrets', async () => {
  const { cfg } = await import('../build/config.js');
  cfg.channels.gotify.url = `${base}/fail`;
  const g = await byId('gotify');
  await assert.rejects(() => g.send(msg), (e) => /Gotify 500: boom/.test(e.message) && !e.message.includes('gkey'));
});

test('an unreachable service reports which one failed', async () => {
  const { cfg } = await import('../build/config.js');
  cfg.channels.webhook.url = 'http://127.0.0.1:9/nope';
  await assert.rejects(() => byId('webhook').then((c) => c.send(msg)), /Webhook unreachable/);
});
