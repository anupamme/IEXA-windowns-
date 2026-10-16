'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { QuestionBroker, normalizeAskUserArgs, formatQuestionAnswers } = require('../dist/main/runtime/QuestionBroker');

const sampleQuestion = { id: 'q1', question: 'Q?', options: [], multiSelect: false, allowFreeText: true, kind: 'text' };

test('pending question resolves with the submitted answers and rejects duplicates', async () => {
  const broker = new QuestionBroker();
  const events = [];
  const unsubscribe = broker.subscribe('s1', (pending) => events.push(pending));
  const promise = broker.request({ sessionId: 's1', title: 'T', questions: [sampleQuestion] });
  assert.equal(events.length, 1);
  assert.equal(broker.list('s1').length, 1);
  assert.equal(broker.list('other').length, 0);
  assert.equal(broker.list()[0].id, events[0].id);
  const answers = [{ id: 'q1', selected: [], freeText: 'hi' }];
  assert.equal(broker.resolve(events[0].id, answers), true);
  assert.deepEqual(await promise, answers);
  assert.equal(broker.resolve(events[0].id, answers), false);
  assert.equal(broker.list('s1').length, 0);
  unsubscribe();
});

test('abort signal and cancelSession resolve pending questions as unanswered', async () => {
  const broker = new QuestionBroker();
  const controller = new AbortController();
  const aborted = broker.request({ sessionId: 's1', title: 'T', questions: [sampleQuestion], signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, null);
  const cancelled = broker.request({ sessionId: 's2', title: 'T', questions: [sampleQuestion] });
  broker.cancelSession('s2');
  assert.equal(await cancelled, null);
  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await broker.request({ sessionId: 's3', title: 'T', questions: [sampleQuestion], signal: preAborted.signal }), null);
});

test('questions expire to null after the broker timeout', async () => {
  const broker = new QuestionBroker(20);
  const result = await broker.request({ sessionId: 's', title: 'T', questions: [sampleQuestion] });
  assert.equal(result, null);
});

test('normalizeAskUserArgs shapes choice, text and confirm questions', () => {
  const normalized = normalizeAskUserArgs({
    tool_title: '部署',
    questions: [
      { question: '选方案', header: '方案', options: [{ label: 'A', description: 'a' }, 'B'], multi_select: true },
      { question: '补充', allow_free_text: true },
    ],
  });
  assert.equal(normalized.title, '部署');
  assert.equal(normalized.questions.length, 2);
  const [q1, q2] = normalized.questions;
  assert.equal(q1.id, 'q1');
  assert.equal(q1.multiSelect, true);
  assert.equal(q1.options.length, 2);
  assert.equal(q1.options[1].label, 'B');
  assert.equal(q1.kind, 'choice');
  assert.equal(q1.allowFreeText, false);
  assert.equal(q2.kind, 'text');
  assert.equal(q2.allowFreeText, true);
  const confirm = normalizeAskUserArgs({ confirm: '继续吗？', tool_title: '确认' });
  assert.equal(confirm.questions.length, 1);
  assert.equal(confirm.questions[0].kind, 'confirm');
  assert.deepEqual(confirm.questions[0].options.map((option) => option.label), ['确认', '取消']);
  assert.equal(confirm.title, '确认');
});

test('normalizeAskUserArgs rejects malformed input and caps question count', () => {
  assert.throws(() => normalizeAskUserArgs({}), /questions/);
  assert.throws(() => normalizeAskUserArgs({ questions: [{ header: 'x' }] }), /question/);
  assert.throws(() => normalizeAskUserArgs({ questions: new Array(9).fill({ question: 'q' }) }), /最多/);
});

test('formatQuestionAnswers renders selections, free text and skips', () => {
  const questions = [
    { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeText: false, kind: 'choice' },
    { id: 'q2', question: '补充', options: [], multiSelect: false, allowFreeText: true, kind: 'text' },
  ];
  const output = formatQuestionAnswers('标题', questions, [
    { id: 'q1', selected: ['A', 'B'] },
    { id: 'q2', selected: [], freeText: 'note' },
  ]);
  assert.match(output, /A、B/);
  assert.match(output, /note/);
  const partial = formatQuestionAnswers('T', questions, [{ id: 'q1', selected: [], skipped: true }, { id: 'q2', selected: [] }]);
  assert.match(partial, /跳过/);
  assert.match(partial, /未回答/);
  const empty = formatQuestionAnswers('T', questions, []);
  assert.match(empty, /未回答/);
});
