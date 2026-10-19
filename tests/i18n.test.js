'use strict';
// i18n dictionary and runtime behaviour. The service is a browser script, so it
// attaches itself to globalThis when loaded under Node.
require('../src/renderer/services/I18n.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = globalThis.IexaI18n;

test('default locale is Chinese and missing keys fall back to the key', () => {
  i18n.setLocale('zh-CN', { apply: false });
  assert.equal(i18n.getLocale(), 'zh-CN');
  assert.equal(i18n.t('nav.chat'), '对话');
  assert.equal(i18n.t('does.not.exist'), 'does.not.exist');
});

test('switching to English translates known keys', () => {
  i18n.setLocale('en-US', { apply: false });
  assert.equal(i18n.getLocale(), 'en-US');
  assert.equal(i18n.t('nav.chat'), 'Chat');
  assert.equal(i18n.t('checkpoint.restore'), 'Restore here');
  assert.equal(i18n.t('permission.plan'), 'Plan only (read-only)');
  i18n.setLocale('zh-CN', { apply: false });
});

test('parameters are interpolated and unknown parameters are preserved', () => {
  i18n.setLocale('zh-CN', { apply: false });
  assert.equal(i18n.t('checkpoint.files', { count: 3 }), '3 个文件');
  assert.equal(i18n.t('checkpoint.files', { count: 0 }), '0 个文件');
  i18n.setLocale('en-US', { apply: false });
  assert.equal(i18n.t('checkpoint.files', { count: 1 }), '1 file(s)');
  assert.equal(i18n.t('checkpoint.files', {}), '{count} file(s)');
  i18n.setLocale('zh-CN', { apply: false });
});

test('locale normalization accepts any English tag', () => {
  assert.equal(i18n.normalize('en-GB'), 'en-US');
  assert.equal(i18n.normalize('EN'), 'en-US');
  assert.equal(i18n.normalize('zh-TW'), 'zh-CN');
  assert.equal(i18n.normalize(''), 'zh-CN');
  assert.equal(i18n.normalize(undefined), 'zh-CN');
});

test('both dictionaries expose exactly the same keys', () => {
  const zh = Object.keys(i18n.dictionaries['zh-CN']).sort();
  const en = Object.keys(i18n.dictionaries['en-US']).sort();
  assert.deepEqual(en, zh);
});

test('every value is a non-empty string and placeholders match across locales', () => {
  const pattern = /\{(\w+)\}/g;
  const placeholders = (value) => [...String(value).matchAll(pattern)].map((m) => m[1]).sort();
  for (const key of Object.keys(i18n.dictionaries['zh-CN'])) {
    const zh = i18n.dictionaries['zh-CN'][key];
    const en = i18n.dictionaries['en-US'][key];
    assert.ok(typeof zh === 'string' && zh.trim(), `zh value for ${key}`);
    assert.ok(typeof en === 'string' && en.trim(), `en value for ${key}`);
    assert.deepEqual(placeholders(en), placeholders(zh), `placeholder mismatch for ${key}`);
  }
});
