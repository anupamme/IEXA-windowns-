'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(x => fs.existsSync(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Real rendering of file-change cards after the long-task freeze fix: the card
   header builds instantly, diff rows are created lazily on first expand and are
   capped so a history with dozens of edits cannot block the renderer. Small
   changes must stay exact (no truncation note, every row present). */
test('real browser: file-change cards build lazily, cap rows, and keep small diffs exact', { skip: !browser, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-fchange-browser-'));
  process.env.IEXA_WORKSPACE = path.join(dir, 'workspace');
  const backend = require('../dist/main/server'); const server = await backend.startServer(0, false); const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;
  const proc = spawn(browser, ['--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket; const exited = once(proc, 'exit');
  t.after(async () => { if (socket) { try { socket.close(); } catch {} } if (proc.exitCode === null) proc.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]); server.closeAllConnections(); await new Promise((r) => server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {} });

  const wsUrl = await new Promise((resolve, reject) => { let log = ''; const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000); proc.stderr.on('data', (d) => { log += d; const m = log.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timeout); resolve(m[1]); } }); proc.once('error', reject); });
  const endpoint = new URL(wsUrl); const pages = await fetch(`http://${endpoint.host}/json`).then((r) => r.json());
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl); await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let sequence = 0; const waiting = new Map();
  socket.onmessage = (event) => { const msg = JSON.parse(event.data); const entry = waiting.get(msg.id); if (entry) { clearTimeout(entry.timer); waiting.delete(msg.id); entry.resolve(msg); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { waiting.delete(id); reject(new Error('cdp timeout: ' + method)); }, 20000); waiting.set(id, { resolve, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 900)); return r.result && r.result.result ? r.result.result.value : undefined; };
  const wait = async (expression, ms = 20000) => { const started = Date.now(); for (;;) { if (await evaluate(expression)) return; if (Date.now() - started > ms) throw new Error('UI wait timeout: ' + expression); await sleep(150); } };

  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("typeof renderFileChange === 'function' && document.body.dataset.mobileClient === 'desktop'", 30000);

  // Big change (120K chars per side, like a large source file): header only until expand; rows capped afterwards.
  const big = await evaluate(`(() => {
    const n = 2600, mk = () => { const s = []; for (let i = 0; i < n; i++) s.push('line ' + i + ' ' + 'x'.repeat(36)); return s; };
    const before = mk().join('\\n'); const arr = mk(); arr[10] = 'changed line'; const after = arr.join('\\n');
    const host = document.createElement('div'); document.body.appendChild(host);
    const t0 = performance.now();
    renderFileChange(host, { path: 'src/big.js', before, after, added: 1, removed: 1 });
    const headerMs = performance.now() - t0;
    const card = host.querySelector('.file-change-card');
    const diff = card.querySelector('.file-change-diff');
    const beforeClick = { rows: diff.querySelectorAll('.diff-line').length, hidden: diff.hidden };
    card.querySelector('.file-change-review').click();
    const afterClick = { rows: diff.querySelectorAll('.diff-line').length, hidden: diff.hidden, note: diff.querySelector('.diff-note') ? diff.querySelector('.diff-note').textContent : null, built: diff.dataset.built };
    card.querySelector('.file-change-review').click();
    return { headerMs: +headerMs.toFixed(1), beforeClick, afterClick, hiddenAgain: diff.hidden, rowsStill: diff.querySelectorAll('.diff-line').length };
  })()`);
  assert.equal(big.beforeClick.rows, 0, 'no diff rows before first expand');
  assert.equal(big.beforeClick.hidden, true);
  assert.equal(big.afterClick.built, '1');
  assert.equal(big.afterClick.rows, 481, '240 removed + 240 added + truncation note');
  assert.match(big.afterClick.note || '', /240/);
  assert.equal(big.hiddenAgain, true, 'review button still toggles');
  assert.equal(big.rowsStill, 481, 'rows are not rebuilt on re-toggle');
  assert.ok(big.headerMs < 50, 'header-only build stays fast: ' + big.headerMs + 'ms');

  // Small change stays exact: every row present, no truncation note.
  const small = await evaluate(`(() => {
    const before = 'a\\nb\\nc\\nd'; const after = 'a\\nB\\nc\\nd';
    const host = document.createElement('div'); document.body.appendChild(host);
    renderFileChange(host, { path: 'src/small.js', before, after, added: 1, removed: 1 });
    host.querySelector('.file-change-review').click();
    const diff = host.querySelector('.file-change-diff');
    return { rows: diff.querySelectorAll('.diff-line').length, note: !!diff.querySelector('.diff-note') };
  })()`);
  assert.equal(small.rows, 8, '4 removed + 4 added rows');
  assert.equal(small.note, false, 'no truncation note for small changes');
});
