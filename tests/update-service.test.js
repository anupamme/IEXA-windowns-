'use strict';
// UpdateService state machine, exercised with an injected adapter so no
// Electron process or network access is required.
const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateService } = require('../dist/main/update/UpdateService');

class FakeAdapter {
  constructor() {
    this.handlers = new Map();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.calls = [];
    this.failCheck = false;
  }
  on(event, listener) {
    const list = this.handlers.get(event) || [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }
  emit(event, payload) {
    for (const listener of this.handlers.get(event) || []) listener(payload);
  }
  async checkForUpdates() {
    this.calls.push('check');
    if (this.failCheck) throw new Error('feed unavailable');
    this.emit('checking-for-update');
  }
  async downloadUpdate() { this.calls.push('download'); }
  quitAndInstall() { this.calls.push('install'); }
}

function service(overrides = {}) {
  const adapter = new FakeAdapter();
  const events = [];
  const instance = new UpdateService({
    adapter,
    enabled: true,
    currentVersion: '1.0.0',
    onStatus: (event) => events.push(event),
    schedule: () => 'scheduled',
    cancelSchedule: () => {},
    ...overrides,
  });
  return { adapter, events, instance };
}

test('start schedules a check and never downloads automatically', () => {
  const { adapter, instance } = service();
  assert.equal(adapter.autoDownload, false, 'downloads must stay user-initiated');
  assert.equal(adapter.autoInstallOnAppQuit, true);
  instance.start();
  assert.equal(instance.getState().status, 'idle');
  instance.dispose();
});

test('check and update events move through the expected states', async () => {
  const { adapter, events, instance } = service();
  await instance.check();
  assert.ok(adapter.calls.includes('check'));
  assert.equal(instance.getState().status, 'checking');

  adapter.emit('update-available', { version: '1.2.0' });
  assert.equal(instance.getState().status, 'available');
  assert.equal(instance.getState().version, '1.2.0');

  adapter.emit('download-progress', { percent: 41.7 });
  assert.equal(instance.getState().status, 'downloading');
  assert.equal(instance.getState().percent, 42);

  adapter.emit('update-downloaded', { version: '1.2.0' });
  assert.equal(instance.getState().status, 'downloaded');

  instance.install();
  assert.ok(adapter.calls.includes('install'));
  assert.ok(events.length >= 4);
  instance.dispose();
});

test('not-available and error states carry the right payload', async () => {
  const { adapter, instance } = service();
  await instance.check();
  adapter.emit('update-not-available', { version: '1.0.0' });
  assert.equal(instance.getState().status, 'not-available');

  adapter.emit('error', new Error('signature mismatch'));
  assert.equal(instance.getState().status, 'error');
  assert.match(instance.getState().message, /signature mismatch/);
  instance.dispose();
});

test('a failing check surfaces an error and only rethrows when not silent', async () => {
  const { adapter, instance } = service();
  adapter.failCheck = true;
  await instance.check(true);
  assert.equal(instance.getState().status, 'error');
  assert.match(instance.getState().message, /feed unavailable/);

  await assert.rejects(instance.check(false), /feed unavailable/);
  instance.dispose();
});

test('disabled mode never touches the adapter', async () => {
  const { adapter, events, instance } = service({ enabled: false });
  assert.equal(instance.getState().status, 'disabled');
  instance.start();
  await instance.check();
  instance.install();
  assert.deepEqual(adapter.calls, []);
  assert.ok(events.every((event) => event.status === 'disabled'));
  instance.dispose();
});

test('install before a download is a no-op', () => {
  const { adapter, instance } = service();
  instance.install();
  assert.deepEqual(adapter.calls, []);
  instance.dispose();
});

test('dispose stops further status updates', async () => {
  const { adapter, events, instance } = service();
  await instance.check();
  const before = events.length;
  instance.dispose();
  adapter.emit('update-available', { version: '9.9.9' });
  assert.equal(events.length, before);
  instance.dispose();
});
