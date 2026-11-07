/**
 * 다국어(영어·한국어) 지원.
 *
 *  - 언어는 설정의 language('auto' | 'ko' | 'en')로 정하고, 'auto' 면 브라우저 UI 언어를 따릅니다.
 *    한국어(ko…)면 한국어, 그 밖에는 영어입니다.
 *  - 문자열은 locales/ko.js · locales/en.js 에 같은 키로 둡니다. 영어에 없는 키는 한국어로,
 *    둘 다 없으면 키 자체를 돌려줍니다(빠진 번역이 화면에서 바로 보이도록).
 *  - {name} 자리표시자를 params 로 채웁니다.
 *  - HTML 은 data-i18n 속성으로 번역합니다(localizeDocument).
 */

import en from './locales/en.js';
import ko from './locales/ko.js';

export const LANGUAGES = Object.freeze({ auto: 'auto', ko: '한국어', en: 'English' });
const DICTS = { en, ko };

/** navigator.languages 같은 목록에서 지원 언어를 고릅니다. */
export function detectLanguage(candidates = []) {
  for (const raw of candidates) {
    const code = String(raw ?? '').toLowerCase();
    if (code.startsWith('ko')) return 'ko';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

/** 브라우저 UI 언어(확장 프로그램이면 chrome.i18n, 아니면 navigator). */
export function browserLanguage() {
  const list = [];
  try {
    const ui = globalThis.chrome?.i18n?.getUILanguage?.();
    if (ui) list.push(ui);
  } catch {
    /* 확장 프로그램 밖(테스트·하네스) */
  }
  const nav = globalThis.navigator;
  if (nav?.languages?.length) list.push(...nav.languages);
  else if (nav?.language) list.push(nav.language);
  return detectLanguage(list);
}

/** 설정값을 실제 언어로. */
export const resolveLanguage = (setting) =>
  setting === 'ko' || setting === 'en' ? setting : browserLanguage();

let current = 'ko';

export function setLanguage(lang) {
  current = lang === 'en' ? 'en' : 'ko';
  return current;
}

export const getLanguage = () => current;

const fill = (text, params) =>
  params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;

/** 현재 언어로 번역합니다. lang 을 주면 그 언어로 번역합니다. */
export function t(key, params, lang = current) {
  const text = DICTS[lang]?.[key] ?? ko[key] ?? key;
  return fill(text, params);
}

/** 모든 언어에서 같은 키의 문자열 — "기본값인지" 를 확인할 때 씁니다. */
export const allTranslations = (key) => Object.values(DICTS).map((dict) => dict[key]).filter(Boolean);

/** 숫자를 현재 언어 형식으로(1,234). */
export const formatNumber = (n, lang = current) =>
  Number(n ?? 0).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US');

/**
 * data-i18n 속성을 읽어 문서를 번역합니다.
 *   data-i18n="key"              → textContent
 *   data-i18n-html="key"         → innerHTML (번역 사전은 우리가 쓴 고정 문자열이므로 안전합니다)
 *   data-i18n-title / -placeholder / -aria-label="key" → 해당 속성
 */
export function localizeDocument(root = document) {
  if (root.documentElement) root.documentElement.lang = current;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const [attr, data] of [
    ['title', 'i18nTitle'],
    ['placeholder', 'i18nPlaceholder'],
    ['aria-label', 'i18nAriaLabel'],
  ]) {
    for (const el of root.querySelectorAll(`[data-${attr === 'aria-label' ? 'i18n-aria-label' : `i18n-${attr}`}]`)) {
      el.setAttribute(attr, t(el.dataset[data]));
    }
  }
}
