'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleRuntimeRoute } = require('../dist/main/api/RuntimeRoutes');
const { QuestionBroker } = require('../dist/main/runtime/QuestionBroker');

function makeContext(questionBroker) {
  return {
    agents: new Map(),
    permissionBroker: { list: () => [], resolve: () => false, cancelSession: () => {} },
    permissionPayload: (item) => item,
    questionBroker,
    questionPayload: (item) => ({ id: item.id, sessionId: item.sessionId, title: item.title, questions: item.questions, createdAt: item.createdAt, expiresAt: item.expiresAt }),
    getPermissionMode: () => 'risk',
    setPermissionMode: () => {},
    normalizePermissionMode: (value) => value,
    loadJobs: () => [],
    readTraces: () => [],
    cancelSession: () => {},
    clearRunningSession: () => {},
    cancelLiveJobs: () => {},
  };
}

async function startServer(t, context) {
  const server = http.createServer((req, res) => {
    handleRuntimeRoute(req, res, new URL(req.url, 'http://localhost'), context)
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error) => res.writeHead(500).end(error.message));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const question = { id: 'q1', question: 'Q?', options: [], multiSelect: false, allowFreeText: true, kind: 'text' };

test('POST /api/questions/answer resolves the pending ask_user wait', async (t) => {
  const broker = new QuestionBroker();
  const base = await startServer(t, makeContext(broker));
  const pending = broker.request({ sessionId: 's', title: '标题', questions: [question] });

  const listRes = await fetch(`${base}/api/questions?sessionId=s`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.questions.length, 1);
  assert.equal(listData.questions[0].title, '标题');
  const id = listData.questions[0].id;

  const answerRes = await fetch(`${base}/api/questions/answer`, {
    method: 'POST',
    body: JSON.stringify({ id, answers: [{ id: 'q1', selected: [], freeText: 'ok' }] }),
  });
  assert.equal(answerRes.status, 200);
  assert.deepEqual(await answerRes.json(), { ok: true, id });
  assert.deepEqual(await pending, [{ id: 'q1', selected: [], freeText: 'ok', skipped: false }]);

  const missing = await fetch(`${base}/api/questions/answer`, {
    method: 'POST',
    body: JSON.stringify({ id: 'nope', answers: [{ id: 'q1' }] }),
  });
  assert.equal(missing.status, 404);

  const empty = await fetch(`${base}/api/questions/answer`, { method: 'POST', body: JSON.stringify({ id: 'nope', answers: [] }) });
  assert.equal(empty.status, 400);
});

test('POST /api/questions/cancel resolves the pending wait as unanswered', async (t) => {
  const broker = new QuestionBroker();
  const base = await startServer(t, makeContext(broker));
  const pending = broker.request({ sessionId: 's', title: 'T', questions: [question] });
  const id = broker.list('s')[0].id;

  const cancelRes = await fetch(`${base}/api/questions/cancel`, { method: 'POST', body: JSON.stringify({ id }) });
  assert.equal(cancelRes.status, 200);
  assert.deepEqual(await cancelRes.json(), { ok: true, id });
  assert.equal(await pending, null);

  const again = await fetch(`${base}/api/questions/cancel`, { method: 'POST', body: JSON.stringify({ id }) });
  assert.equal(again.status, 404);
});
