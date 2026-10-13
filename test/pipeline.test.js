import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCode } from '../src/pipeline.js';
import { buildReport } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (n) => fs.readFile(path.join(here, 'fixtures', n), 'utf8');
const opts = { rename: true, prettier: false };

async function analyse(name) {
  const r = await processCode(name, await read(name), opts);
  assert.equal(r.error, null, r.error ?? '');
  return { r, report: buildReport({ input: name, loaded: { notes: [], origin: null }, results: [r], sourceResults: [], opts }) };
}

test('axios client: endpoints, params, bodies, responses', async () => {
  const { report } = await analyse('axios-app.js');
  const find = (m, p) => report.json.endpoints.find((e) => e.method === m && e.path === p);

  const list = find('GET', '/v2/users') ?? find('GET', '/users');
  assert.ok(list, 'GET /users');
  assert.deepEqual(list.query.map((q) => q.name).sort(), ['page', 'per_page']);

  const one = report.json.endpoints.find((e) => e.method === 'GET' && /\/users\/\{\w+\}$/.test(e.path));
  assert.ok(one, 'GET /users/{id}');
  assert.ok(one.response.some((f) => f.startsWith('data')));

  const create = report.json.endpoints.find((e) => e.method === 'POST' && /\/users$/.test(e.path));
  assert.ok(create, 'POST /users');
  assert.deepEqual(create.body.map((b) => b.name).sort(), ['admin', 'email', 'name', 'tags']);
  assert.equal(create.body.find((b) => b.name === 'admin').type, 'boolean');

  const del = report.json.endpoints.find((e) => e.method === 'DELETE');
  assert.ok(del);

  const up = report.json.endpoints.find((e) => /\/internal\/upload$/.test(e.path));
  assert.ok(up, 'upload');
  assert.equal(up.contentType, 'multipart/form-data');
  assert.deepEqual(up.body.map((b) => b.name).sort(), ['file', 'kind']);
});

test('fetch with template url, xhr, websocket', async () => {
  const { report } = await analyse('axios-app.js');
  const s = report.json.endpoints.find((e) => e.path.startsWith('https://search.example.test/q'));
  assert.ok(s);
  assert.deepEqual(s.query.map((q) => q.name).sort(), ['lang', 'term']);
  assert.ok(s.response.includes('hits[].title'));
  assert.ok(report.json.endpoints.some((e) => e.method === 'PUT' && e.path === '/legacy/save'));
  assert.ok(report.json.realtime.some((w) => w.type === 'websocket' && w.url === 'wss://rt.example.test/socket'));
});

test('routes, env, secrets, storage, graphql, ui text, libraries', async () => {
  const { report } = await analyse('axios-app.js');
  const j = report.json;
  const routes = j.routes.map((r) => r.path);
  assert.ok(routes.includes('/login'));
  assert.ok(routes.includes('/settings/billing'), routes.join(','));
  assert.ok(j.env.includes('VITE_API_URL'));
  assert.ok(j.secrets.some((s) => s.kind === 'Google API key'));
  assert.ok(j.secrets.some((s) => s.kind.includes('password')));
  assert.ok(j.storage.some((s) => s.key === 'auth.token'));
  assert.ok(j.graphql.some((g) => g.name === 'GetUser'));
  assert.ok(j.uiText.includes('Save changes'));
  assert.ok('lodash-es' in j.libraries);
});

test('deminification: booleans, sequences, useState naming', async () => {
  const { r } = await analyse('axios-app.js');
  assert.ok(!/!1\b/.test(r.decoded.replace(/!1e/g, '')), 'no !1 left');
  assert.match(r.decoded, /const \[value, setValue\] = React\.useState\(null\)/);
  assert.match(r.decoded, /const \[flag, setFlag\] = React\.useState\(false\)/);
});

test('invalid input does not throw', async () => {
  const r = await processCode('broken.js', 'function ((( {', opts);
  assert.ok(r.decoded !== null);
});
