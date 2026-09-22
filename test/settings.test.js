import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSettings } from '../src/lib/settings.js';
import { DEFAULTS } from '../src/lib/defaults.js';

test('빈 값이면 기본값을 그대로 쓴다', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.baseUrl, DEFAULTS.baseUrl);
  assert.equal(settings.model, DEFAULTS.model);
  assert.equal(settings.stream, true);
  assert.equal(settings.contextMode, 'page');
  assert.equal(settings.panelMode, 'sidepanel');
});

test('문자열로 들어온 숫자를 숫자로 바꾼다', () => {
  const settings = normalizeSettings({
    temperature: '0.8',
    maxTokens: '512',
    maxContextChars: '8000',
    historyTurns: '6',
    timeoutMs: '60000',
  });
  assert.equal(settings.temperature, 0.8);
  assert.equal(settings.maxTokens, 512);
  assert.equal(settings.maxContextChars, 8000);
  assert.equal(settings.historyTurns, 6);
  assert.equal(settings.timeoutMs, 60000);
});

test('범위를 벗어난 값은 잘라낸다', () => {
  const low = normalizeSettings({
    temperature: -5,
    maxTokens: -1,
    maxContextChars: 1,
    historyTurns: -3,
    timeoutMs: 1,
  });
  assert.equal(low.temperature, 0);
  assert.equal(low.maxTokens, 0);
  assert.equal(low.maxContextChars, 500);
  assert.equal(low.historyTurns, 0);
  assert.equal(low.timeoutMs, 5000);

  const high = normalizeSettings({ temperature: 99, maxContextChars: 10 ** 9, timeoutMs: 10 ** 9 });
  assert.equal(high.temperature, 2);
  assert.equal(high.maxContextChars, 200000);
  assert.equal(high.timeoutMs, 600000);
});

test('숫자가 아닌 값은 기본값으로 되돌린다', () => {
  const settings = normalizeSettings({ temperature: '뜨겁게', maxTokens: null, timeoutMs: {} });
  assert.equal(settings.temperature, DEFAULTS.temperature);
  assert.equal(settings.maxTokens, DEFAULTS.maxTokens);
  assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs);
});

test('알 수 없는 모드 값은 기본값으로 바꾼다', () => {
  assert.equal(normalizeSettings({ contextMode: 'everything' }).contextMode, 'page');
  assert.equal(normalizeSettings({ panelMode: 'floating' }).panelMode, 'sidepanel');
  assert.equal(normalizeSettings({ panelMode: 'inpage' }).panelMode, 'inpage');
});

test('주소와 모델의 공백을 정리하고 빈 값은 기본값으로 둔다', () => {
  const settings = normalizeSettings({ baseUrl: '  http://host:4000  ', model: '  m  ' });
  assert.equal(settings.baseUrl, 'http://host:4000');
  assert.equal(settings.model, 'm');
  assert.equal(normalizeSettings({ baseUrl: '   ' }).baseUrl, DEFAULTS.baseUrl);
  assert.equal(normalizeSettings({ model: '' }).model, DEFAULTS.model);
});

test('알 수 없는 키는 결과에 남기지 않는다', () => {
  const settings = normalizeSettings({ hacked: true });
  assert.equal(Object.hasOwn(settings, 'hacked'), false);
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULTS).sort());
});
