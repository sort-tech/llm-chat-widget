/**
 * "페이지가 그대로인가?" 만 값싸게 확인하는 주입용 스크립트.
 *
 * 본문 전체를 다시 추출·전송하는 대신(위키백과 기준 70KB 전달 + 수십 ms),
 * 주소·제목·글자 수와 지금 선택된 텍스트만 돌려줍니다.
 * 신호가 같으면 패널은 캐시해 둔 본문을 그대로 쓰고 선택 영역만 갱신합니다.
 *
 * extract.js 와 같은 방식으로 마지막 표현식의 값이 호출자에게 전달됩니다.
 */

(() => {
  'use strict';

  try {
    const selection = (() => {
      try {
        const value = window.getSelection?.()?.toString() ?? '';
        if (value.trim().length < 2) return '';
        return value.replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
      } catch {
        return '';
      }
    })();

    const bodyText = document.body?.textContent ?? '';

    /**
     * 길이가 같은 내용 교체(예: 같은 틀에 다른 값)를 구분하기 위한 값싼 지문.
     * 본문 전체를 해싱하면 비싸므로 앞·가운데·뒤에서 표본만 뽑습니다.
     */
    const fingerprint = (() => {
      const sample =
        bodyText.slice(0, 300) +
        bodyText.slice(Math.max(0, (bodyText.length >> 1) - 150), (bodyText.length >> 1) + 150) +
        bodyText.slice(-300);
      let hash = 5381;
      for (let i = 0; i < sample.length; i += 1) {
        hash = ((hash << 5) + hash + sample.charCodeAt(i)) | 0;
      }
      return (hash >>> 0).toString(36);
    })();

    return {
      ok: true,
      url: (document.location?.href ?? '').slice(0, 2000),
      title: String(document.title ?? '').slice(0, 300),
      // 본문 변경 감지용 — 정확한 값이 아니라 "바뀌었는지" 만 보면 됩니다.
      textLength: bodyText.length,
      fingerprint,
      frameCount: document.querySelectorAll('iframe,frame').length,
      readyState: document.readyState,
      selection,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
})();
