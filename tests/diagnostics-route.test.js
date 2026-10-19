'use strict';
// Diagnostics route: secret-free snapshot plus a gzip export that lands in the
// workspace diagnostics directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-diagnostics-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });

const backend = require('../dist/main/server');
let server;
let endpoint;
let token;

test.before(async () => {
  server = await backend.startServer(0, false);
  endpoint = `http://127.0.0.1:${server.address().port}`;
  token = backend.getServerCredentials(server).token;
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  assert.equal(path.dirname(directory), os.tmpdir());
  fs.rmSync(directory, { recursive: true, force: true });
});

function auth(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

test('GET /api/diagnostics returns a secret-free runtime snapshot', async () => {
  const response = await fetch(`${endpoint}/api/diagnostics`, { headers: auth() });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.app.name, 'IEXA-WIN');
  assert.ok(body.app.node);
  assert.ok(body.app.platform);
  assert.ok(body.scope.workspace);
  assert.equal(typeof body.metrics, 'object');
  assert.ok(body.counts && Number.isFinite(body.counts.sessions));

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /apiKey|secret|password|bearer/i);
});

test('POST /api/diagnostics/export writes a readable gzip bundle', async () => {
  const response = await fetch(`${endpoint}/api/diagnostics/export`, { method: 'POST', headers: auth() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.bytes > 0);
  assert.ok(fs.existsSync(body.path));

  const parsed = JSON.parse(gunzipSync(fs.readFileSync(body.path)).toString('utf8'));
  assert.equal(parsed.app.name, 'IEXA-WIN');
  assert.equal(typeof parsed.metrics, 'object');
  assert.ok(parsed.generatedAt);
});

test('diagnostics routes require the local token', async () => {
  const anonymous = await fetch(`${endpoint}/api/diagnostics`);
  assert.ok([401, 403].includes(anonymous.status), `unexpected status ${anonymous.status}`);
});
