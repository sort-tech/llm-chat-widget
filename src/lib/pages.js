/** 어떤 탭에 스크립트를 주입할 수 있는지 판단하는 공용 헬퍼. */

const RESTRICTED_SCHEME = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted|data|blob|filesystem):/i;

const WEBSTORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;

export function isInjectable(url) {
  if (!url) return false;
  if (RESTRICTED_SCHEME.test(url)) return false;
  if (WEBSTORE.test(url)) return false;
  return true;
}

/** 읽을 수 없는 이유를 사람이 읽는 문장으로. */
export function describeRestriction(url) {
  if (!url) return '탭 주소를 확인할 수 없습니다.';
  if (/^(chrome|edge|about|chrome-untrusted):/i.test(url)) {
    return '브라우저 내부 페이지(chrome://, edge:// 등)는 확장 프로그램이 읽을 수 없습니다.';
  }
  if (/^(chrome-extension|moz-extension):/i.test(url)) {
    return '다른 확장 프로그램 페이지는 읽을 수 없습니다.';
  }
  if (/^devtools:/i.test(url)) return '개발자 도구 페이지는 읽을 수 없습니다.';
  if (/^file:/i.test(url)) {
    return '로컬 파일을 읽으려면 확장 프로그램 관리 화면에서 "파일 URL에 대한 액세스 허용"을 켜 주세요.';
  }
  if (WEBSTORE.test(url)) return '브라우저 확장 스토어 페이지는 읽을 수 없습니다.';
  return '이 페이지는 읽을 수 없습니다.';
}

/** localhost 계열인지(= 평문 http 로 키를 보내도 네트워크에 노출되지 않는지). */
export function isLocalHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]'
  );
}
