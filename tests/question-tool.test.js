'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
const { QuestionBroker } = require('../dist/main/runtime/QuestionBroker');

function makeRuntime(t, questionResolver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-qcard-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const runtime = new ToolRuntime({ workspaceDir: dir, memoryDir: path.join(dir, 'memory'), questionResolver });
  runtime.registerDefaults();
  return { dir, runtime };
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('ask_user waits for the broker answer and feeds it back to the model', async (t) => {
  const broker = new QuestionBroker();
  const { dir, runtime } = makeRuntime(t, (request) => broker.request(request));
  const states = [];
  const exec = runtime.execute('ask_user', { tool_title: '部署确认', confirm: '继续吗？' }, {
    signal: new AbortController().signal, sessionId: 's', toolCallId: 'c1', workspaceDir: dir,
    onToolState: (event) => states.push(event.status),
  });
  await waitFor(() => broker.list('s').length === 1);
  const pending = broker.list('s')[0];
  assert.equal(pending.questions.length, 1);
  assert.equal(pending.questions[0].kind, 'confirm');
  assert.equal(pending.title, '部署确认');
  assert.equal(broker.resolve(pending.id, [{ id: 'q1', selected: ['确认'] }]), true);
  const result = await exec;
  assert.equal(result.success, true);
  assert.match(result.output, /确认/);
  assert.equal(states.at(-1), 'completed');
});

test('ask_user cancellation reports unanswered instead of retrying', async (t) => {
  const broker = new QuestionBroker();
  const { dir, runtime } = makeRuntime(t, (request) => broker.request(request));
  const controller = new AbortController();
  const exec = runtime.execute('ask_user', { tool_title: '取消测试', questions: [{ question: '还继续吗？', options: [{ label: '是' }, { label: '否' }] }] }, {
    signal: controller.signal, sessionId: 's2', toolCallId: 'c2', workspaceDir: dir,
  });
  await waitFor(() => broker.list('s2').length === 1);
  controller.abort();
  const result = await exec;
  assert.equal(result.success, false);
  assert.equal(result.executionStatus, 'cancelled');
  assert.match(result.output, /未完成/);
});

test('ask_user without a resolver fails with guidance instead of hanging', async (t) => {
  const { dir, runtime } = makeRuntime(t, undefined);
  const result = await runtime.execute('ask_user', { tool_title: 't', confirm: '好吗？' }, {
    signal: new AbortController().signal, sessionId: 's3', toolCallId: 'c3', workspaceDir: dir,
  });
  assert.equal(result.success, false);
  assert.match(result.output, /不可用/);
});

test('ask_user rejects arguments without questions or confirm', async (t) => {
  const broker = new QuestionBroker();
  const { dir, runtime } = makeRuntime(t, (request) => broker.request(request));
  const result = await runtime.execute('ask_user', { tool_title: 't' }, {
    signal: new AbortController().signal, sessionId: 's4', toolCallId: 'c4', workspaceDir: dir,
  });
  assert.equal(result.success, false);
  assert.match(result.output, /questions|confirm/);
});
