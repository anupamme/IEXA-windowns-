'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');

/* Token usage records must be individually removable and clearable, so stale
   model rows never pile up forever. This boots the real server against a
   fixture workspace and drives the real DELETE routes over HTTP. */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-token-usage-delete-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const usageFile = path.join(process.env.IEXA_WORKSPACE, '.iexa-token-usage.json');
const seeded = [
  { key: 'openai:model-a:p1', profileId: 'p1', profileName: 'A', provider: 'openai', model: 'model-a', inputTokens: 10, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, requests: 1, estimatedCostUsd: null, updatedAt: 2 },
  { key: 'openai:model-b:p2', profileId: 'p2', profileName: 'B', provider: 'openai', model: 'model-b', inputTokens: 20, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, requests: 2, estimatedCostUsd: null, updatedAt: 1 },
];
fs.mkdirSync(process.env.IEXA_WORKSPACE, { recursive: true });
fs.writeFileSync(usageFile, JSON.stringify(seeded));

const backend = require('../dist/main/server');
let server, endpoint, token;
test.before(async () => {
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  assert.equal(path.dirname(directory), os.tmpdir());
  fs.rmSync(directory, { recursive: true, force: true });
});
async function api(route, method = 'GET') {
  const response = await fetch(endpoint + route, { method, headers: { Authorization: 'Bearer ' + token } });
  return { status: response.status, body: await response.json() };
}

test('single-record delete removes exactly one model row and clear-all empties the page', async () => {
  const before = await api('/api/token-usage');
  assert.equal(before.status, 200);
  assert.equal(before.body.records.length, 2);

  const single = await api('/api/token-usage/' + encodeURIComponent('openai:model-a:p1'), 'DELETE');
  assert.equal(single.status, 200);
  assert.deepEqual(single.body, { ok: true, removed: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(usageFile, 'utf8')).map((record) => record.key), ['openai:model-b:p2']);

  const after = await api('/api/token-usage');
  assert.equal(after.body.records.length, 1);
  assert.equal(after.body.records[0].key, 'openai:model-b:p2');

  const missing = await api('/api/token-usage/' + encodeURIComponent('custom:nope:p9'), 'DELETE');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { ok: true, removed: 0 });

  const cleared = await api('/api/token-usage', 'DELETE');
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { ok: true, cleared: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(usageFile, 'utf8')), []);

  const empty = await api('/api/token-usage');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.records, []);
});

test('malformed record keys are rejected without touching stored records', async () => {
  fs.writeFileSync(usageFile, JSON.stringify([seeded[0]]));
  const raw = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/token-usage/%E0%A4%A', method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(raw.status, 400);
  assert.equal(raw.body.error, '无效的记录标识。');
  assert.equal(JSON.parse(fs.readFileSync(usageFile, 'utf8')).length, 1);
});
