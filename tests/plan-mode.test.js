'use strict';
// Plan mode is a read-only exploration contract: exactly the allow-listed tools
// run, everything else is refused before any approval prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionManager } = require('../dist/main/security/PermissionManager');

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-plan-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tool(name, risk = 'medium', requiresApproval = false) {
  return {
    name, description: 'fixture', parameters: {}, required: [], risk,
    parallelSafe: false, cancellable: true, requiresApproval,
    execute: async () => ({ output: '', success: true }),
  };
}

function manager(dir, mode = 'plan') {
  return new PermissionManager(dir, async () => { throw new Error('plan mode must never prompt'); }, mode);
}

test('plan mode allows every read-only tool without prompting', async (t) => {
  const dir = fixture(t);
  const permissions = manager(dir);
  for (const name of ['file_read', 'grep', 'glob', 'memory_get', 'project_instructions', 'todo_write', 'ask_user', 'web_search', 'browser_fetch', 'display_file', 'read_image']) {
    await permissions.authorize({ sessionId: 's', tool: tool(name, 'low'), args: {} });
  }
});

test('plan mode denies mutating tools before any prompt', async (t) => {
  const dir = fixture(t);
  const permissions = manager(dir);
  for (const name of ['file_write', 'file_edit', 'shell_execute', 'terminal_run', 'terminal_kill', 'plugin_install', 'memory_write']) {
    await assert.rejects(
      permissions.authorize({ sessionId: 's', tool: tool(name, 'medium'), args: {} }),
      /规划模式|PERMISSION|plan/i,
      `${name} must be refused in plan mode`,
    );
  }
});

test('plan mode allows read-only desktop actions but refuses input actions', async (t) => {
  const dir = fixture(t);
  const permissions = manager(dir);
  for (const action of ['list_windows', 'observe', 'frame', 'session_state', 'find_element', 'read_focused', 'wait', 'wait_change']) {
    await permissions.authorize({ sessionId: 's', tool: tool('desktop_control', 'medium'), args: { action } });
  }
  for (const action of ['click', 'type', 'drag', 'launch', 'hotkey', 'scroll', 'batch']) {
    await assert.rejects(
      permissions.authorize({ sessionId: 's', tool: tool('desktop_control', 'medium'), args: { action } }),
      /规划模式/,
      `desktop ${action} must be refused in plan mode`,
    );
  }
});

test('plan mode writes an audit row for both allow and deny', async (t) => {
  const dir = fixture(t);
  const permissions = manager(dir);
  await permissions.authorize({ sessionId: 's', tool: tool('file_read', 'low'), args: { path: 'a.txt' } });
  await assert.rejects(permissions.authorize({ sessionId: 's', tool: tool('file_write', 'medium'), args: { path: 'a.txt' } }));

  const rows = fs.readFileSync(path.join(dir, 'security-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision, 'allow');
  assert.equal(rows[0].tool, 'file_read');
  assert.equal(rows[1].decision, 'deny');
  assert.equal(rows[1].tool, 'file_write');
});

test('ToolRuntime in plan mode reads files but refuses writes and shell', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'readme.md'), '# hello\n');
  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({
    workspaceDir: root,
    memoryDir: path.join(root, '.memory'),
    memoryEnabled: false,
    permissionMode: 'plan',
  });
  await runtime.initialize();
  runtime.registerDefaults();

  const context = { signal: new AbortController().signal, sessionId: 's', toolCallId: 'c1', workspaceDir: root };
  const read = await runtime.execute('file_read', { tool_title: 'read', path: 'readme.md' }, context);
  assert.equal(read.success, true, read.output);
  assert.match(read.output, /hello/);

  const grep = await runtime.execute('grep', { tool_title: 'find', pattern: 'hello' }, { ...context, toolCallId: 'c2' });
  assert.equal(grep.success, true, grep.output);

  const write = await runtime.execute('file_write', { tool_title: 'write', path: 'new.txt', content: 'x' }, { ...context, toolCallId: 'c3' });
  assert.equal(write.success, false);
  assert.equal(write.executionStatus, 'denied');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false, 'plan mode must not create files');

  const shell = await runtime.execute('shell_execute', { tool_title: 'run', command: 'echo hi' }, { ...context, toolCallId: 'c4' });
  assert.equal(shell.success, false);
  assert.equal(shell.executionStatus, 'denied');
});
