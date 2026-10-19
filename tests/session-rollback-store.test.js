const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const { encodeRollbacks, hydrateRollbacks, isRollbackSnapshot } = require('../dist/main/session/RollbackStore.js');

function snapshotOf(bytes) {
  return {
    version: 1,
    beforeExists: true,
    beforeBase64: Buffer.from(bytes).toString('base64'),
    afterSha256: 'a'.repeat(64),
  };
}

function sessionWith(...contents) {
  return [{
    role: 'assistant',
    content: 'turn',
    timestamp: 1,
    toolCalls: contents.map((bytes, i) => ({
      id: `call_${i}`,
      name: 'edit_file',
      args: {},
      result: { output: 'ok', success: true, fileChange: { path: 'src/app.js', rollback: snapshotOf(bytes) } },
    })),
  }];
}

test('inline snapshots are replaced by a ref and written once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const bytes = Buffer.from('const a = 1;\n'.repeat(2000));
    const messages = sessionWith(bytes);
    const encoded = encodeRollbacks(messages, dir);

    const rollback = encoded[0].toolCalls[0].result.fileChange.rollback;
    assert.equal(rollback.beforeBase64, undefined, 'the base64 must not survive into the file');
    assert.match(rollback.beforeRef, /^[a-f0-9]{64}$/);
    assert.equal(rollback.version, 1);
    assert.equal(rollback.afterSha256, 'a'.repeat(64));

    const stored = path.join(dir, `${rollback.beforeRef}.bin.gz`);
    assert.ok(fs.existsSync(stored));
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(stored)), bytes);
    assert.equal(rollback.beforeRef, createHash('sha256').update(bytes).digest('hex'));

    // The live object keeps its bytes for this process.
    assert.equal(messages[0].toolCalls[0].result.fileChange.rollback.beforeBase64, Buffer.from(bytes).toString('base64'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the encoded JSON is much smaller than the inline form', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const bytes = Buffer.from('export function render() { return null; }\n'.repeat(4000));
    const messages = sessionWith(bytes);
    const before = JSON.stringify(messages).length;
    const after = JSON.stringify(encodeRollbacks(messages, dir)).length;
    assert.ok(after < before / 10, `expected a large drop, got ${before} -> ${after}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('encoding is idempotent and deduplicates identical content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const bytes = Buffer.from('same content');
    const messages = sessionWith(bytes, bytes);
    const once = encodeRollbacks(messages, dir);
    const twice = encodeRollbacks(once, dir);
    assert.deepEqual(twice, once);
    assert.equal(fs.readdirSync(dir).length, 1, 'identical bytes share one snapshot');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hydrate restores the exact bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const messages = sessionWith(bytes);
    const encoded = encodeRollbacks(messages, dir);
    const loaded = JSON.parse(JSON.stringify(encoded));
    hydrateRollbacks(loaded, dir);
    assert.equal(loaded[0].toolCalls[0].result.fileChange.rollback.beforeBase64, Buffer.from(bytes).toString('base64'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing snapshot leaves the record unresolved instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const messages = sessionWith(Buffer.from('gone'));
    const encoded = JSON.parse(JSON.stringify(encodeRollbacks(messages, dir)));
    fs.rmSync(dir, { recursive: true, force: true });
    hydrateRollbacks(encoded, dir);
    const rollback = encoded[0].toolCalls[0].result.fileChange.rollback;
    assert.equal(rollback.beforeBase64, undefined);
    assert.match(rollback.beforeRef, /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empty snapshots and unrelated objects are left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const empty = { version: 1, beforeExists: false, beforeBase64: '', afterSha256: 'b'.repeat(64) };
    const other = { version: 1, something: 'else', nested: { keep: [1, 2, 3] } };
    const payload = { a: empty, b: other, c: 'text' };
    const encoded = encodeRollbacks(payload, dir);
    assert.deepEqual(encoded, payload);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
    assert.ok(isRollbackSnapshot(empty));
    assert.ok(!isRollbackSnapshot(other));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hydrate is a no-op for an already inline snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-rb-'));
  try {
    const messages = sessionWith(Buffer.from('inline'));
    const copy = JSON.parse(JSON.stringify(messages));
    hydrateRollbacks(copy, dir);
    assert.deepEqual(copy, messages);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
