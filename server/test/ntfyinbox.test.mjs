import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ntfyInbox, parseNtfyLines } from '../build/ntfyinbox.js';

// Lines follow ntfy's documented JSON message format; not captured from a live ntfy.
const body = [
  '{"id":"a1","time":1700000100,"event":"message","topic":"t","title":"Disk full","message":"root 93%","priority":4,"tags":["warning","disk"],"click":"https://dash.lan/#/node"}',
  '{"id":"open1","time":1700000000,"event":"open","topic":"t"}',
  '',
  'not json',
  '{"id":"b2","time":1700000200,"event":"message","topic":"t","message":"backup done","click":"javascript:alert(1)"}',
  '{"time":1,"event":"message","message":"no id"}',
  '{"id":"c3","time":1700000050,"event":"message","topic":"t","message":"x","priority":99,"tags":[1,"ok"]}',
].join('\n');

test('only real messages are kept, newest first', () => {
  assert.deepEqual(parseNtfyLines(body).map((m) => m.id), ['b2', 'a1', 'c3']);
});

test('fields are normalised: seconds to ms, default priority, missing title, string tags only', () => {
  const [b2, a1, c3] = parseNtfyLines(body);
  assert.equal(a1.time, 1700000100 * 1000);
  assert.equal(a1.priority, 4);
  assert.deepEqual(a1.tags, ['warning', 'disk']);
  assert.equal(b2.title, '');
  assert.equal(b2.priority, 3);
  assert.equal(c3.priority, 3);
  assert.deepEqual(c3.tags, ['ok']);
});

test('only http(s) click links survive, so a message cannot plant a javascript: link', () => {
  const m = Object.fromEntries(parseNtfyLines(body).map((x) => [x.id, x.click]));
  assert.equal(m.a1, 'https://dash.lan/#/node');
  assert.equal(m.b2, null);
});

test('keeps at most 100 messages and survives an empty body', () => {
  const many = Array.from({ length: 150 }, (_, i) => JSON.stringify({ id: `m${i}`, time: 1000 + i, event: 'message', message: 'x' })).join('\n');
  assert.equal(parseNtfyLines(many).length, 100);
  assert.equal(parseNtfyLines(many)[0].id, 'm149');
  assert.deepEqual(parseNtfyLines(''), []);
});

test('without ntfy settings the inbox says it is not configured', async () => {
  const r = await ntfyInbox();
  assert.equal(r.configured, false);
  assert.deepEqual(r.messages, []);
});
