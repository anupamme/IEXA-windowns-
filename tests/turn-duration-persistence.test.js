'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

/* One real turn through the real server: the assistant record must carry the
   wall-clock duration the transcript counter displays, and the user record must
   not. */

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-turn-duration-'));
process.env.IEXA_WORKSPACE = path.join(directory, 'workspace');
const backend = require('../dist/main/server');
let server, upstream, endpoint, token, baseURL;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      if (!request.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture title' } }] }));
        return;
      }
      // Hold the stream open long enough for the measured duration to be
      // distinguishable from zero.
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fixture response' }, finish_reason: null }] }) +
          '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }, 400);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + upstream.address().port;
  server = await backend.startServer(0, false);
  endpoint = 'http://127.0.0.1:' + server.address().port;
  token = backend.getServerCredentials(server).token;
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const s of [server, upstream]) if (s) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function api(route, method = 'GET', data) {
  const response = await fetch(endpoint + route, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test('a completed turn persists its wall-clock duration', async () => {
  await api('/api/profiles', 'POST', {
    id: 'duration-profile', provider: 'custom', model: 'fixture-model', apiKey: 'FIXTURE-KEY',
    baseURL, contextWindow: 200000, maxOutputTokens: 1024,
  });
  const { session } = await api('/api/sessions', 'POST', {});

  const response = await fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, message: 'DURATION_PROBE' }),
  });
  assert.equal(response.status, 200);
  const streamed = await response.text();
  assert.match(streamed, /Fixture response/, streamed);

  const payload = await api('/api/sessions/' + session.id);
  const messages = Array.isArray(payload) ? payload : payload.messages;
  assert.ok(Array.isArray(messages) && messages.length >= 2, 'the turn was persisted: ' + JSON.stringify(payload).slice(0, 300));

  const assistant = messages.filter((m) => m.role === 'assistant').pop();
  assert.ok(assistant, 'assistant record present');
  assert.equal(typeof assistant.durationMs, 'number', 'assistant record carries durationMs: ' + JSON.stringify(assistant).slice(0, 300));
  assert.ok(assistant.durationMs >= 350, 'the duration covers the turn, not a single call: ' + assistant.durationMs);
  assert.ok(assistant.durationMs < 60000, 'the duration is a real wall clock: ' + assistant.durationMs);
  assert.equal(typeof assistant.timestamp, 'number', 'the record shape is otherwise unchanged');

  const user = messages.filter((m) => m.role === 'user').pop();
  assert.equal(user.durationMs, undefined, 'user records stay without a duration');
});
