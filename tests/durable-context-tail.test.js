'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRuntime } = require('../dist/main/runtime/AgentRuntime');

/* Prompt-caching contract: the request head (system prompt + tools) must stay
   byte-identical across turns even when the durable session context changes,
   and history must stay append-only. The durable index travels as the leading
   block of each new user message instead of the system prompt, so
   prefix-caching providers (DeepSeek automatic caching, OpenAI cached_tokens)
   can re-use everything older than the newest tail. */

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-durable-tail-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('durable session context rides the newest user message; system prompt stays byte-identical', async t => {
  const root = fixture(t);
  const sent = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 1024,
    async *streamMessage(messages, systemPrompt) {
      sent.push({ messages: JSON.parse(JSON.stringify(messages)), systemPrompt });
      yield { type: 'textDelta', text: 'ok' };
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'tail-fixture', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false, contextWindow: 200000 });
  const noop = () => {};
  const callbacks = {
    onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
    onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
    onError: error => assert.fail(error), onDone: noop, onCancelled: () => assert.fail('cancelled'),
  };

  runtime.setSessionContext('CTX_ALPHA');
  await runtime.run({ message: 'FIRST_REQUEST', tools: [], callbacks });
  // The server regenerates the index between turns; text and size drift.
  runtime.setSessionContext('CTX_BETA_WITH_MORE_ANCHORS');
  await runtime.run({ message: 'SECOND_REQUEST', tools: [], callbacks });

  assert.equal(sent.length, 2);
  const [first, second] = sent;
  // 1) The request head is byte-identical across turns — the property prompt
  //    caching depends on. (Old behavior: the context lived in the system
  //    prompt, so this comparison failed on every turn.)
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.doesNotMatch(second.systemPrompt, /CTX_ALPHA|CTX_BETA|durable-session-context/);
  // 2) The context is the leading block of the newest user message.
  assert.equal(first.messages[0].role, 'user');
  assert.match(first.messages[0].parts[0].text, /^<durable-session-context>\nCTX_ALPHA\n<\/durable-session-context>$/);
  assert.match(first.messages[0].parts[1].text, /FIRST_REQUEST/);
  // 3) History is append-only: the second request is a strict extension of the
  //    first, so everything before the newest message can hit the prefix cache.
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  const tailParts = second.messages.at(-1).parts;
  assert.match(tailParts[0].text, /CTX_BETA_WITH_MORE_ANCHORS/);
  assert.doesNotMatch(tailParts[0].text, /CTX_ALPHA/);
  assert.match(tailParts[1].text, /SECOND_REQUEST/);
  // 4) The earlier snapshot stays intact in history (no rewrite, no drift).
  assert.match(second.messages[0].parts[0].text, /CTX_ALPHA/);
});

test('system placement keeps stable identity envelopes in the system prompt', async t => {
  const root = fixture(t);
  const sent = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 1024,
    async *streamMessage(messages, systemPrompt) {
      sent.push({ messages: JSON.parse(JSON.stringify(messages)), systemPrompt });
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'tail-system', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false, contextWindow: 200000 });
  const noop = () => {};
  // Sub-agent identities are written once and stable for the runtime's whole
  // life, so they keep the original system-prompt placement.
  runtime.setSessionContext('You are sub-agent Fixture.', 'system');
  await runtime.run({
    message: 'CHILD_TASK', tools: [], callbacks: {
      onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
      onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
      onError: error => assert.fail(error), onDone: noop, onCancelled: () => assert.fail('cancelled'),
    },
  });
  assert.match(sent[0].systemPrompt, /You are sub-agent Fixture\./);
  assert.equal(sent[0].messages[0].parts.length, 1);
  assert.equal(sent[0].messages[0].parts[0].text, 'CHILD_TASK');
});

test('empty durable context leaves the user message untouched', async t => {
  const root = fixture(t);
  const sent = [];
  const provider = {
    name: 'fixture', model: 'fixture', defaultMaxTokens: 1024,
    async *streamMessage(messages, systemPrompt) {
      sent.push({ messages: JSON.parse(JSON.stringify(messages)), systemPrompt });
      yield { type: 'done', stopReason: 'endTurn' };
    },
  };
  const runtime = new AgentRuntime({ sessionId: 'tail-empty', provider, workspaceDir: root, memoryDir: path.join(root, 'memory'), memoryEnabled: false, contextWindow: 200000 });
  const noop = () => {};
  await runtime.run({
    message: 'ONLY_REQUEST', tools: [], callbacks: {
      onTextDelta: noop, onThinkingDelta: noop, onToolCallStart: noop, onToolInputDelta: noop,
      onToolCallComplete: noop, onToolResult: noop, onUsage: noop, onContext: noop,
      onError: error => assert.fail(error), onDone: noop, onCancelled: () => assert.fail('cancelled'),
    },
  });
  assert.equal(sent[0].messages[0].parts.length, 1);
  assert.equal(sent[0].messages[0].parts[0].text, 'ONLY_REQUEST');
  assert.doesNotMatch(sent[0].systemPrompt, /durable-session-context/);
});
