import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenApi } from '../build/openapi.js';

const routes = [
  { method: 'GET', url: '/api/guests' },
  { method: 'POST', url: '/api/guests/:vmid/start' },
  { method: 'GET', url: '/api/admin/setup' },
  { method: 'POST', url: '/api/auth/login' },
  { method: 'DELETE', url: '/api/nginx/sites/:name' },
  { method: 'GET', url: '/status' },
  { method: 'GET', url: '/assets/*' },
];

test('only /api routes appear, with path parameters in OpenAPI form', () => {
  const d = buildOpenApi(routes, '9.9.9');
  assert.equal(d.openapi, '3.0.3');
  assert.equal(d.info.version, '9.9.9');
  assert.deepEqual(Object.keys(d.paths).sort(), ['/api/admin/setup', '/api/auth/login', '/api/guests', '/api/guests/{vmid}/start', '/api/nginx/sites/{name}']);
  assert.deepEqual(d.paths['/api/guests/{vmid}/start'].post.parameters, [{ name: 'vmid', in: 'path', required: true, schema: { type: 'string' } }]);
});

test('each operation names the lowest role that may call it, from the same rules the server enforces', () => {
  const p = buildOpenApi(routes, 'x').paths;
  assert.equal(p['/api/guests'].get['x-required-role'], 'viewer');
  assert.equal(p['/api/guests/{vmid}/start'].post['x-required-role'], 'operator');
  assert.equal(p['/api/admin/setup'].get['x-required-role'], 'admin');
  assert.equal(p['/api/nginx/sites/{name}'].delete['x-required-role'], 'admin');
});

test('sign-in is marked as needing no credentials; everything else inherits the global security', () => {
  const p = buildOpenApi(routes, 'x').paths;
  assert.deepEqual(p['/api/auth/login'].post.security, []);
  assert.equal(p['/api/guests'].get.security, undefined);
});
