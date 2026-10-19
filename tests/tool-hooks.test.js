'use strict';
// Workspace-level tool hooks: config validation plus real pre/post execution
// through ToolRuntime (the hook scripts run as separate Node processes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadHookSpecs } = require('../dist/main/runtime/HookRunner');

const PRE_BLOCK = `
let body = '';
process.stdin.on('data', (chunk) => body += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(body || '{}');
  if (payload.tool === 'file_write') {
    process.stdout.write(JSON.stringify({ block: true, reason: 'blocked by test hook' }));
  } else {
    process.stdout.write('{}');
  }
});
`;

const POST_LOG = `
const fs = require('fs');
const path = require('path');
let body = '';
process.stdin.on('data', (chunk) => body += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(body || '{}');
  fs.appendFileSync(path.join(__dirname, 'post.log'), payload.tool + ':' + (payload.result ? payload.result.success : 'none') + '\\n');
  process.stdout.write('{}');
});
`;

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-hooks-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.iexa-hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.iexa-hooks', 'pre.js'), PRE_BLOCK);
  fs.writeFileSync(path.join(root, '.iexa-hooks', 'post.js'), POST_LOG);
  return root;
}

test('loadHookSpecs validates paths, tool filters and timeouts', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/pre.js', tools: ['file_write'], timeoutMs: 2000 },
    postToolUse: { script: '.iexa-hooks/post.js' },
  }));

  const specs = loadHookSpecs(root);
  assert.equal(specs.length, 2);
  const pre = specs.find((spec) => spec.phase === 'preToolUse');
  assert.deepEqual(pre.tools, ['file_write']);
  assert.equal(pre.timeoutMs, 2000);
  assert.equal(pre.script, path.join(root, '.iexa-hooks', 'pre.js'));
});

test('loadHookSpecs refuses escapes, missing scripts and unknown fields', (t) => {
  const root = fixture(t);

  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '../outside.js' },
  }));
  assert.deepEqual(loadHookSpecs(root), []);

  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/missing.js' },
  }));
  assert.deepEqual(loadHookSpecs(root), []);

  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/pre.js', unknown: true },
  }));
  assert.deepEqual(loadHookSpecs(root), []);

  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/pre.js', tools: [] },
  }));
  assert.deepEqual(loadHookSpecs(root), []);
});

test('a preToolUse hook blocks the tool before execution', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/pre.js', tools: ['file_write'] },
  }));

  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({
    workspaceDir: root,
    memoryDir: path.join(root, '.memory'),
    memoryEnabled: false,
    hooks: () => loadHookSpecs(root),
  });
  await runtime.initialize();
  runtime.registerDefaults();

  const context = { signal: new AbortController().signal, sessionId: 's', toolCallId: 'c1', workspaceDir: root };
  const blocked = await runtime.execute('file_write', { tool_title: 'write', path: 'blocked.txt', content: 'x' }, context);
  assert.equal(blocked.success, false);
  assert.equal(blocked.executionStatus, 'denied');
  assert.match(blocked.output, /Hook 阻止了 file_write/);
  assert.match(blocked.output, /blocked by test hook/);
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);

  // The same hook does not apply to file_read.
  fs.writeFileSync(path.join(root, 'read.txt'), 'hello');
  const read = await runtime.execute('file_read', { tool_title: 'read', path: 'read.txt' }, { ...context, toolCallId: 'c2' });
  assert.equal(read.success, true, read.output);
});

test('a postToolUse hook runs after a successful tool and receives the result', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    postToolUse: { script: '.iexa-hooks/post.js' },
  }));

  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({
    workspaceDir: root,
    memoryDir: path.join(root, '.memory'),
    memoryEnabled: false,
    hooks: () => loadHookSpecs(root),
  });
  await runtime.initialize();
  runtime.registerDefaults();

  const context = { signal: new AbortController().signal, sessionId: 's', toolCallId: 'c1', workspaceDir: root };
  const written = await runtime.execute('file_write', { tool_title: 'write', path: 'ok.txt', content: 'x' }, context);
  assert.equal(written.success, true, written.output);

  const log = fs.readFileSync(path.join(root, '.iexa-hooks', 'post.log'), 'utf8');
  assert.match(log, /file_write:true/);
});

test('hooks that time out or emit invalid JSON never break the tool', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.iexa-hooks', 'slow.js'), 'setTimeout(() => { process.stdout.write("{}"); }, 5000);');
  fs.writeFileSync(path.join(root, '.iexa-hooks', 'junk.js'), 'process.stdout.write("not json");');
  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/slow.js', timeoutMs: 100 },
  }));
  assert.equal(loadHookSpecs(root)[0].timeoutMs, 100);

  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({
    workspaceDir: root, memoryDir: path.join(root, '.memory'), memoryEnabled: false,
    hooks: () => loadHookSpecs(root),
  });
  await runtime.initialize();
  runtime.registerDefaults();
  const context = { signal: new AbortController().signal, sessionId: 's', toolCallId: 'c1', workspaceDir: root };
  const result = await runtime.execute('file_read', { tool_title: 'read', path: 'any.txt' }, context);
  assert.equal(result.executionStatus, 'failed', 'missing file fails normally, not because of the hook');

  fs.writeFileSync(path.join(root, '.iexa-hooks.json'), JSON.stringify({
    preToolUse: { script: '.iexa-hooks/junk.js' },
  }));
  fs.writeFileSync(path.join(root, 'any.txt'), 'present');
  const junk = await runtime.execute('file_read', { tool_title: 'read', path: 'any.txt' }, { ...context, toolCallId: 'c2' });
  assert.equal(junk.success, true, junk.output);
});
