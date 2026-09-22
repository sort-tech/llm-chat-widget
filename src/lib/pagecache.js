/**
 * 본문 캐시 판단 — chrome API 를 쓰지 않는 순수 함수라 단위 테스트할 수 있습니다.
 *
 * 캐시 신호는 **반드시 probe.js 의 결과 한 곳에서만** 만듭니다.
 * 추출 결과의 charCount(정리된 본문 길이)와 probe 의 textLength(원문 길이)는
 * 단위가 달라, 두 출처를 섞으면 다음 조회가 반드시 빗나갑니다.
 */

/** 캐시를 얼마나 오래 믿을지(ms). */
export const PAGE_CACHE_TTL = 5 * 60 * 1000;

/**
 * 최상위 프레임의 probe 결과로 신호의 기본형을 만듭니다.
 * 호출하는 쪽에서 프레임별 길이 목록을 덧붙여 최종 신호를 만듭니다
 * (본문이 iframe 안에 있는 사이트의 변화를 감지하기 위함).
 * 신호를 만들 수 없으면(제한된 페이지 등) null — 이때는 캐시하지 않습니다.
 */
export function makeSignature(probe) {
  if (!probe || probe.ok !== true) return null;
  const url = String(probe.url ?? '');
  if (!url) return null;
  const length = Number.isFinite(probe.textLength) ? probe.textLength : -1;
  const frames = Number.isFinite(probe.frameCount) ? probe.frameCount : -1;
  // 지문은 길이가 같은 내용 교체를 구분합니다(probe.js 의 표본 해시).
  const print = typeof probe.fingerprint === 'string' && probe.fingerprint ? probe.fingerprint : '-';
  return `${url}|${length}|${frames}|${print}`;
}

/**
 * 캐시한 본문을 그대로 쓸 수 있는지 판단합니다.
 * @param {{signature?:string, at?:number, page?:object}|undefined} cached
 * @param {string|null} signature 지금 읽은 신호
 * @param {number} now
 * @param {number} [ttl]
 */
export function isCacheFresh(cached, signature, now, ttl = PAGE_CACHE_TTL) {
  if (!cached || !signature) return false;
  if (cached.signature !== signature) return false;
  if (!Number.isFinite(cached.at)) return false;
  const age = now - cached.at;
  return age >= 0 && age < ttl;
}

/**
 * 캐시가 너무 커지지 않도록 가장 오래된 항목을 지웁니다.
 * @param {Map<number, {at:number}>} cache
 * @param {number} [limit]
 */
export function pruneCache(cache, limit = 20) {
  while (cache.size > limit) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of cache) {
      const at = Number.isFinite(value?.at) ? value.at : -Infinity;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    cache.delete(oldestKey);
  }
}
