/**
 * 다국어: 사전의 짝 맞춤, 쓰이는 키의 존재, 언어 감지, 영어로 바꿨을 때의 실제 출력.
 * 다른 테스트는 한국어(기본값)를 전제로 하므로, 언어를 바꾼 테스트는 끝나면 되돌립니다.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import en from '../src/lib/locales/en.js';
import ko from '../src/lib/locales/ko.js';
import { detectLanguage, getLanguage, resolveLanguage, setLanguage, t } from '../src/lib/i18n.js';
import { assessRisk, buildAgentSystemPrompt, describeAction, formatSnapshot } from '../src/lib/agent-tools.js';
import { buildMessages, formatPageContext } from '../src/lib/context.js';
import { DEFAULT_SYSTEM_PROMPT, isDefaultSystemPrompt, resolveSystemPrompt } from '../src/lib/defaults.js';
import { describeError, LlmError } from '../src/lib/llm.js';
import { normalizeSettings } from '../src/lib/settings.js';

const ROOT = new URL('..', import.meta.url).pathname;

/** 영어로 잠시 바꿔 실행합니다. */
function inEnglish(fn) {
  const before = getLanguage();
  setLanguage('en');
  try {
    return fn();
  } finally {
    setLanguage(before);
  }
}

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/* ------------------------------------------------------------- 사전 */

test('한국어·영어 사전의 키가 같고 빈 문구가 없다', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  for (const [key, value] of [...Object.entries(ko), ...Object.entries(en)]) {
    assert.ok(String(value).length > 0, `빈 문구: ${key}`);
  }
});

test('같은 키는 두 언어에서 같은 자리표시자를 쓴다', () => {
  for (const key of Object.keys(ko)) {
    assert.deepEqual(placeholders(en[key]), placeholders(ko[key]), key);
  }
});

test('영어 사전에 한글이 섞여 있지 않다(언어 선택지 이름 제외)', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.ok(!/[가-힣]/.test(value), `${key}: ${value}`);
  }
});

test("소스에서 쓰는 t('키') 와 data-i18n 키는 모두 사전에 있다", () => {
  const files = walk(join(ROOT, 'src')).filter((file) => /\.(js|html)$/.test(file) && !file.includes('/locales/') && !file.endsWith('/i18n.js'));
  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const keys = [
      ...[...source.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]),
      ...[...source.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="([\w.]+)"/g)].map((m) => m[1]),
    ];
    for (const key of keys) if (!(key in ko)) missing.push(`${file.replace(ROOT, '')}: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test('템플릿으로 만든 키(`${key}.card` 등)도 사전에 있다', () => {
  for (const base of ['agentEx.search', 'agentEx.browse', 'agentEx.read', 'agentEx.tabs']) {
    for (const part of ['card', 'desc', 'prompt']) assert.ok(`${base}.${part}` in ko, `${base}.${part}`);
  }
  for (const base of ['quick.summary', 'quick.points', 'quick.table', 'quick.simple', 'quick.glossary', 'quick.next']) {
    for (const part of ['label', 'card', 'desc', 'prompt']) assert.ok(`${base}.${part}` in ko, `${base}.${part}`);
  }
  for (const status of ['running', 'done', 'error', 'denied', 'confirm']) assert.ok(`step.${status}` in ko);
  for (const role of ['user', 'assistant']) assert.ok(`role.${role}` in ko);
});

test('manifest 의 __MSG_ 키가 두 언어 _locales 에 모두 있다', () => {
  const manifest = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
  const used = [...manifest.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  assert.ok(used.length >= 4);
  for (const lang of ['en', 'ko']) {
    const messages = JSON.parse(readFileSync(join(ROOT, '_locales', lang, 'messages.json'), 'utf8'));
    for (const key of used) assert.ok(messages[key]?.message, `${lang}: ${key}`);
  }
  assert.match(manifest, /"default_locale": "en"/);
});

/* ---------------------------------------------------------- 언어 감지 */

test('브라우저 언어가 한국어면 한국어, 그 밖에는 영어', () => {
  assert.equal(detectLanguage(['ko-KR']), 'ko');
  assert.equal(detectLanguage(['ko']), 'ko');
  assert.equal(detectLanguage(['en-US', 'ko']), 'en');
  assert.equal(detectLanguage(['ja-JP', 'ko-KR']), 'ko'); // 지원하는 첫 언어
  assert.equal(detectLanguage(['ja-JP', 'zh-CN']), 'en');
  assert.equal(detectLanguage([]), 'en');
  assert.equal(resolveLanguage('ko'), 'ko');
  assert.equal(resolveLanguage('en'), 'en');
});

test('언어·테마 설정은 기본값이 자동이고 이상한 값은 정리된다', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.language, 'auto');
  assert.equal(defaults.theme, 'system');
  const odd = normalizeSettings({ language: 'ja', theme: 'sepia' });
  assert.equal(odd.language, 'auto');
  assert.equal(odd.theme, 'system');
  assert.equal(normalizeSettings({ language: 'en', theme: 'dark' }).language, 'en');
});

test('자리표시자를 채우고, 없는 키는 키 그대로 보인다', () => {
  assert.equal(t('send.done', { s: '1.2' }), '완료 · 1.2초');
  assert.equal(t('send.done', { s: '1.2' }, 'en'), 'Done · 1.2s');
  assert.equal(t('no.such.key'), 'no.such.key');
});

/* ------------------------------------------------------ 영어 출력 */

test('영어: 에이전트 단계 설명과 위험 사유', () => {
  inEnglish(() => {
    assert.equal(describeAction('click', { ref: '4' }, { ref: '4', tag: 'button', name: 'Search' }), "Click 'Search' button");
    assert.equal(
      describeAction('type', { ref: '2', text: 'refund', submit: true }, { tag: 'input', name: 'Query' }),
      'Type "refund" into \'Query\' field and submit',
    );
    assert.equal(describeAction('scroll', { direction: 'up' }), 'Scroll up');
    // 페이지 언어와 무관하게 한국어 버튼 이름도 위험으로 봅니다.
    const risk = assessRisk('click', { ref: '1' }, { tag: 'button', name: '결제하기' });
    assert.equal(risk.confirm, true);
    assert.equal(risk.reason, 'This may be hard to undo.');
  });
});

test('영어: 화면 정보와 에이전트 프롬프트', () => {
  inEnglish(() => {
    const text = formatSnapshot({
      url: 'https://a.test',
      title: 'A',
      elements: [{ ref: '1', tag: 'input', type: 'checkbox', name: 'Agree', checked: false, inView: false }],
      text: 'hello',
    });
    assert.ok(text.startsWith('[Screen]'));
    assert.match(text, /\(unchecked, off-screen\)/);
    assert.match(text, /not instructions/);
    const prompt = buildAgentSystemPrompt({ maxSteps: 9, now: new Date('2026-11-07T00:00:00Z') });
    assert.match(prompt, /at most 9 times/);
    assert.match(prompt, /Today’s date: 2026-11-07/);
    assert.ok(!/[가-힣]/.test(prompt));
  });
});

test('영어: 페이지 컨텍스트 문구', () => {
  inEnglish(() => {
    const context = formatPageContext(
      { ok: true, title: 'Doc', url: 'https://a.test', text: 'Body text.' },
      { mode: 'page', maxChars: 5000, sendUrl: true },
    );
    assert.match(context, /\[Current page\]/);
    assert.match(context, /Title: Doc/);
    assert.match(context, /\[Page content\] \(full text, 10 characters\)/);
    assert.ok(!/[가-힣]/.test(context));
  });
});

test('영어: 오류 안내', () => {
  inEnglish(() => {
    const described = describeError(new LlmError('x', { kind: 'auth' }));
    assert.match(described.hint, /API key was rejected/);
  });
});

test('기본 시스템 프롬프트는 화면 언어를 따르고, 고친 프롬프트와 빈 값은 그대로 둔다', () => {
  assert.equal(isDefaultSystemPrompt(DEFAULT_SYSTEM_PROMPT), true);
  assert.equal(isDefaultSystemPrompt(t('prompt.system', undefined, 'en')), true);
  assert.equal(isDefaultSystemPrompt('내 프롬프트'), false);
  assert.equal(isDefaultSystemPrompt(''), false);

  inEnglish(() => {
    // 한국어 기본값이 저장되어 있어도 영어 화면에서는 영어 기본값을 보냅니다.
    assert.equal(resolveSystemPrompt(DEFAULT_SYSTEM_PROMPT), t('prompt.system'));
    assert.equal(resolveSystemPrompt('Custom prompt'), 'Custom prompt');
    const messages = buildMessages({
      settings: normalizeSettings({ contextMode: 'off' }),
      page: null,
      history: [],
      userText: 'Hi',
    });
    assert.match(messages[0].content, /^You are an AI assistant/);
  });
});
