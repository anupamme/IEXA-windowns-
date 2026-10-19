const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-search-api-'));
process.env.IEXA_WORKSPACE = path.join(fixture, 'workspace');
fs.mkdirSync(process.env.IEXA_WORKSPACE);
const backend = require('../dist/main/server');
let server, port, token;

function request(route, method = 'GET', body, auth = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test.before(async () => {
  server = await backend.startServer(0, false);
  port = server.address().port;
  token = backend.getServerCredentials(server).token;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
});

async function createSession(title, messages) {
  const made = await request('/api/sessions', 'POST');
  assert.equal(made.status, 200);
  const session = made.data.session;
  if (title) await request(`/api/sessions/${session.id}`, 'PUT', { title });
  fs.writeFileSync(
    path.join(process.env.IEXA_WORKSPACE, '.iexa-sessions', `${session.id}.json`),
    JSON.stringify(messages),
  );
  return session;
}

test('search returns message hits with offsets and timing', async () => {
  const session = await createSession('注入分析', [
    { role: 'user', content: '帮我梳理 SQL 注入的边界测试', timestamp: 1000 },
    { role: 'assistant', content: '先确认参数解析路径，再做 payload 变体。', timestamp: 2000 },
  ]);

  const response = await request('/api/search?q=' + encodeURIComponent('注入'));
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.tookMs, 'number');
  const hit = response.data.results.find(item => item.session.id === session.id);
  assert.ok(hit, 'expected the session to match');
  assert.equal(hit.matches[0].role, 'user');
  assert.equal(hit.matches[0].index, 0);
  assert.equal(hit.matches[0].timestamp, 1000);
  assert.match(hit.matches[0].snippet, /注入/);
});

test('search still matches titles and marks them', async () => {
  const session = await createSession('Pelican Bicycle', [
    { role: 'user', content: 'unrelated body', timestamp: 1 },
  ]);
  const response = await request('/api/search?q=pelican');
  const hit = response.data.results.find(item => item.session.id === session.id);
  assert.ok(hit);
  assert.equal(hit.matches[0].role, 'title');
  assert.equal(hit.matches[0].index, -1);
  assert.match(hit.matches[0].snippet, /📝/);
});

test('empty query is a no-op and unauthenticated access is rejected', async () => {
  const empty = await request('/api/search?q=');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.results, []);
  assert.equal((await request('/api/search?q=test', 'GET', undefined, false)).status, 401);
});

test('a search builds a bounded on-disk index', async () => {
  await request('/api/search?q=payload');
  const dir = path.join(process.env.IEXA_WORKSPACE, '.iexa-search-index');
  assert.ok(fs.existsSync(dir));
  const records = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  assert.ok(records.length >= 1);
  for (const name of records) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.equal(record.v, 1);
    assert.ok(Array.isArray(record.messages));
    // Tool payloads are stripped: only role/content text is retained.
    for (const entry of record.messages) assert.equal(entry.length, 4);
  }
});
