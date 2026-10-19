// Regression guard for the composer popovers (model / context / permission).
//
// Two defects were reported together: the panels were hard to read, and clicks
// could reach the content behind them.
//
// 1. The shared popover rule painted a 88%-opaque surface with a 22px backdrop
//    blur. Over the transcript that reads through, and against the page the
//    panel had almost no fill contrast, so its edge was invisible.
// 2. Rounded corners mean the pixels inside the bounding box but outside the
//    corner are not part of the element: elementFromPoint returned the chat
//    underneath, and a click there acted on it.
//
// The test asserts what a user can observe: an opaque surface, a border that
// separates it from the page, readable text, a topmost hit test over the whole
// box, and a real click at the corner that does not reach the transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const browser = process.env.IEXA_TEST_BROWSER || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));

function seedWorkspace(dir) {
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // Copy the real profile names so the menu renders, but blank the secret refs
  // so the test never needs the vault.
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workspace', '.iexa-settings.json'), 'utf8'));
  for (const profile of settings.profiles) {
    if (profile.apiKey && profile.apiKey.$secretRef) profile.apiKey = '';
  }
  fs.writeFileSync(path.join(workspace, '.iexa-settings.json'), JSON.stringify(settings));
  return workspace;
}

test('real browser: composer popovers are opaque and never click through', { skip: !browser, timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-popover-'));
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
    const timeout = setTimeout(() => reject(new Error('browser startup timeout')), 12000);
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
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 8000);
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
    for (let i = 0; i < 120; i++) {
      try { if (await evaluate(expression)) return; } catch { /* not ready */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timeout: ${message || expression}`);
  }
  async function click(x, y) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1323, height: 859, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/#login=${code}` });
  await wait("document.body && document.body.dataset.mobileClient === 'desktop'", 'app shell');
  await wait("document.getElementById('modelSelectorLabel').textContent !== '— 尚未配置模型 —'", 'profiles');

  const measure = (selector, theme) => evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    const menu = document.querySelector(${JSON.stringify(selector)});
    const box = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const title = menu.querySelector('.model-selector-option-title, .thinking-level-option-title');
    const titleColor = title ? getComputedStyle(title).color : style.color;

    const parse = value => {
      const rgb = String(value).match(/rgba?\\(([^)]+)\\)/);
      if (rgb) {
        const p = rgb[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      const srgb = String(value).match(/color\\(srgb\\s+([^)]+)\\)/);
      if (srgb) {
        const p = srgb[1].split(/[\\s\\/]+/).filter(Boolean).map(Number);
        return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
      }
      return null;
    };
    const lum = c => {
      const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

    const bg = parse(style.backgroundColor);
    const border = parse(style.borderTopColor);
    const page = parse(getComputedStyle(document.getElementById('chatMessages')).backgroundColor);
    const text = parse(titleColor);

    // Walk the box, skipping the rounded corners, and record where the topmost
    // element is not the popover itself.
    const leaks = [];
    let samples = 0;
    for (let y = box.top + 16; y < box.bottom - 16; y += 5) {
      for (let x = box.left + 16; x < box.right - 16; x += 5) {
        samples++;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !menu.contains(hit)) leaks.push({ x: Math.round(x), y: Math.round(y), hit: hit ? (hit.id || hit.className || hit.tagName) : null });
      }
    }

    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      background: bg, border, page, text,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      borderWidth: parseFloat(style.borderTopWidth) || 0,
      bgVsPage: bg && page ? ratio(bg, page) : 0,
      borderVsPage: border && page ? ratio(border, page) : 0,
      textVsBg: text && bg ? ratio(text, bg) : 0,
      samples, leaks: leaks.slice(0, 8), leakCount: leaks.length,
    };
  })()`);

  const openers = {
    '#modelSelectorMenu': "document.getElementById('modelSelector').click()",
    '#contextCompactionMenu': "document.getElementById('contextCompactionBtn').click()",
    '#permissionModeMenu': "document.getElementById('permissionModeBtn').click()",
  };
  const closers = {
    '#modelSelectorMenu': "document.getElementById('modelSelector').click()",
    '#contextCompactionMenu': "document.getElementById('contextCompactionBtn').click()",
    '#permissionModeMenu': "document.getElementById('permissionModeBtn').click()",
  };

  for (const theme of ['dark', 'light']) {
    for (const selector of Object.keys(openers)) {
      await evaluate(openers[selector]);
      await new Promise(resolve => setTimeout(resolve, 250));
      const m = await measure(selector, theme);
      const where = `${selector} (${theme})`;

      assert.ok(m.bomb === undefined, 'sanity');
      assert.ok(m.background, `${where}: no background colour`);
      assert.equal(m.background.a, 1, `${where}: popover is translucent (alpha ${m.background.a})`);
      assert.equal(m.backdrop, 'none', `${where}: backdrop blur is still applied`);
      assert.ok(m.borderWidth >= 1, `${where}: popover has no border`);
      assert.ok(m.borderVsPage >= 1.3, `${where}: border does not separate the panel from the page (${m.borderVsPage.toFixed(2)}:1)`);
      assert.ok(m.textVsBg >= 4.5, `${where}: text contrast is only ${m.textVsBg.toFixed(2)}:1`);
      assert.equal(m.leakCount, 0, `${where}: ${m.leakCount}/${m.samples} points inside the panel hit content behind (${JSON.stringify(m.leaks[0])})`);

      await evaluate(closers[selector]);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // --- click-through guard -------------------------------------------------
  // Instrument the transcript so a click that escapes the panel is observable.
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await evaluate(`(() => {
    window.__leaks = 0;
    const note = () => { window.__leaks++; };
    document.getElementById('chatMessages').addEventListener('pointerdown', note, true);
    document.getElementById('chatMessages').addEventListener('click', note, true);
    return true;
  })()`);

  await evaluate(openers['#modelSelectorMenu']);
  await new Promise(resolve => setTimeout(resolve, 300));
  const box = await evaluate(`(() => {
    const b = document.getElementById('modelSelectorMenu').getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  })()`);

  // Control: a click outside the panel must reach the transcript, proving the
  // instrumentation works before the guarded click is judged. Avoid anything
  // that would act on the session (quick actions, links, buttons).
  const outside = await evaluate(`(() => {
    const menu = document.getElementById('modelSelectorMenu');
    const box = menu.getBoundingClientRect();
    const transcript = document.getElementById('chatMessages');
    for (let y = box.top; y < box.bottom; y += 16) {
      for (let x = 8; x < box.left - 8; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || menu.contains(hit) || !transcript.contains(hit)) continue;
        if (hit.closest('button, a, input, textarea')) continue;
        return { x, y };
      }
    }
    return null;
  })()`);
  assert.ok(outside, 'no transcript point outside the panel to use as a control');
  await click(outside.x, outside.y);
  assert.equal(await evaluate('window.__leaks'), 2, 'control click did not reach the transcript');
  assert.equal(await evaluate("document.getElementById('modelSelectorMenu').style.display"), 'none', 'click outside should close the panel');

  // Guarded: the rounded corner is inside the bounding box but outside the
  // painted shape. Element hit-testing lands on the transcript there, so the
  // click must be swallowed instead of acting on it.
  await evaluate(openers['#modelSelectorMenu']);
  await new Promise(resolve => setTimeout(resolve, 300));
  const corner = { x: Math.round(box.left + 2), y: Math.round(box.top + 2) };
  const cornerHit = await evaluate(`(() => {
    const hit = document.elementFromPoint(${corner.x}, ${corner.y});
    const menu = document.getElementById('modelSelectorMenu');
    return { insideMenu: menu.contains(hit), target: hit ? (hit.id || hit.className || hit.tagName) : null };
  })()`);
  assert.equal(cornerHit.insideMenu, false, 'corner should be outside the rounded hit shape for this test to mean anything');

  await evaluate('window.__leaks = 0');
  await click(corner.x, corner.y);
  assert.equal(await evaluate('window.__leaks'), 0, `corner click reached the transcript (${cornerHit.target})`);
  assert.equal(await evaluate("document.getElementById('modelSelectorMenu').style.display"), 'flex', 'corner click should not close the panel');

  // A real click in the middle of an option must land on the option.
  const optionTarget = await evaluate(`(() => {
    const option = document.querySelector('#modelSelectorMenu .model-selector-option');
    const r = option.getBoundingClientRect();
    window.__clicked = null;
    window.addEventListener('click', event => {
      window.__clicked = event.target.closest('#modelSelectorMenu') ? 'menu' : 'outside';
      event.stopPropagation();
    }, true);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await click(optionTarget.x, optionTarget.y);
  assert.equal(await evaluate('window.__clicked'), 'menu', 'click on an option was routed outside the panel');

  assert.deepEqual(exceptions, [], 'no renderer exceptions while measuring');
});
