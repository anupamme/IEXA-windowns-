'use strict';
// Native image reader: format sniffing, sandbox boundary, size ceiling and the
// imageData contract consumed by AgentLoop / provider adapters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readImageNative, sniffImageMime, imageMimeTypeForPath, MAX_READ_IMAGE_BYTES } = require('../dist/main/tools/ImageTools');

// Smallest valid 1x1 PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iexa-image-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('sniffImageMime identifies real formats from magic bytes', () => {
  assert.equal(sniffImageMime(PNG_1X1), 'image/png');
  assert.equal(sniffImageMime(JPEG_HEADER), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('BM......')), 'image/bmp');
  assert.equal(sniffImageMime(Buffer.from('not an image')), undefined);
  assert.equal(imageMimeTypeForPath('a.PNG'), 'image/png');
  assert.equal(imageMimeTypeForPath('a.txt'), undefined);
});

test('readImageNative returns pixels for a valid image', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'dot.png'), PNG_1X1);

  const result = await readImageNative({ path: 'dot.png' }, [root]);
  assert.equal(result.success, true, result.output);
  assert.equal(result.imageMimeType, 'image/png');
  assert.ok(Buffer.isBuffer(result.imageData));
  assert.equal(result.imageData.length, PNG_1X1.length);
  assert.deepEqual(result.imageData, PNG_1X1);
  assert.match(result.output, /Image: dot\.png/);
  assert.match(result.output, /1×1/);
  assert.equal(result.artifacts?.[0]?.kind, 'image');
});

test('readImageNative refuses an extension that contradicts the bytes', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'fake.png'), JPEG_HEADER);
  const result = await readImageNative({ path: 'fake.png' }, [root]);
  assert.equal(result.success, false);
  assert.match(result.output, /不一致/);
});

test('readImageNative refuses non-images, missing files and escapes', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plain.txt'), 'hello');

  const text = await readImageNative({ path: 'plain.txt' }, [root]);
  assert.equal(text.success, false);
  assert.match(text.output, /无法识别的图片格式/);

  const missing = await readImageNative({ path: 'nope.png' }, [root]);
  assert.equal(missing.success, false);

  const escape = await readImageNative({ path: '../outside.png' }, [root]);
  assert.equal(escape.success, false);
  assert.match(escape.output, /路径不可用/);
});

test('readImageNative enforces the byte ceiling before reading', async (t) => {
  const root = fixture(t);
  const target = path.join(root, 'huge.png');
  fs.writeFileSync(target, Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.alloc(MAX_READ_IMAGE_BYTES + 1)]));
  const result = await readImageNative({ path: 'huge.png' }, [root]);
  assert.equal(result.success, false);
  assert.match(result.output, /超过/);
});

test('readImageNative follows in-root symlinks but refuses out-of-root targets', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'real.png'), PNG_1X1);
  try {
    fs.symlinkSync(path.join(root, 'real.png'), path.join(root, 'link.png'));
  } catch {
    t.skip('symlink creation is not permitted in this environment');
    return;
  }

  const inside = await readImageNative({ path: 'link.png' }, [root]);
  assert.equal(inside.success, true, inside.output);
  assert.deepEqual(inside.imageData, PNG_1X1);

  const outside = path.join(os.tmpdir(), `iexa-outside-${process.pid}.png`);
  fs.writeFileSync(outside, PNG_1X1);
  t.after(() => fs.rmSync(outside, { force: true }));
  try { fs.symlinkSync(outside, path.join(root, 'escape.png')); }
  catch { t.skip('symlink creation is not permitted in this environment'); return; }

  const escaped = await readImageNative({ path: 'escape.png' }, [root]);
  assert.equal(escaped.success, false);
  assert.match(escaped.output, /路径不可用|outside/i);
});
