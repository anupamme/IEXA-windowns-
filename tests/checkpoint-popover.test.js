// Regression guard for the checkpoint popover.
//
// It was `position: absolute; right: 0; bottom: calc(100% + 10px)` inside
// .checkpoint-wrap, i.e. inside the composer's stacking context. Measured at
// 900x600 the 360px panel was laid out at x=-23..337, so it extended over the
// sidebar, was painted underneath it, and a 3px grid scan found 1,300+ sample
// points inside its box resolving to #sidebar / .nav-btn / .search-box. Clicks
// on the visible panel therefore acted on the sidebar.
//
// It is now portalled to <body> with fixed positioning and clamped to the
// viewport, so no ancestor stacking context or overflow can trap it.
//
// The test asserts geometry and hit-testing, not CSS source: the panel stays
// inside the viewport at every size, every interior sample resolves to the
// panel, and a click on its rounded corner neither reaches the element behind
// nor closes the panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

const VIEWPORTS = [
  { width: 900, height: 600 },
  { width: 1200, height: 800 },
  { width: 560, height: 700 },
];

function seedWorkspace(dir) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, '.iexa-sessions'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.iexa-checkpoints'), { recursive: true });
  const now = Date.now();
  const sessionId = 'sess_cp';
  fs.writeFileSync(path.join(workspace, '.iexa-sessions.json'), JSON.stringify({
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, title: '检查点面板', created: now, updated: now, messageCount: 0, projectRoot: '', projectName: '', pinned: false }],
  }));
  fs.writeFileSync(path.join(workspace, '.iexa-sessions', `${sessionId}.json`), JSON.stringify([
    { role: 'user', content: '检查点面板命中测试', timestamp: now },
  ]));
  const labels = [
    '这两个面板UI也有问题，有时候看不清',
    '这个矩形设计的也有问题，不应该按照统一',
    '还有这个蓝色边也有bug，拖动会导致UI',
    '这个skill的添加按钮怎么不见了？',
    '继续完善',
    '再看一下会话列表和搜索框对齐',
  ];
  fs.writeFileSync(path.join(workspace, '.iexa-checkpoints', `${sessionId}.json`), JSON.stringify(
    labels.map((label, index) => ({
      id: `cp_${index}`, sessionId, label, createdAt: now - index * 60000,
      files: [], changeCount: (index + 1) * 4, bytes: 0, changes: [],
    })),
  ));
  return workspace;
}

test('real browser: checkpoint popover stays on screen and swallows its own edges', { skip: !browser, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-checkpoint-'));
  process.env.IEXA_WORKSPACE = seedWorkspace(dir);
  const backend = require('../dist/main/server');
  const server = await backend.startServer(0, false);
  const port = server.address().port;
  const code = backend.getServerCredentials(server).loginCode;

  const proc = spawn(browser, [
    '--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let socket;
  const exited = once(proc, 'exit');
  t.after(async () => {
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (proc.exitCode === null) proc.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 15000);
    proc.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    proc.once('error', reject);
  });
  const endpoint = new URL(wsUrl);
  const pages = await fetch(`http://${endpoint.host}/json`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let sequence = 0;
  const waiting = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const entry = waiting.get(message.id);
    if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
      waiting.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result?.result?.value;
  }
  async function wait(expression, message) {
    for (let i = 0; i < 150; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch { /* not ready yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }
  const settle = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));
  async function click(x, y) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await settle();
  }
  async function buttonCenter() {
    return evaluate(`(() => {
      const r = document.getElementById('checkpointBtn').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await wait("document.getElementById('checkpointBtn')", 'checkpoint button');

  for (const viewport of VIEWPORTS) {
    await cdp('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await settle(400);
    const label = `${viewport.width}x${viewport.height}`;

    const anchor = await buttonCenter();
    await click(anchor.x, anchor.y);
    await wait("!document.getElementById('checkpointPopover').hidden", `${label}: popover open`);
    await wait("document.querySelectorAll('.checkpoint-row').length === 6", `${label}: checkpoint rows`);

    const geometry = await evaluate(`(() => {
      const panel = document.getElementById('checkpointPopover');
      const box = panel.getBoundingClientRect();
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
        position: getComputedStyle(panel).position,
        parent: panel.parentElement === document.body ? 'body' : panel.parentElement.className,
        viewport: { w: innerWidth, h: innerHeight },
      };
    })()`);

    // 1. Fixed positioning: no ancestor stacking context can trap it any more.
    assert.equal(geometry.position, 'fixed', `${label}: the panel must be fixed-positioned`);
    assert.equal(geometry.parent, 'body', `${label}: the panel must be portalled out of the composer`);

    // 2. Fully inside the viewport, with the 8px breathing room.
    assert.ok(geometry.left >= 7, `${label}: panel starts at ${geometry.left}, outside the margin`);
    assert.ok(geometry.top >= 7, `${label}: panel top ${geometry.top} is clipped`);
    assert.ok(geometry.right <= geometry.viewport.w - 7, `${label}: panel right ${geometry.right} overflows ${geometry.viewport.w}`);
    assert.ok(geometry.bottom <= geometry.viewport.h - 7, `${label}: panel bottom ${geometry.bottom} overflows ${geometry.viewport.h}`);

    // 3. Every sample inside the panel's *painted* shape belongs to the panel.
    //    Samples are classified with the border radius so the rounded corners -
    //    which are a genuine hit-test hole covered by the guard below - are not
    //    counted as leaks. This is what used to fail: at 900px the panel sat
    //    under the sidebar and 1,300 points resolved to sidebar elements.
    const scan = await evaluate(`(() => {
      const panel = document.getElementById('checkpointPopover');
      const box = panel.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
      const inShape = (x, y) => {
        const insetX = Math.min(Math.max(x, box.left + radius), box.right - radius);
        const insetY = Math.min(Math.max(y, box.top + radius), box.bottom - radius);
        // Straight bands, then the four quarter discs.
        if (y >= box.top + radius && y <= box.bottom - radius && x >= box.left && x <= box.right) return true;
        if (x >= box.left + radius && x <= box.right - radius && y >= box.top && y <= box.bottom) return true;
        return (x - insetX) ** 2 + (y - insetY) ** 2 <= radius * radius;
      };
      const leaks = new Map();
      let total = 0, corners = 0;
      for (let y = Math.ceil(box.top) + 1; y <= Math.floor(box.bottom) - 1; y += 3) {
        for (let x = Math.ceil(box.left) + 1; x <= Math.floor(box.right) - 1; x += 3) {
          if (!inShape(x, y)) { corners++; continue; }
          total++;
          const el = document.elementFromPoint(x, y);
          if (el && panel.contains(el)) continue;
          const key = el ? (el.id ? '#' + el.id : (typeof el.className === 'string' ? el.className : el.tagName)) : 'null';
          const entry = leaks.get(key) || { count: 0, sample: { x, y } };
          entry.count++;
          leaks.set(key, entry);
        }
      }
      return { total, corners, leaks: [...leaks.entries()].map(([target, v]) => ({ target, ...v })) };
    })()`);
    assert.deepEqual(scan.leaks, [], `${label}: hit-test targets leak through the panel: ${JSON.stringify(scan.leaks)}`);
    assert.ok(scan.total > 2000, `${label}: grid scan covered only ${scan.total} points`);
    assert.ok(scan.corners > 0, `${label}: the scan never sampled a rounded corner`);

    // 4. The rounded corner is a real hit-test hole, so it needs the guard.
    const corner = await evaluate(`(() => {
      const box = document.getElementById('checkpointPopover').getBoundingClientRect();
      const x = Math.ceil(box.left) + 2, y = Math.ceil(box.top) + 2;
      const el = document.elementFromPoint(x, y);
      return { x, y, under: el ? (el.id ? '#' + el.id : el.className || el.tagName) : 'null' };
    })()`);
    if (corner.under !== 'null' && !String(corner.under).includes('checkpoint')) {
      await evaluate(`(() => {
        window.__behindClicks = 0;
        document.getElementById('chatMessages').addEventListener('click', () => { window.__behindClicks++; }, true);
        document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => { window.__behindClicks++; }, true));
        window.__navBefore = document.querySelector('.nav-btn.active')?.dataset.view || '';
        return true;
      })()`);
      await click(corner.x, corner.y);
      const after = await evaluate(`({
        behind: window.__behindClicks,
        open: !document.getElementById('checkpointPopover').hidden,
        nav: document.querySelector('.nav-btn.active')?.dataset.view || '',
        navBefore: window.__navBefore,
      })`);
      assert.equal(after.behind, 0, `${label}: a corner click reached ${corner.under} behind the panel`);
      assert.equal(after.open, true, `${label}: a corner click closed the panel`);
      assert.equal(after.nav, after.navBefore, `${label}: a corner click switched the view`);
    }

    // 5. Clicking inside the panel must not dismiss it (the outside-click
    //    handler has to know the panel is no longer inside .checkpoint-wrap).
    const refresh = await evaluate(`(() => {
      const r = document.getElementById('checkpointRefresh').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await click(refresh.x, refresh.y);
    await settle(320);
    assert.equal(await evaluate("!document.getElementById('checkpointPopover').hidden"), true, `${label}: clicking inside the panel closed it`);

    // 6. A genuine outside click still dismisses it.
    await click(viewport.width - 6, 6);
    await settle(320);
    assert.equal(await evaluate("document.getElementById('checkpointPopover').hidden"), true, `${label}: an outside click no longer closes the panel`);
  }

  assert.deepEqual(exceptions, [], 'no renderer exceptions while measuring the popover');
});
