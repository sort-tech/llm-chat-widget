/** 어떤 탭에 스크립트를 주입할 수 있는지 판단하는 공용 헬퍼. */

import { t } from './i18n.js';

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
  if (!url) return t('restrict.noUrl');
  if (/^(chrome|edge|about|chrome-untrusted):/i.test(url)) {
    return t('restrict.internal');
  }
  if (/^(chrome-extension|moz-extension):/i.test(url)) {
    return t('restrict.extension');
  }
  if (/^devtools:/i.test(url)) return t('restrict.devtools');
  if (/^file:/i.test(url)) {
    return t('restrict.file');
  }
  if (WEBSTORE.test(url)) return t('restrict.store');
  return t('restrict.other');
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
