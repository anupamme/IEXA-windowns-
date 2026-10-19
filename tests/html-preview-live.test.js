// Regression guard for the live HTML preview.
//
// The preview used to be a modal snapshot: it loaded a URL once, blocked the
// app behind a scrim, and only re-read the file when the user pressed reload.
// Previewing generated HTML therefore meant click, watch, close, reopen.
//
// It is now a floating, non-blocking pane with a live channel:
//   - the server exposes /api/fs/preview-stat and injects a small runtime into
//     the previewed document (the iframe is sandboxed without same-origin, so
//     postMessage is the only way to learn its scroll position or errors);
//   - the renderer polls the stat, reloads on change, loads into a second
//     iframe and only swaps after it is ready, restoring the scroll position.
//
// The test drives a real browser: it rewrites the file on disk and asserts the
// pane follows along, keeps its place, surfaces script errors, pauses on
// demand, and never blocks clicks to the app behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => fs.existsSync(candidate));

function documentFor(title, accent, copy, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 1800px; font: 15px/1.6 "Segoe UI", system-ui, sans-serif;
         background: linear-gradient(160deg, #0f172a, #1e293b 55%, ${accent}); color: #e2e8f0; }
  main { max-width: 720px; margin: 0 auto; padding: 64px 28px; }
  .card { padding: 28px; border-radius: 16px; background: rgba(255,255,255,.07);
          border: 1px solid rgba(255,255,255,.16); }
  h1 { margin: 0 0 10px; font-size: 34px; }
  .pill { display: inline-block; padding: 5px 11px; border-radius: 999px; background: ${accent}; color: #08111f; font-weight: 700; }
</style></head><body><main><div class="card">
  <span class="pill">${title}</span><h1>${copy}</h1>
  <p>磁盘上的文件变化会直接反映到这个窗口，不需要手动刷新。</p>
</div></main>${extra}</body></html>`;
}

function seedWorkspace(dir, page) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  const now = Date.now();
  const sessionId = 'sess_live_preview';
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, title: '实时预览', created: now, updated: now, messageCount: 1, projectRoot: '', projectName: '', pinned: false }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: '做一个渐变卡片页面', timestamp: now },
  ]));
  const target = path.join(workspace, 'page.html');
  fs.writeFileSync(target, page);
  return { workspace, target };
}

test('real browser: html preview re-renders live without flashing or losing place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-live-preview-'));
  const { workspace, target } = seedWorkspace(dir, documentFor('v1', '#22d3ee', '实时渲染的工作台'));
  process.env.IEXA_WORKSPACE = workspace;

  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const loginCode = backend.getServerCredentials(server).loginCode;
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--window-size=1280,840',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(proc, 'exit');

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error('DevTools did not start in time')), 15000);
      proc.stderr.on('data', (chunk) => {
        log += chunk;
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const endpoint = new URL(wsUrl);
    const pages = await fetch(`http://${endpoint.host}/json`).then((response) => response.json());
    const socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

    let counter = 0;
    const pending = new Map();
    const rendererErrors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); entry(message); return; }
      if (message.method === 'Runtime.exceptionThrown') {
        rendererErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
    };
    const cdp = (method, params = {}) => new Promise((resolve) => {
      const current = ++counter;
      pending.set(current, resolve);
      socket.send(JSON.stringify({ id: current, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
      return result.result?.result?.value;
    };
    const wait = async (expression, label) => {
      for (let attempt = 0; attempt < 220; attempt++) {
        try { if (await evaluate(expression)) return; } catch { /* page still booting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${label || expression}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      assert.ok(point, `${selector} should be on screen`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', {
          type, x: point.x, y: point.y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          clickCount: 1,
        });
      }
    };
    const absolute = target.replace(/\\/g, '/');

    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 840, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${loginCode}` });
    await wait("typeof openHtmlPreview === 'function'", 'app boot');

    // The runtime is opt-in: previewing without the query must leave the
    // document untouched, otherwise we would be modifying user HTML for every
    // plain preview request.
    const encoded = absolute.split('/').map(encodeURIComponent).join('/');
    const previewBase = `/api/fs/preview/absolute/${encoded}`;
    const plain = await evaluate(`fetch(${JSON.stringify(previewBase)}).then((r) => r.text())`);
    const injected = await evaluate(`fetch(${JSON.stringify(previewBase + '?iexa_runtime=1')}).then((r) => r.text())`);
    assert.ok(!plain.includes('data-iexa-runtime'), 'a plain preview must be served byte-for-byte');
    assert.ok(injected.includes('data-iexa-runtime'), 'the live preview must carry the runtime channel');

    // A document that is not UTF-8 must never be re-encoded just to gain the
    // runtime: bytes win over scroll restoration.
    const gbkBytes = Buffer.concat([
      Buffer.from('<meta charset="gbk"><p>'),
      Buffer.from([0xd6, 0xd0]),
      Buffer.from('</p>'),
    ]);
    fs.writeFileSync(path.join(workspace, 'gbk.html'), gbkBytes);
    const gbkUrl = `/api/fs/preview/absolute/${path.join(workspace, 'gbk.html').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}?iexa_runtime=1`;
    const served = await evaluate(`fetch(${JSON.stringify(gbkUrl)}).then((r) => r.arrayBuffer()).then((b) => Array.from(new Uint8Array(b)))`);
    assert.deepEqual(served, Array.from(gbkBytes), 'a non-UTF-8 document must be streamed untouched');

    await evaluate(`window.__previewLog = [];
      addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.__iexaPreview === 1) {
          window.__previewLog.push({ type: data.type, title: data.title, scrollY: data.scrollY, message: data.message });
        }
      });
      window.__frameStates = [];
      const canvas = document.getElementById('htmlPreviewCanvas');
      new MutationObserver(() => {
        window.__frameStates.push(Array.from(canvas.querySelectorAll('iframe'))
          .filter((frame) => frame.classList.contains('is-active')).length);
      }).observe(canvas, { subtree: true, attributes: true, attributeFilter: ['class'] });`);
    await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);

    await evaluate(`openHtmlPreview(${JSON.stringify(absolute)})`);
    await wait("document.getElementById('htmlPreviewOverlay').hidden === false", 'overlay open');
    await wait("window.__previewLog.some((m) => m.type === 'ready' && m.title === 'v1')", 'first render');
    await wait("document.getElementById('htmlPreviewLoading').hidden", 'loading cleared');

    // The pane is not a modal: clicks outside it reach the app, and the scrim
    // that used to dim everything is gone.
    const overlay = await evaluate(`(() => {
      const element = document.getElementById('htmlPreviewOverlay');
      const behind = document.elementFromPoint(8, innerHeight - 8);
      return {
        pointerEvents: getComputedStyle(element).pointerEvents,
        behindInsideOverlay: !!(behind && behind.closest('#htmlPreviewOverlay')),
      };
    })()`);
    assert.equal(overlay.pointerEvents, 'none', 'the preview overlay must not intercept the app');
    assert.equal(overlay.behindInsideOverlay, false, 'a click outside the window must reach the conversation');
    assert.equal(await evaluate("document.querySelectorAll('#htmlPreviewCanvas iframe').length"), 2, 'the canvas keeps two surfaces for double buffering');

    // Scroll, then let the file change underneath the open pane.
    await evaluate(`(() => { const frame = document.querySelector('#htmlPreviewCanvas iframe.is-active');
      frame.contentWindow.postMessage({ __iexaPreviewCommand: 1, type: 'scroll', y: 620 }, '*'); })()`);
    await wait("window.__previewLog.some((m) => m.type === 'scroll' && m.scrollY >= 600)", 'scroll reported');

    fs.writeFileSync(target, documentFor('v2', '#f472b6', '文件一改，预览自己就更新'));
    await wait("window.__previewLog.some((m) => m.type === 'ready' && m.title === 'v2')", 'live re-render');
    await wait("document.getElementById('htmlPreviewStatus').textContent.includes('已更新')", 'update stamp');

    const timeline = await evaluate(`window.__previewLog
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.type === 'ready' && entry.title === 'v2')
      .map((entry) => window.__previewLog.slice(entry.index)
        .some((later) => later.type === 'scroll' && later.scrollY >= 600))`);
    assert.deepEqual(timeline, [true], 'a live update must keep the reader\'s scroll position');
    assert.equal(await evaluate("document.querySelectorAll('#htmlPreviewCanvas iframe.is-active').length"), 1, 'exactly one surface is visible after the swap');
    const states = await evaluate('window.__frameStates');
    assert.ok(states.length >= 2, 'the swap should be observable');
    assert.ok(states.every((count) => count === 1), `the swap must never leave the canvas blank (saw ${JSON.stringify(states)})`);

    // A document that throws should be reported without breaking the pane.
    fs.writeFileSync(target, documentFor('v3', '#f59e0b', '这一版故意抛出脚本错误', '<script>window.__iexaMissing()</script>'));
    await wait("window.__previewLog.some((m) => m.type === 'ready' && m.title === 'v3')", 'error render');
    await wait("!document.getElementById('htmlPreviewErrors').hidden", 'error badge');
    const badge = await evaluate("document.getElementById('htmlPreviewErrors').textContent");
    assert.match(badge, /1 个脚本错误/, 'a script error must be surfaced in the status bar');

    // Pausing live updates must stop the polling reload; the manual refresh
    // button still works, which is the escape hatch while paused.
    await click('#htmlPreviewLive');
    assert.equal(await evaluate("document.getElementById('htmlPreviewLive').getAttribute('aria-pressed')"), 'false', 'the live switch must toggle');
    fs.writeFileSync(target, documentFor('v4', '#34d399', '暂停后不应自动更新'));
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(await evaluate("window.__previewLog.some((m) => m.type === 'ready' && m.title === 'v4')"), false, 'a paused preview must not auto-reload');
    await click('#htmlPreviewReload');
    await wait("window.__previewLog.some((m) => m.type === 'ready' && m.title === 'v4')", 'manual reload while paused');

    // Dragging the titlebar moves the pane and remembers the geometry.
    const before = await evaluate(`(() => { const r = document.getElementById('htmlPreviewWindow').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
    const grip = await evaluate(`(() => { const r = document.getElementById('htmlPreviewWindow').getBoundingClientRect();
      return { x: Math.round(r.left + 90), y: Math.round(r.top + 21) }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y, button: 'none' });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + 130, y: grip.y + 80, button: 'left', buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 130, y: grip.y + 80, button: 'left', clickCount: 1 });
    const after = await evaluate(`(() => { const r = document.getElementById('htmlPreviewWindow').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
    assert.ok(after.x >= before.x + 100, `dragging should move the window (from ${before.x} to ${after.x})`);
    const saved = await evaluate(`JSON.parse(localStorage.getItem('iexa-html-preview-geometry') || 'null')`);
    assert.ok(saved && saved.left >= before.x + 100, 'the window geometry should persist');

    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate("document.getElementById('htmlPreviewOverlay').hidden"), true, 'Escape must close the preview');
    assert.deepEqual(rendererErrors, [], 'the renderer must not throw during the whole flow');

    socket.close();
  } finally {
    proc.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
