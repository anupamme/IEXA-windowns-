'use strict';
// Covers the local code search tools added in batch A: globToRegExp, .gitignore
// parsing, bounded walking, binary skipping and the structured error contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchTools, globToRegExp, loadGitignore } = require('../dist/main/tools/SearchTools');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-search-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, tools: new SearchTools() };
}

function write(root, relative, content, encoding) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, encoding);
  return target;
}

test('globToRegExp handles **, *, ? and {a,b} without crossing separators', () => {
  assert.equal(globToRegExp('**/*.ts').test('a.ts'), true);
  assert.equal(globToRegExp('**/*.ts').test('src/deep/a.ts'), true);
  assert.equal(globToRegExp('**/*.ts').test('a.js'), false);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/deep/a.ts'), false);
  assert.equal(globToRegExp('a?.txt').test('ab.txt'), true);
  assert.equal(globToRegExp('a?.txt').test('a/b.txt'), false);
  assert.equal(globToRegExp('*.{js,ts}').test('x.ts'), true);
  assert.equal(globToRegExp('*.{js,ts}').test('x.md'), false);
  assert.equal(globToRegExp('src/**/test').test('src/a/b/test'), true);
});

test('loadGitignore honours comments, negation, directory-only and anchored rules', async (t) => {
  const { root } = fixture(t);
  write(root, '.gitignore', [
    '# comment',
    'node_modules/',
    '*.log',
    '!keep.log',
    '/root-only.txt',
    'build',
  ].join('\n'));

  const ignore = await loadGitignore(root);
  assert.equal(ignore('node_modules', true), true);
  assert.equal(ignore('node_modules', false), false, 'directory-only rule must not match files');
  assert.equal(ignore('debug.log', false), true);
  assert.equal(ignore('keep.log', false), false, 'later negation wins');
  assert.equal(ignore('root-only.txt', false), true);
  assert.equal(ignore('sub/root-only.txt', false), false, 'anchored rule is root-only');
  assert.equal(ignore('src/build', false), true, 'unanchored directory name matches at any depth');
  assert.equal(ignore('src/main.ts', false), false);
});

test('grep reports path:line:text and respects case and literal modes', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'src/main.ts', ['const alpha = 1;', 'const Beta = 2;', '// alpha again'].join('\n'));

  const plain = await tools.grep({ pattern: 'alpha' }, root, {});
  assert.equal(plain.success, true, plain.output);
  assert.match(plain.output, /^src\/main\.ts:1: const alpha = 1;$/m);
  assert.match(plain.output, /^src\/main\.ts:3: \/\/ alpha again$/m);
  assert.doesNotMatch(plain.output, /Beta/);

  const insensitive = await tools.grep({ pattern: 'beta', ignore_case: true }, root, {});
  assert.match(insensitive.output, /^src\/main\.ts:2: const Beta = 2;$/m);

  const literal = await tools.grep({ pattern: 'alpha =', fixed_strings: true }, root, {});
  assert.match(literal.output, /src\/main\.ts:1:/);
  assert.match(literal.output, /\[grep: 1 match\(es\) in 1 file\(s\)/);

  const regex = await tools.grep({ pattern: '^const \\w+ = \\d+;$' }, root, {});
  assert.match(regex.output, /src\/main\.ts:1:/);
  assert.match(regex.output, /src\/main\.ts:2:/);
});

test('grep filters by glob, supports context lines and caps results', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'src/a.ts', 'one\ntarget\nthree');
  write(root, 'src/b.js', 'target in js');
  write(root, 'src/c.ts', 'target one\ntarget two\ntarget three');

  const filtered = await tools.grep({ pattern: 'target', glob: '*.ts' }, root, {});
  assert.match(filtered.output, /src\/a\.ts:2:/);
  assert.match(filtered.output, /src\/c\.ts:1:/);
  assert.doesNotMatch(filtered.output, /b\.js/);

  const context = await tools.grep({ pattern: '^target$', path: 'src/a.ts', context_lines: 1 }, root, {});
  assert.match(context.output, /src\/a\.ts-1- one/);
  assert.match(context.output, /src\/a\.ts:2: target/);
  assert.match(context.output, /src\/a\.ts-3- three/);

  const capped = await tools.grep({ pattern: 'target', max_results: 2 }, root, {});
  const matchingLines = capped.output.split('\n').filter((line) => /^\S+:\d+: /.test(line));
  assert.equal(matchingLines.length, 2);
  assert.match(capped.output, /\[grep: stopped at 2 matches/);
});

test('grep skips binaries, dependencies and gitignored paths', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'src/ok.ts', 'needle');
  write(root, 'node_modules/pkg/index.js', 'needle');
  write(root, '.git/config', 'needle');
  write(root, 'ignored/secret.txt', 'needle');
  write(root, '.gitignore', 'ignored/\n');
  write(root, 'binary.dat', Buffer.from([0, 1, 2, 3, 0]));

  const result = await tools.grep({ pattern: 'needle' }, root, {});
  assert.match(result.output, /src\/ok\.ts:1:/);
  assert.doesNotMatch(result.output, /node_modules/);
  assert.doesNotMatch(result.output, /\.git\/config/);
  assert.doesNotMatch(result.output, /ignored\/secret/);
  assert.doesNotMatch(result.output, /binary\.dat/);
});

test('grep and glob reject paths outside the workspace and surface invalid regex', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'inside.txt', 'x');

  const outside = await tools.grep({ pattern: 'x', path: '../outside.txt' }, root, {});
  assert.equal(outside.success, false);
  assert.match(outside.output, /outside|PATH/i);

  const badGlob = await tools.grep({ pattern: 'x', path: '../nope' }, root, {});
  assert.equal(badGlob.success, false);

  const invalid = await tools.grep({ pattern: '(' }, root, {});
  assert.equal(invalid.success, false);
  assert.match(invalid.output, /invalid regular expression/i);
});

test('grep accepts a single file target', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'solo.txt', 'alpha\nbeta');
  const result = await tools.grep({ pattern: 'beta', path: 'solo.txt' }, root, {});
  assert.equal(result.success, true, result.output);
  assert.match(result.output, /^solo\.txt:2: beta$/m);
});

test('glob lists matching files, honours .gitignore and caps the result set', async (t) => {
  const { root, tools } = fixture(t);
  write(root, 'src/a.ts', 'a');
  write(root, 'src/deep/b.ts', 'b');
  write(root, 'src/c.js', 'c');
  write(root, 'node_modules/dep/x.ts', 'x');
  write(root, 'skip/e.ts', 'e');
  write(root, '.gitignore', 'skip/\n');

  const typescript = await tools.glob({ pattern: '**/*.ts' }, root, {});
  assert.equal(typescript.success, true, typescript.output);
  assert.match(typescript.output, /^src\/a\.ts$/m);
  assert.match(typescript.output, /^src\/deep\/b\.ts$/m);
  assert.doesNotMatch(typescript.output, /c\.js/);
  assert.doesNotMatch(typescript.output, /node_modules/);
  assert.doesNotMatch(typescript.output, /skip\/e\.ts/);
  assert.match(typescript.output, /\[glob: 2 file\(s\)/);

  const limited = await tools.glob({ pattern: '**/*.ts', limit: 1 }, root, {});
  const listed = limited.output.split('\n').filter((line) => line && !line.startsWith('['));
  assert.equal(listed.length, 1);
  assert.match(limited.output, /\[glob: stopped at 1 files/);

  const none = await tools.glob({ pattern: '**/*.rs' }, root, {});
  assert.match(none.output, /No files match/);
});

test('search tools stop when the caller aborts', async (t) => {
  const { root, tools } = fixture(t);
  for (let index = 0; index < 40; index++) write(root, `bulk/f${index}.txt`, 'needle');
  const controller = new AbortController();
  controller.abort();
  const result = await tools.grep({ pattern: 'needle' }, root, {}, controller.signal);
  assert.equal(result.success, true);
  assert.match(result.output, /No matches|0 match/);
});

test('grep and glob are registered and dispatched through ToolRuntime', async (t) => {
  const { root } = fixture(t);
  write(root, 'src/app.ts', 'const registered = true;\nconst other = false;\n');

  const { ToolRuntime } = require('../dist/main/runtime/ToolRuntime');
  const runtime = new ToolRuntime({
    workspaceDir: root,
    memoryDir: path.join(root, '.memory'),
    memoryEnabled: false,
  });
  await runtime.initialize();
  runtime.registerDefaults();

  const names = runtime.definitions().map((tool) => tool.name);
  assert.ok(names.includes('grep'), 'grep must be exposed to the model');
  assert.ok(names.includes('glob'), 'glob must be exposed to the model');

  const context = { signal: new AbortController().signal, sessionId: 'session', toolCallId: 'call-1', workspaceDir: root };
  const grep = await runtime.execute('grep', { tool_title: 'find flag', pattern: 'registered' }, context);
  assert.equal(grep.success, true, grep.output);
  assert.match(grep.output, /src\/app\.ts:1:/);

  const glob = await runtime.execute('glob', { tool_title: 'list sources', pattern: '**/*.ts' }, { ...context, toolCallId: 'call-2' });
  assert.equal(glob.success, true, glob.output);
  assert.match(glob.output, /src\/app\.ts/);

  const rejected = await runtime.execute('grep', { tool_title: 'bad', pattern: 'x', path: '../escape' }, { ...context, toolCallId: 'call-3' });
  assert.equal(rejected.success, false);
});
