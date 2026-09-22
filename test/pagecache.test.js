import assert from 'node:assert/strict';
import test from 'node:test';

import { isCacheFresh, makeSignature, PAGE_CACHE_TTL, pruneCache } from '../src/lib/pagecache.js';

const probe = {
  ok: true,
  url: 'https://example.com/a',
  textLength: 12345,
  frameCount: 2,
  fingerprint: 'abc123',
  selection: '',
};

test('probe 결과로 신호를 만든다', () => {
  assert.equal(makeSignature(probe), 'https://example.com/a|12345|2|abc123');
});

test('길이가 같아도 지문이 다르면 다른 신호가 된다 (내용 교체 감지)', () => {
  const a = makeSignature(probe);
  const b = makeSignature({ ...probe, fingerprint: 'zzz999' });
  assert.notEqual(a, b);
});

test('지문이 없으면 신호에 - 로 표시한다(옛 probe 호환)', () => {
  assert.equal(makeSignature({ ok: true, url: 'u', textLength: 1, frameCount: 0 }), 'u|1|0|-');
});

test('신호를 만들 수 없는 경우엔 null (캐시하지 않음)', () => {
  assert.equal(makeSignature(null), null);
  assert.equal(makeSignature({ ok: false }), null);
  assert.equal(makeSignature({ ok: true, url: '' }), null);
  assert.equal(makeSignature(undefined), null);
});

test('빠진 숫자 필드는 -1 로 구분된다 (같다고 오판하지 않게)', () => {
  assert.equal(makeSignature({ ok: true, url: 'u' }), 'u|-1|-1|-');
  assert.notEqual(makeSignature({ ok: true, url: 'u' }), makeSignature({ ok: true, url: 'u', textLength: 0, frameCount: 0 }));
});

test('신호가 같고 기한 안이면 캐시를 쓴다', () => {
  const signature = makeSignature(probe);
  const cached = { signature, at: 1000, page: {} };
  assert.equal(isCacheFresh(cached, signature, 1000), true);
  assert.equal(isCacheFresh(cached, signature, 1000 + PAGE_CACHE_TTL - 1), true);
});

test('기한이 지나거나 신호가 다르면 캐시를 쓰지 않는다', () => {
  const signature = makeSignature(probe);
  const cached = { signature, at: 1000, page: {} };
  assert.equal(isCacheFresh(cached, signature, 1000 + PAGE_CACHE_TTL), false);
  assert.equal(isCacheFresh(cached, 'https://example.com/a|99|2', 1200), false);
  assert.equal(isCacheFresh(cached, null, 1200), false);
  assert.equal(isCacheFresh(undefined, signature, 1200), false);
});

test('시계가 뒤로 간 경우(음수 나이)에도 캐시를 쓰지 않는다', () => {
  const signature = makeSignature(probe);
  assert.equal(isCacheFresh({ signature, at: 5000, page: {} }, signature, 1000), false);
});

test('at 이 손상된 캐시는 무시한다', () => {
  const signature = makeSignature(probe);
  assert.equal(isCacheFresh({ signature, at: undefined }, signature, 1000), false);
  assert.equal(isCacheFresh({ signature, at: NaN }, signature, 1000), false);
});

test('캐시가 한도를 넘으면 가장 오래된 것부터 지운다', () => {
  const cache = new Map();
  for (let i = 1; i <= 25; i += 1) cache.set(i, { at: i * 100 });
  pruneCache(cache, 20);
  assert.equal(cache.size, 20);
  assert.equal(cache.has(1), false);
  assert.equal(cache.has(5), false);
  assert.equal(cache.has(6), true);
  assert.equal(cache.has(25), true);
});

test('한도 이하면 아무것도 지우지 않는다', () => {
  const cache = new Map([[1, { at: 1 }]]);
  pruneCache(cache, 20);
  assert.equal(cache.size, 1);
});
