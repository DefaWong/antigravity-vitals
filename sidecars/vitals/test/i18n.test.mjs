import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../public/i18n.js';

const i18n = globalThis.VitalsI18n;

describe('bilingual i18n module', () => {
  it('maintains 100% key parity between zh and en dictionaries', () => {
    const zhKeys = Object.keys(i18n.MESSAGES.zh).sort();
    const enKeys = Object.keys(i18n.MESSAGES.en).sort();
    assert.deepEqual(zhKeys, enKeys);
    assert.ok(zhKeys.length > 70);
  });

  it('auto-detects locale from environment with proper precedence', () => {
    assert.equal(i18n.detectLocale({ search: '', stored: '', languages: ['zh-CN', 'en-US'] }), 'zh');
    assert.equal(i18n.detectLocale({ search: '', stored: '', languages: ['zh-Hant-TW'] }), 'zh');
    assert.equal(i18n.detectLocale({ search: '', stored: '', languages: ['en-US', 'zh-CN'] }), 'en');
    assert.equal(i18n.detectLocale({ search: '', stored: '', languages: ['ja-JP'] }), 'en');
    assert.equal(i18n.detectLocale({ search: '', stored: '', hostLocale: 'zh-CN', languages: ['en-US'] }), 'zh');
    assert.equal(i18n.detectLocale({ search: '?lang=en', stored: 'zh', languages: ['zh-CN'] }), 'en');
    assert.equal(i18n.detectLocale({ search: '', stored: 'en', languages: ['zh-CN'] }), 'en');
  });

  it('interpolates template variables cleanly in both languages', () => {
    i18n.setLocale('en', false);
    assert.equal(i18n.t('kpiTurnCache', { pct: '94.2' }), 'Turn 94.2%');
    i18n.setLocale('zh', false);
    assert.equal(i18n.t('kpiTurnCache', { pct: '94.2' }), '本轮 94.2%');
  });
});
