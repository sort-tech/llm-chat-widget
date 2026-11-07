/**
 * 에이전트 모드의 도구 정의와 순수 함수들(Node 에서 테스트합니다).
 *
 *  - agentTools():    모델에 보내는 OpenAI 호환 function 정의(현재 언어로)
 *  - formatSnapshot:  페이지 스냅샷을 모델이 읽기 좋은 짧은 텍스트로
 *  - assessRisk:      실행 전에 사용자 승인이 필요한 동작인지
 *  - describeAction:  패널에 보여 줄 한 줄 설명
 *  - compactMessages: 오래된 화면 정보를 지워 프롬프트가 불어나지 않게
 */

import { allTranslations, t } from './i18n.js';

/** 화면 정보 머리표. 언어마다 다르므로, 걷어낼 때는 모든 언어의 표시를 찾습니다. */
export const snapshotMark = () => t('snap.mark');
const ALL_MARKS = () => allTranslations('snap.mark');

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

/** 현재 언어로 도구 정의를 만듭니다(설명 문구가 모델이 답하는 언어에도 영향을 줍니다). */
export function agentTools() {
  const REF = { type: 'string', description: t('tool.ref') };
  return [
    fn('read_page', t('tool.read_page'), {
      full_text: { type: 'boolean', description: t('tool.read_page.full') },
    }),
    fn('click', t('tool.click'), { ref: REF }, ['ref']),
    fn(
      'type',
      t('tool.type'),
      {
        ref: REF,
        text: { type: 'string', description: t('tool.type.text') },
        clear: { type: 'boolean', description: t('tool.type.clear') },
        submit: { type: 'boolean', description: t('tool.type.submit') },
      },
      ['ref', 'text'],
    ),
    fn(
      'select_option',
      t('tool.select'),
      { ref: REF, option: { type: 'string', description: t('tool.select.option') } },
      ['ref', 'option'],
    ),
    fn('press_key', t('tool.press_key'), { key: { type: 'string' } }, ['key']),
    fn('scroll', t('tool.scroll'), {
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
      ref: REF,
    }),
    fn('hover', t('tool.hover'), { ref: REF }, ['ref']),
    fn('navigate', t('tool.navigate'), { url: { type: 'string' } }, ['url']),
    fn('go_back', t('tool.go_back')),
    fn('open_tab', t('tool.open_tab'), { url: { type: 'string' } }, ['url']),
    fn('list_tabs', t('tool.list_tabs')),
    fn(
      'switch_tab',
      t('tool.switch_tab'),
      { tab_id: { type: 'integer', description: t('tool.switch_tab.id') } },
      ['tab_id'],
    ),
    fn('wait', t('tool.wait'), { seconds: { type: 'number' } }),
  ];
}

export const TOOL_NAMES = new Set(agentTools().map((tool) => tool.function.name));

/** 승인 없이 실행해도 되는 동작 — 화면을 바꾸지 않거나 되돌리기 쉬운 것. */
const ALWAYS_SAFE = new Set(['read_page', 'list_tabs', 'wait', 'scroll', 'hover']);

/**
 * 버튼 이름에 이런 단어가 있으면 되돌리기 어려운 동작으로 보고 승인을 받습니다.
 * (넓게 잡습니다 — 한 번 더 묻는 비용이 잘못 누르는 비용보다 훨씬 작습니다.)
 * 페이지 언어는 화면 언어와 무관하므로 한국어·영어 낱말을 늘 함께 봅니다.
 */
const RISKY_WORDS =
  /결제|구매|구입|주문|송금|이체|입금|출금|삭제|탈퇴|해지|해제|취소하기|전송|보내기|발송|제출|게시|업로드|등록|가입|신청|예약|확정|승인|동의|로그아웃|pay|buy|purchase|order|checkout|delete|remove|send|submit|post|publish|transfer|sign\s?up|register|unsubscribe|confirm|book|agree|log\s?out|sign\s?out/i;

/** 모델이 보낸 arguments(문자열 JSON)를 객체로. 실패하면 error 를 채웁니다. */
export function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return { args: raw, error: '' };
  const text = String(raw ?? '').trim();
  if (!text) return { args: {}, error: '' };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed, error: '' };
    return { args: {}, error: t('args.notObject') };
  } catch {
    return { args: {}, error: t('args.badJson', { text: text.slice(0, 120) }) };
  }
}

/** http/https 주소만 허용합니다. 'example.com' 처럼 스킴이 없으면 https 를 붙입니다. */
export function normalizeAgentUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return { ok: false, url: '', error: t('navurl.empty') };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value.replace(/^\/+/, '')}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, url: value, error: t('navurl.invalid') };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: value, error: t('navurl.scheme') };
  }
  return { ok: true, url: parsed.href, error: '' };
}

const quote = (text, max = 40) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const KIND_KEY = { a: 'kind.link', button: 'kind.button', input: 'kind.input', textarea: 'kind.input', select: 'kind.select' };

/** 요소를 사람이 읽는 말로: '검색' 버튼 / the 'Search' button */
export function targetLabel(target, ref) {
  if (!target) return ref ? t('target.ref', { ref, kind: t('kind.element') }) : t('kind.element');
  const kindKey =
    (target.type === 'checkbox' && 'kind.checkbox') ||
    (target.type === 'radio' && 'kind.radio') ||
    KIND_KEY[target.tag] ||
    (target.role === 'link' ? 'kind.link' : target.role === 'textbox' ? 'kind.input' : 'kind.element');
  const kind = t(kindKey);
  const name = quote(target.name || target.placeholder || '');
  return name ? t('target.named', { name, kind }) : t('target.ref', { ref: target.ref ?? ref, kind });
}

/** 패널에 보여 줄 단계 설명. */
export function describeAction(name, args = {}, target = null) {
  const what = () => targetLabel(target, args.ref);
  switch (name) {
    case 'read_page':
      return t('act.read_page');
    case 'click':
      return t('act.click', { what: what() });
    case 'type':
      return t(args.submit ? 'act.typeSubmit' : 'act.type', { what: what(), text: quote(args.text, 30) });
    case 'select_option':
      return t('act.select', { what: what(), option: quote(args.option, 30) });
    case 'press_key':
      return t('act.key', { key: quote(args.key, 20) });
    case 'scroll':
      if (args.ref) return t('act.scrollTo', { what: what() });
      return t({ up: 'act.scrollUp', top: 'act.scrollTop', bottom: 'act.scrollBottom' }[args.direction] ?? 'act.scrollDown');
    case 'hover':
      return t('act.hover', { what: what() });
    case 'navigate':
      return t('act.navigate', { url: quote(args.url, 60) });
    case 'go_back':
      return t('act.go_back');
    case 'open_tab':
      return t('act.open_tab', { url: quote(args.url, 60) });
    case 'list_tabs':
      return t('act.list_tabs');
    case 'switch_tab':
      return t('act.switch_tab', { id: args.tab_id });
    case 'wait':
      return t('act.wait', { s: Math.min(10, Math.max(0.5, Number(args.seconds) || 1)) });
    default:
      return name;
  }
}

/**
 * 실행 전에 사용자 승인이 필요한지 판단합니다.
 * @param {'risky'|'always'} mode  always = 화면을 바꾸는 모든 동작에 승인
 * @returns {{confirm: boolean, reason: string}}
 */
export function assessRisk(name, args = {}, target = null, mode = 'risky') {
  if (ALWAYS_SAFE.has(name)) return { confirm: false, reason: '' };
  if (mode === 'always') return { confirm: true, reason: t('risk.always') };

  if (name === 'click') {
    const label = `${target?.name ?? ''} ${target?.href ?? ''}`;
    if (RISKY_WORDS.test(label)) return { confirm: true, reason: t('risk.irreversible') };
    if (target?.type === 'submit' && target?.inForm) {
      return { confirm: true, reason: t('risk.submitButton') };
    }
  }
  if (name === 'type' && args.submit) {
    return { confirm: true, reason: t('risk.typeSubmit') };
  }
  if (name === 'press_key' && /^enter$/i.test(String(args.key ?? '').trim())) {
    return { confirm: true, reason: t('risk.enter') };
  }
  return { confirm: false, reason: '' };
}

/* --------------------------------------------------------- 화면 정보 */

function elementLine(el) {
  const kind =
    el.tag === 'input'
      ? `input[${el.type || 'text'}]`
      : el.role && el.role !== el.tag
        ? `${el.tag}(${el.role})`
        : el.tag;
  const parts = [`[${el.ref}] ${kind}`];
  if (el.name) parts.push(`"${el.name}"`);
  if (el.placeholder && el.placeholder !== el.name) parts.push(`placeholder="${el.placeholder}"`);
  if (el.value) parts.push(`value="${el.value}"`);
  if (el.options?.length) parts.push(`options=[${el.options.join(' | ')}]`);
  if (el.href) parts.push(`→ ${el.href}`);
  const flags = [];
  if (el.checked === true) flags.push(t('flag.checked'));
  if (el.checked === false && (el.type === 'checkbox' || el.type === 'radio' || el.role)) flags.push(t('flag.unchecked'));
  if (el.expanded === true) flags.push(t('flag.expanded'));
  if (el.expanded === false) flags.push(t('flag.collapsed'));
  if (el.disabled) flags.push(t('flag.disabled'));
  if (el.focused) flags.push(t('flag.focused'));
  if (!el.inView) flags.push(t('flag.offscreen'));
  if (flags.length) parts.push(`(${flags.join(', ')})`);
  return parts.join(' ');
}

/** 스냅샷을 모델이 읽을 텍스트로. 페이지 내용은 신뢰할 수 없는 자료임을 표시합니다. */
export function formatSnapshot(snapshot) {
  const mark = snapshotMark();
  if (!snapshot) return `${mark}\n${t('snap.unread')}`;
  const lines = [mark];
  if (snapshot.tabId != null) lines.push(t('snap.tab', { v: snapshot.tabId }));
  lines.push(`URL: ${snapshot.url ?? ''}`);
  lines.push(t('snap.title', { v: snapshot.title ?? '' }));
  if (snapshot.restricted) {
    lines.push(t('snap.restricted', { why: snapshot.restricted }));
    return lines.join('\n');
  }
  if (snapshot.scroll) {
    const { y, height, viewport } = snapshot.scroll;
    const below = Math.max(0, height - y - viewport);
    lines.push(t('snap.scroll', { y, h: height, below }));
  }
  const elements = snapshot.elements ?? [];
  const total = snapshot.totalInteractive ?? elements.length;
  lines.push(
    '',
    `${t('snap.elements', { n: elements.length })}${total > elements.length ? t('snap.partial', { total }) : ''}:`,
  );
  for (const el of elements) lines.push(elementLine(el));
  if (elements.length === 0) lines.push(t('snap.none'));
  if (snapshot.text) {
    lines.push('', t('snap.text'), '"""', snapshot.text, '"""');
  }
  return lines.join('\n');
}

/**
 * 오래된 도구 결과의 화면 정보를 걷어냅니다. 매 동작마다 화면 정보를 돌려주므로
 * 그대로 두면 단계가 늘수록 프롬프트가 급격히 커집니다. 원본은 바꾸지 않습니다.
 * @param {number} keep  화면 정보를 남겨 둘 최근 메시지 수
 */
export function compactMessages(messages, keep = 2) {
  const marks = ALL_MARKS();
  const findMark = (content) => {
    let at = -1;
    for (const mark of marks) {
      const i = content.indexOf(mark);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    return at;
  };
  let seen = 0;
  const out = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const content = typeof message?.content === 'string' ? message.content : '';
    const at = findMark(content);
    if ((message?.role === 'tool' || message?.role === 'user') && at !== -1) {
      seen += 1;
      if (seen > keep) {
        out[i] = { ...message, content: `${content.slice(0, at)}${t('snap.omitted')}`.trim() };
        continue;
      }
    }
    out[i] = message;
  }
  return out;
}

/** 에이전트용 시스템 프롬프트. 사용자의 기본 프롬프트(말투 등)는 뒤에 덧붙입니다. */
export function buildAgentSystemPrompt({ userPrompt = '', maxSteps = 20, now = new Date() } = {}) {
  const lines = [t('agent.prompt', { maxSteps, date: now.toISOString().slice(0, 10) })];
  const extra = String(userPrompt ?? '').trim();
  if (extra) lines.push('', t('agent.userPrompt'), extra);
  return lines.join('\n');
}
