const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../dist/main/agent/SystemPrompt');

const ctx = () => ({ workspaceDir: process.cwd(), hasProject: true, projectName: 'demo' });

test('the prompt tells the model to prefer inline commands over scratch scripts', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /## 临时文件纪律/);
  assert.match(prompt, /默认不产生文件/);
  assert.match(prompt, /python -c/);
  assert.match(prompt, /node -e/);
  assert.match(prompt, /不要为了跑一次就落盘一个脚本/);
});

test('scratch files have exactly one home and one name per task', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /落点唯一：项目根下的 `\.tmp\/`/);
  assert.match(prompt, /确认它被 `\.gitignore` 覆盖/);
  assert.match(prompt, /不要写项目根、源码目录或 `tests\/`/);
  assert.match(prompt, /一个任务一个文件/);
  assert.match(prompt, /不要递增出 `-v2`、`-final`、`-fix`/);
  assert.match(prompt, /probe-panel-width\.cjs/);
});

test('deliverables and intermediates are separated, and only intermediates are removed', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /\*\*交付物\*\*/);
  assert.match(prompt, /\*\*中间产物\*\*/);
  assert.match(prompt, /放到约定位置并在回复里给出路径，不要删/);
  assert.match(prompt, /→ `\.tmp\/`，任务结束时删除/);
});

test('the turn ends with a cleanup self-check rather than an empty claim', () => {
  const prompt = buildSystemPrompt(ctx());
  assert.match(prompt, /收尾自检，每轮结束前做一次/);
  assert.match(prompt, /提交说明优先用内联参数，必须用文件时提交后立即删除/);
  assert.match(prompt, /跑一次 `git status`/);
  assert.match(prompt, /测试夹具用 `mkdtemp\(\)`/);
  assert.match(prompt, /不要用「已清理」这类空话代替实际动作/);
  assert.match(prompt, /例外：用户明确要求保留/);
});

test('the discipline sits in the stable prompt head, before the workspace section', () => {
  const prompt = buildSystemPrompt(ctx());
  const tools = prompt.indexOf('## 工具使用纪律');
  const scratch = prompt.indexOf('## 临时文件纪律');
  const workspace = prompt.indexOf('## 当前工作区（项目）');
  assert.ok(tools >= 0 && scratch > tools, 'follows the tool discipline rules');
  assert.ok(workspace > scratch, 'precedes the per-project section');
});

test('the section carries no machine-specific path, so it cannot vary per turn', () => {
  const prompt = buildSystemPrompt(ctx());
  const section = prompt.slice(prompt.indexOf('## 临时文件纪律'), prompt.indexOf('## 当前工作区（项目）'));
  assert.doesNotMatch(section, /[A-Za-z]:\\\\/, 'no absolute drive path');
  assert.doesNotMatch(section, /\/home\/|\/Users\//, 'no absolute home path');
  // Prefix caching depends on a byte-stable request head: two builds of the same
  // context must be identical.
  assert.equal(buildSystemPrompt(ctx()), prompt);
});

test('the rule is present without an opened project too', () => {
  const prompt = buildSystemPrompt({ workspaceDir: process.cwd(), hasProject: false });
  assert.match(prompt, /## 临时文件纪律/);
  assert.match(prompt, /## 当前工作区\n/);
});
