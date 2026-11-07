/**
 * 사이드 패널(또는 페이지 내 iframe)에서 도는 챗봇 UI.
 *
 * 흐름:
 *   1) 현재 탭을 알아낸다 → 2) 그 탭에 extract.js 를 주입해 본문을 읽는다
 *   3) 질문 + 본문을 합쳐 LiteLLM 에 보낸다 → 4) 스트리밍 응답을 마크다운으로 렌더링한다
 * 대화는 탭별로 chrome.storage.session 에 저장되어 패널을 닫아도 유지됩니다(브라우저 종료 시 삭제).
 */

import { loadSettings, saveSettings, onSettingsChanged } from '../lib/settings.js';
import { conversationKey, pendingKey } from '../lib/defaults.js';
import { formatNumber, localizeDocument, resolveLanguage, setLanguage, t } from '../lib/i18n.js';
import { chat, chatWithTools, describeError, listModels } from '../lib/llm.js';
import { runAgent } from '../lib/agent.js';
import { buildAgentSystemPrompt } from '../lib/agent-tools.js';
import { createBrowserExecutor } from './agent-browser.js';
import { applyTheme, effectiveTheme, nextTheme, onSystemThemeChange } from '../lib/theme.js';
import { approxTokens, buildMessages, formatPageContext } from '../lib/context.js';
import { renderMarkdown, toPlainText } from '../lib/markdown.js';
import { describeRestriction, isInjectable } from '../lib/pages.js';
import { clearHighlights, findCitations, highlightQuotes } from '../content/highlight.js';
import { runInsert } from '../content/insert.js';
import { isCacheFresh, makeSignature, PAGE_CACHE_TTL, pruneCache } from '../lib/pagecache.js';

/* ------------------------------------------------------------ 요소 참조 */

const $ = (id) => document.getElementById(id);

const els = {
  messages: $('messages'),
  status: $('status'),
  quick: $('quick'),
  input: $('input'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  newChat: $('btn-new'),
  settings: $('btn-settings'),
  close: $('btn-close'),
  refresh: $('btn-refresh'),
  model: $('model-select'),
  ctxMode: $('ctx-mode'),
  ctxDot: $('ctx-dot'),
  ctxTitle: $('ctx-title'),
  quickToggle: $('quick-toggle'),
  refBadge: $('ref-badge'),
  banner: $('banner'),
  bannerTitle: $('banner-title'),
  bannerHint: $('banner-hint'),
  bannerAction: $('banner-action'),
  bannerClose: $('banner-close'),
  agent: $('btn-agent'),
  chat: $('btn-chat'),
  theme: $('btn-theme'),
  themeLabel: $('theme-label'),
};

/** 에이전트 모드의 빈 화면 예시 — 어떤 일을 시킬 수 있는지 보여 줍니다. */
const AGENT_EXAMPLES = () =>
  [
    ['agentEx.search', 'search'],
    ['agentEx.browse', 'compass'],
    ['agentEx.read', 'scroll'],
    ['agentEx.tabs', 'layers'],
  ].map(([key, icon]) => ({
    icon,
    card: t(`${key}.card`),
    desc: t(`${key}.desc`),
    prompt: t(`${key}.prompt`),
  }));

/**
 * 빠른 질문.
 *   label  — 입력창 위 칩에 쓰는 짧은 이름
 *   card   — 빈 상태 카드에 쓰는 문구(무엇을 해 주는지 한눈에)
 *   icon   — 카드 아이콘 이름(panel.css 의 .ico-<이름>)
 *   desc   — 카드 아래 한 줄 설명
 * card 가 있는 항목만 빈 상태 카드로 보여 줍니다(6개 = 2열 × 3행).
 */
const QUICK_PROMPTS = () => [
  ...[
    ['quick.summary', 'summary'],
    ['quick.points', 'list'],
    ['quick.table', 'table'],
    ['quick.simple', 'bulb'],
    ['quick.glossary', 'book'],
    ['quick.next', 'arrow'],
  ].map(([key, icon]) => ({
    icon,
    label: t(`${key}.label`),
    card: t(`${key}.card`),
    desc: t(`${key}.desc`),
    prompt: t(`${key}.prompt`),
  })),
  { label: t('quick.translate.label'), prompt: t('quick.translate.prompt') },
];

/* ---------------------------------------------------------------- 상태 */

const params = new URLSearchParams(location.search);

const state = {
  embedded: params.get('embedded') === '1',
  settings: null,
  tabId: null,
  windowId: null,
  tabUrl: '',
  page: null,
  pageError: '',
  pageLoading: false,
  turns: [],
  busy: false,
  controller: null,
  nodes: new Map(),
  seq: 0,
  /** 응답 중에 사용자가 옮겨 간 탭. 응답이 끝나면 이 탭으로 따라갑니다. */
  pendingTabId: null,
  /** 응답 중에 도착한 컨텍스트 메뉴 요청. 끝나면 이어서 실행합니다. */
  queuedPrompt: null,
  /** 탭 전환/컨텍스트 읽기의 세대 번호 — 늦게 끝난 작업이 최신 상태를 덮지 않게 합니다. */
  switchGen: 0,
  ctxGen: 0,
  /** 진행 중인 모델 목록 요청. 새 요청이 오면 취소합니다. */
  modelsController: null,
  /** 빠른 질문 칩 줄을 펼쳤는지(대화가 시작되면 기본 접힘). */
  quickOpen: false,
  /** 웹페이지에서 입력 위치를 고르는 중인지 — { button, label } */
  picking: null,
  /** 탭별 본문 캐시: tabId -> { page, signature, at } */
  pageCache: new Map(),
  /** 에이전트 승인 대기: turnId -> { label, reason, resolve } */
  confirms: new Map(),
  /** 사용자가 펼쳐 둔 에이전트 단계 목록(turnId) */
  openSteps: new Set(),
};


const nextId = () => {
  state.seq += 1;
  return `t${Date.now().toString(36)}-${state.seq}`;
};

/* ------------------------------------------------------------- 유틸 */

const nearBottom = () => {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
};

const scrollToBottom = () => {
  els.messages.scrollTop = els.messages.scrollHeight;
};

const setStatus = (text, tooltip = '') => {
  const queued = state.queuedPrompt ? t('status.queued') : '';
  els.status.textContent = `${text ?? ''}${text ? queued : ''}`;
  els.status.title = tooltip;
};

const fmt = (n) => formatNumber(n);

/** 근거 표시 관련 안내 — 응답 중에는 진행 상태를 덮지 않습니다. */
const setCiteStatus = (text) => {
  if (!state.busy) setStatus(text);
};

function showBanner({ title, hint, action }) {
  els.bannerTitle.textContent = title ?? '';
  els.bannerHint.textContent = hint ?? '';
  if (action) {
    els.bannerAction.hidden = false;
    els.bannerAction.textContent = action.label;
    els.bannerAction.onclick = action.run;
  } else {
    els.bannerAction.hidden = true;
    els.bannerAction.onclick = null;
  }
  els.banner.hidden = false;
}

const hideBanner = () => {
  els.banner.hidden = true;
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 클립보드 권한이 없을 때를 위한 대체 경로
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* --------------------------------------------------------- 탭 / 컨텍스트 */

async function resolveTab() {
  if (state.embedded) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'whoami' });
      if (response?.tabId != null) {
        state.tabId = response.tabId;
        state.windowId = response.windowId ?? null;
        return;
      }
    } catch {
      /* 아래 공통 경로로 넘어갑니다. */
    }
  }

  const queries = [];
  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id !== undefined) queries.push({ active: true, windowId: win.id });
  } catch {
    /* 무시 */
  }
  queries.push({ active: true, lastFocusedWindow: true });
  queries.push({ active: true, currentWindow: true });

  for (const query of queries) {
    try {
      const [tab] = await chrome.tabs.query(query);
      if (tab?.id !== undefined) {
        state.tabId = tab.id;
        state.windowId = tab.windowId ?? null;
        state.tabUrl = tab.url ?? '';
        return;
      }
    } catch {
      /* 다음 후보로 */
    }
  }
}

/**
 * 상단 한 줄(상태 점 + 제목)과 입력창 아래 참조 뱃지를 함께 갱신합니다.
 * 토큰 수 같은 개발자용 수치는 뱃지 본문에 쓰지 않고 마우스 오버(title)로만 보여 줍니다.
 */
function renderContextBar(modeOverride) {
  const mode = modeOverride ?? state.settings?.contextMode ?? 'page';

  const setTop = (dot, title, tooltip = '') => {
    els.ctxDot.dataset.state = dot;
    els.ctxTitle.textContent = title;
    els.ctxTitle.title = tooltip || title;
  };
  const setBadge = (text, tooltip = '', badgeState = '') => {
    els.refBadge.textContent = text;
    els.refBadge.title = tooltip;
    if (badgeState) els.refBadge.dataset.state = badgeState;
    else delete els.refBadge.dataset.state;
  };

  if (state.pendingTabId != null) {
    setTop('loading', t('ctx.movedTitle'), t('ctx.movedTip'));
    setBadge(t('ctx.movedBadge'));
    return;
  }

  if (mode === 'off') {
    setTop('off', t('ctx.offTitle'), t('ctx.offTip'));
    setBadge(t('ctx.offBadge'), t('ctx.offBadgeTip'), 'off');
    return;
  }

  if (state.pageLoading) {
    setTop('loading', t('ctx.loading'));
    setBadge(t('ctx.loading'));
    return;
  }

  if (state.pageError) {
    setTop('warn', t('ctx.errorTitle'), state.pageError);
    setBadge(state.pageError, state.pageError, 'off');
    return;
  }

  const page = state.page;
  if (!page) {
    setTop('warn', t('ctx.noneTitle'), t('ctx.noneTip'));
    setBadge(t('ctx.nothing'), t('ctx.noneBadgeTip'), 'off');
    return;
  }

  if (!page.text && !page.selection) {
    const why = page.hasFrames
      ? t('ctx.whyFrames')
      : page.hasShadowRoots
        ? t('ctx.whyShadow')
        : t('ctx.whyOther');
    setTop('warn', page.title || t('ctx.noBody'), why);
    setBadge(t('ctx.nothing'), why, 'off');
    return;
  }

  // 정상 — 제목은 위에, 분량·참조 범위는 입력창 아래 뱃지에.
  const isSelection = mode === 'selection' && Boolean(page.selection);
  const scopeName = t(isSelection ? 'ctx.scopeSelection' : 'ctx.scopePage');
  setTop(
    'ok',
    page.title || page.url || t('ctx.untitled'),
    [page.title, page.url].filter(Boolean).join('\n'),
  );

  const context = formatPageContext(page, {
    mode,
    maxChars: state.settings.maxContextChars,
    sendUrl: state.settings.sendPageUrl,
  });

  const shown =
    mode === 'selection' && page.selection ? page.selection.length : Math.min(page.charCount, state.settings.maxContextChars);
  const tip = [
    t(isSelection ? 'ctx.tipSelection' : 'ctx.tipPage'),
    t('ctx.tipSent', { total: fmt(page.charCount), shown: fmt(shown) }),
    context ? t('ctx.tipTokens', { n: fmt(approxTokens(context)) }) : '',
    page.truncated || page.depthClipped ? t('ctx.tipTruncated') : '',
  ]
    .filter(Boolean)
    .join(' · ');

  setBadge(t('ctx.badge', { scope: scopeName, n: fmt(shown) }), tip);
}

/**
 * 현재 탭의 본문을 읽습니다.
 * @param {'page'|'selection'|'off'} [modeOverride] 이번 한 번만 적용할 참조 범위
 * @param {{force?: boolean}} [options] force 면 캐시를 무시하고 다시 추출합니다.
 */
async function refreshContext(modeOverride, { force = false } = {}) {
  const mode = modeOverride ?? state.settings.contextMode;
  if (mode === 'off') {
    state.page = null;
    state.pageError = '';
    renderContextBar(modeOverride);
    return;
  }
  if (state.tabId == null) {
    state.pageError = t('ctx.noTab');
    renderContextBar(modeOverride);
    return;
  }

  // 시작 시점의 탭을 고정하고 세대 번호를 찍어, 늦게 끝난 요청이
  // 다른 탭의 결과를 덮어쓰지 않게 합니다.
  const tabId = state.tabId;
  const gen = ++state.ctxGen;
  const stale = () => gen !== state.ctxGen || tabId !== state.tabId;

  // 강제 새로고침이면 캐시를 먼저 비웁니다. 그렇지 않으면 이 호출이 늦게 끝나는 사이
  // 다른 refreshContext 가 낡은 캐시를 그대로 재사용할 수 있습니다.
  if (force) state.pageCache.delete(tabId);

  state.pageLoading = true;
  state.pageError = '';
  renderContextBar(modeOverride);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (stale()) return;
    const url = tab?.url ?? '';
    state.tabUrl = url;

    if (!isInjectable(url)) {
      state.page = null;
      state.pageError = describeRestriction(url);
      return;
    }

    // 먼저 값싼 신호만 읽습니다(주소·본문 길이·프레임 수·선택 영역).
    // 신호가 캐시와 같으면 본문을 다시 추출·전송하지 않고 선택 영역만 갱신합니다.
    //
    // 신호는 항상 probe 로만 만듭니다. force 일 때도 마찬가지입니다 —
    // 추출 결과의 charCount(정리된 본문)와 probe 의 textLength(원문)는
    // 단위가 달라, 출처가 섞이면 다음 캐시 조회가 반드시 빗나갑니다.
    //
    // 본문 추출은 모든 프레임에서 하므로 신호도 모든 프레임에서 읽어야 합니다.
    // 최상위 프레임만 보면, 본문이 iframe 안에 있는 사이트에서 내용이 바뀌어도
    // 신호가 그대로여서 최대 5분간 옛 본문으로 답하게 됩니다.
    const probeEntries = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ['src/content/probe.js'] })
      .then((entries) =>
        (entries ?? [])
          .map((entry) => ({ frameId: entry?.frameId ?? 0, result: entry?.result }))
          .filter((entry) => entry.result),
      )
      .catch(() => []);
    if (stale()) return;

    const probed =
      probeEntries.find((entry) => entry.frameId === 0)?.result ?? probeEntries[0]?.result ?? null;
    // 선택 영역은 어느 프레임에서 했든 살립니다(iframe 안에서 고른 경우 포함).
    const probedSelection =
      probeEntries.map((entry) => entry.result?.selection).find((value) => value) ?? '';
    const frameSignature = probeEntries
      .slice()
      .sort((a, b) => a.frameId - b.frameId)
      .map((entry) => `${entry.frameId}:${entry.result?.textLength ?? -1}`)
      .join(',');
    const topSignature = makeSignature(probed);
    const signature = topSignature ? `${topSignature}|${frameSignature}` : null;

    const cached = state.pageCache.get(tabId);
    if (!force && isCacheFresh(cached, signature, Date.now(), PAGE_CACHE_TTL)) {
      state.page = { ...cached.page, selection: probedSelection };
      state.pageError = '';
      return;
    }

    // 본문이 iframe 안에 있는 사이트도 읽을 수 있도록 모든 프레임에 주입하고,
    // 가장 글자 수가 많은 결과를 본문으로 씁니다(메타데이터는 최상위 프레임 것).
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/extract.js'],
    });
    if (stale()) return;

    const frames = (results ?? [])
      .map((entry) => ({ frameId: entry?.frameId ?? 0, page: entry?.result }))
      .filter((entry) => entry.page && entry.page.ok !== false);
    const top = frames.find((entry) => entry.frameId === 0)?.page ?? frames[0]?.page ?? null;
    const richest = frames
      .slice()
      .sort((a, b) => (b.page.charCount || 0) - (a.page.charCount || 0))[0]?.page;

    if (!top && !richest) {
      const failure = (results ?? []).map((entry) => entry?.result).find((r) => r?.error);
      state.page = null;
      state.pageError = failure?.error
        ? t('ctx.extractFailed', { error: failure.error })
        : t('ctx.extractEmpty');
      return;
    }

    // 하위 프레임의 URL/제목을 모델에 넘기지 않도록 메타데이터는 최상위 것으로 고정합니다.
    const base = top ?? richest;
    const merged =
      richest && richest !== base && (richest.charCount || 0) > (base.charCount || 0)
        ? {
            ...base,
            text: richest.text,
            charCount: richest.charCount,
            truncated: richest.truncated,
            depthClipped: richest.depthClipped,
            headings: richest.headings?.length ? richest.headings : base.headings,
            selection: base.selection || richest.selection,
            source: t('ctx.innerFrame', { source: richest.source }),
          }
        : base;

    // 선택 영역은 probe 가 방금 읽은 값이 가장 최신입니다.
    state.page = probedSelection ? { ...merged, selection: probedSelection } : merged;

    // 캐시하지 않는 경우:
    //  - 신호를 못 얻음(제한된 페이지) → 잘못 재사용하는 것보다 안전합니다.
    //  - 읽은 내용이 없음 → 늦게 렌더되는 페이지에서 "본문 없음" 이 5분간 고착됩니다.
    //  - 아직 로딩 중 → 로딩 중 스냅샷이 고착됩니다.
    const worthCaching =
      Boolean(signature) &&
      Boolean(state.page.text || state.page.selection) &&
      probed?.readyState === 'complete';
    if (worthCaching) {
      state.pageCache.set(tabId, { page: state.page, signature, at: Date.now() });
      pruneCache(state.pageCache);
    } else {
      state.pageCache.delete(tabId);
    }
  } catch (error) {
    if (stale()) return;
    state.page = null;
    const message = String(error?.message ?? error);
    state.pageError = /cannot be scripted|Cannot access|Extension manifest|Frame with ID/i.test(
      message,
    )
      ? describeRestriction(state.tabUrl)
      : t('ctx.readFailed', { error: message });
  } finally {
    if (gen === state.ctxGen) {
      state.pageLoading = false;
      renderContextBar(modeOverride);
    }
  }
}

/* ----------------------------------------------------------- 대화 저장 */

/**
 * 대화를 탭별로 저장합니다. 호출 시점의 값을 인자로 고정해야
 * 저장 사이에 탭이 바뀌어도 엉뚱한 탭에 덮어쓰지 않습니다.
 */
async function persistConversation(tabId = state.tabId, turns = state.turns, url = state.tabUrl) {
  if (tabId == null) return;
  try {
    await chrome.storage.session.set({
      [conversationKey(tabId)]: { turns: turns.slice(-60), url, updatedAt: Date.now() },
    });
  } catch {
    /* 저장 실패는 조용히 무시합니다(대화는 메모리에 남아 있습니다). */
  }
}

async function restoreConversation(tabId = state.tabId) {
  if (tabId == null) {
    state.turns = [];
    state.nodes.clear();
    return;
  }
  const key = conversationKey(tabId);
  let restored = [];
  try {
    const stored = await chrome.storage.session.get(key);
    const turns = stored?.[key]?.turns;
    if (Array.isArray(turns)) {
      restored = turns.map((turn) => ({
        ...turn,
        id: turn.id ?? nextId(),
        status: turn.status === 'streaming' ? 'stopped' : turn.status,
      }));
    }
  } catch {
    /* 무시 */
  }
  // 읽는 동안 탭이 또 바뀌었으면 적용하지 않습니다(빈 배열로 덮는 사고 방지).
  if (tabId !== state.tabId) return;
  state.turns = restored;
  state.nodes.clear();
}

/* ------------------------------------------------------------ 본문 입력 */

/** 현재 탭의 주소를 확인합니다(참조 범위가 off 면 state.tabUrl 이 비어 있을 수 있음). */
async function currentTabUrl() {
  if (state.tabUrl) return state.tabUrl;
  if (state.tabId == null) return '';
  try {
    return (await chrome.tabs.get(state.tabId))?.url ?? '';
  } catch {
    return '';
  }
}

/** 모든 프레임에 주입 명령을 보냅니다(작성 영역이 iframe 안에 있을 수 있으므로). */
async function runInsertInTab(options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: state.tabId, allFrames: true },
    func: runInsert,
    args: [{ ...options, msgs: { tip: t('ins.tip'), tipHint: t('ins.tipHint') } }],
  });
  return (results ?? []).map((entry) => entry?.result).filter(Boolean);
}

/** 선택 모드를 끄고 오버레이를 모두 치웁니다. */
async function cancelPicking({ silent = false } = {}) {
  const picking = state.picking;
  state.picking = null;
  if (picking?.button) picking.button.textContent = picking.label;
  if (state.tabId == null) return;
  try {
    await runInsertInTab({ mode: 'cancel' });
  } catch {
    /* 탭이 닫혔거나 주입할 수 없는 페이지 */
  }
  if (!silent && picking) setStatus(t('insert.cancelled'));
}

/**
 * 답변을 웹페이지 입력창에 넣습니다.
 *   1) 이미 포커스된 입력창이 있으면 그대로 넣습니다(선택 단계 없음).
 *   2) 없으면 웹페이지에서 위치를 고르는 선택 모드로 넘어갑니다.
 *   3) 입력창을 하나도 못 찾으면(캔버스 기반 편집기 등) 복사를 안내합니다.
 */
async function insertIntoPage(turn, button) {
  if (state.tabId == null) {
    setStatus(t('ctx.noTab'));
    return;
  }
  const url = await currentTabUrl();
  if (!isInjectable(url)) {
    showBanner({ title: t('insert.cantTitle'), hint: describeRestriction(url) });
    return;
  }

  // 마크다운 기호가 폼에 그대로 들어가지 않도록 평문으로 바꿉니다.
  const text = toPlainText(turn.content);
  if (!text.trim()) {
    setStatus(t('insert.empty'));
    return;
  }

  await cancelPicking({ silent: true });
  hideBanner();

  let outcomes;
  try {
    outcomes = await runInsertInTab({ mode: 'auto', text });
  } catch (error) {
    showBanner({ title: t('insert.notFoundTitle'), hint: String(error?.message ?? error) });
    return;
  }

  if (outcomes.some((outcome) => outcome.status === 'inserted')) {
    setStatus(t('insert.done'));
    return;
  }

  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'noTargets')) {
    showBanner({
      title: t('insert.unsupportedTitle'),
      hint: t('insert.unsupportedHint'),
      action: {
        label: t('insert.copyAnswer'),
        run: async () => {
          const ok = await copyText(turn.content);
          setStatus(t(ok ? 'insert.copied' : 'insert.copyFailed'));
          if (ok) hideBanner();
        },
      },
    });
    return;
  }

  // 후보가 여러 개 — 웹페이지에서 직접 고르게 합니다.
  const label = button?.dataset.label ?? button?.textContent ?? '';
  try {
    const started = await runInsertInTab({ mode: 'pick', text });
    if (!started.some((outcome) => outcome.status === 'picking')) {
      setStatus(t('insert.noSpot'));
      return;
    }
  } catch (error) {
    setStatus(t('insert.pickFailed', { error: String(error?.message ?? error) }));
    return;
  }

  state.picking = { button, label };
  if (button) button.textContent = t('insert.picking');
  setStatus(t('insert.pickPrompt'));
}

/** 컨텐츠 스크립트가 보내는 선택 결과. */
function onInsertResult(message) {
  const picking = state.picking;
  state.picking = null;
  if (picking?.button) picking.button.textContent = picking.label;

  if (message.status === 'inserted') setStatus(t('insert.done'));
  else if (message.status === 'cancelled') setStatus(t('insert.cancelled'));
  else setStatus(t('insert.failed'));

  // 다른 프레임에 남아 있는 오버레이를 정리합니다.
  if (state.tabId != null) runInsertInTab({ mode: 'cancel' }).catch(() => {});
}

/* ---------------------------------------------------------- 근거 하이라이트 */

/**
 * 인용 문장을 현재 탭에서 찾아 형광펜으로 표시하고 그 위치로 스크롤합니다.
 * 본문이 하위 프레임에 있을 수도 있으므로 모든 프레임에 시도합니다.
 */
async function showCitation(quote, chip) {
  if (state.tabId == null) {
    setCiteStatus(t('ctx.noTab'));
    return;
  }

  // 참조 범위가 '참조 안 함' 이면 state.tabUrl 이 비어 있을 수 있으므로 새로 확인합니다.
  let url = state.tabUrl;
  try {
    if (!url) url = (await chrome.tabs.get(state.tabId))?.url ?? '';
  } catch {
    url = '';
  }
  if (!isInjectable(url)) {
    setCiteStatus(describeRestriction(url));
    return;
  }

  // 칩 이름은 DOM 이 아니라 dataset 에서 복원합니다(연속 클릭 시 '표시됨' 고착 방지).
  const label = chip?.dataset.label ?? chip?.textContent ?? '';
  const restore = () => {
    if (!chip) return;
    chip.textContent = label;
    delete chip.dataset.state;
  };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, allFrames: true },
      func: highlightQuotes,
      args: [[quote]],
    });
    const outcomes = (results ?? []).map((entry) => entry?.result).filter(Boolean);
    const found = outcomes.reduce((sum, outcome) => sum + (outcome.found ?? 0), 0);
    const partial = outcomes.reduce((sum, outcome) => sum + (outcome.partial ?? 0), 0);
    const supported = outcomes.some((outcome) => outcome.supported);
    const styled = outcomes.some((outcome) => outcome.found > 0 && outcome.styled);
    const truncated = outcomes.some((outcome) => outcome.truncated);

    if (found > 0) {
      const notes = [];
      if (partial > 0) notes.push(t('cite.partialNote'));
      if (!styled) notes.push(t('cite.unstyledNote'));
      setCiteStatus(notes.length ? t('cite.shownWith', { notes: notes.join(' · ') }) : t('cite.shown'));
      if (chip) {
        chip.dataset.state = partial > 0 ? 'partial' : 'found';
        chip.textContent = t(partial > 0 ? 'cite.chipPartial' : 'cite.chipShown');
        if (chip.dataset.timer) clearTimeout(Number(chip.dataset.timer));
        chip.dataset.timer = String(setTimeout(restore, 1400));
      }
    } else if (!supported) {
      setCiteStatus(t('cite.unsupported'));
    } else if (truncated) {
      setCiteStatus(t('cite.tooLong'));
    } else {
      setCiteStatus(t('cite.notFound'));
    }
  } catch (error) {
    setCiteStatus(t('cite.failed', { error: String(error?.message ?? error) }));
  }
}

async function clearCitations() {
  if (state.tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId, allFrames: true },
      func: clearHighlights,
    });
    setCiteStatus('');
  } catch {
    /* 무시 — 제한된 페이지이거나 탭이 닫힌 경우 */
  }
}

/** 답변 아래에 "근거 보기" 칩들을 붙입니다. */
function renderCitations(turn, bubble) {
  // 이전 버전에서 저장된 대화는 문자열 배열이므로 함께 받아들입니다.
  const quotes = (Array.isArray(turn.citations) ? turn.citations : [])
    .map((item) => (typeof item === 'string' ? { text: item, exact: true } : item))
    .filter((item) => item && typeof item.text === 'string');
  if (quotes.length === 0) return;

  const box = document.createElement('div');
  box.className = 'cites';

  // 처음 보는 사용자가 단순 태그로 오해하지 않도록, 무엇을 하는 버튼인지 밝힙니다.
  const caption = document.createElement('span');
  caption.className = 'cites-label';
  caption.title = t('cite.captionTip');
  caption.textContent = t('cite.caption');
  box.append(caption);

  for (const quote of quotes) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cite-chip';
    chip.title = quote.exact
      ? t('cite.chipTip', { text: quote.text })
      : t('cite.chipTipPartial', { text: quote.text });
    const label = quote.text.length > 26 ? `${quote.text.slice(0, 26)}…` : quote.text;
    // 앞의 위치 아이콘(CSS)은 '위치로 이동' 을 알리는 단서입니다(태그가 아니라 버튼임을 알림).
    chip.textContent = quote.exact ? label : t('cite.partialSuffix', { label });
    // 클릭 피드백 후 되돌릴 이름을 DOM 이 아닌 dataset 에 보관합니다.
    chip.dataset.label = chip.textContent;
    if (!quote.exact) chip.dataset.exact = 'false';
    chip.addEventListener('click', () => showCitation(quote.text, chip));
    box.append(chip);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'cite-chip is-clear';
  clear.textContent = t('cite.clear');
  clear.dataset.label = clear.textContent;
  clear.addEventListener('click', () => clearCitations());
  box.append(clear);

  bubble.append(box);
}

/* -------------------------------------------------------------- 렌더링 */

const roleLabel = (role) => (role === 'user' || role === 'assistant' ? t(`role.${role}`) : role);

function buildMessageNode(turn) {
  const wrap = document.createElement('article');
  wrap.className = `msg msg-${turn.role}`;
  wrap.dataset.id = turn.id;

  // 역할 라벨은 화면에서 지웠습니다(말풍선 모양·정렬로 구분). 다만 화면 낭독기에는
  // 누가 한 말인지 알려야 하므로 보이지 않는 라벨을 남깁니다.
  const role = document.createElement('span');
  role.className = 'sr-only';
  role.textContent = roleLabel(turn.role);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // 답변 아래에 **항상 보이는** 액션 줄. 호버해야 나타나면 기능이 있는지조차
  // 알 수 없어, 사용자가 채팅으로 "알아서 넣어줘" 라고 말하게 됩니다.
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  wrap.append(role, bubble, actions);
  return { wrap, bubble, actions };
}

/** 상태(오류 등)에 따라 래퍼 클래스를 맞춥니다. */
function applyState(turn, node) {
  node.wrap.className = `msg msg-${turn.role}${turn.status === 'error' ? ' msg-error' : ''}`;
}

/** 말풍선 아래 액션 줄을 채웁니다(사용자 메시지에는 두지 않습니다). */
function fillActions(turn, actions) {
  actions.replaceChildren();
  const text = String(turn.content ?? '').trim();
  // 에이전트 답은 요약 없이 중지돼도 '다시 생성' 을 쓸 수 있어야 합니다.
  const isAgent = turn.kind === 'agent' && turn.status !== 'streaming';
  if (turn.role !== 'assistant' || (!text && !isAgent)) {
    actions.hidden = true;
    return;
  }
  actions.hidden = false;

  // 이 확장 프로그램의 핵심 액션이므로 가장 먼저, 눈에 띄게 둡니다.
  if (turn.status !== 'error' && turn.kind !== 'agent') {
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'msg-action is-primary';
    insert.textContent = t('action.insert');
    insert.dataset.label = t('action.insert');
    insert.title =
      t('action.insertTip');
    insert.addEventListener('click', () => insertIntoPage(turn, insert));
    actions.append(insert);
  }

  const copy = document.createElement('button');
  copy.hidden = !text;
  copy.type = 'button';
  copy.className = 'msg-action';
  copy.textContent = t('action.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(turn.content ?? '');
    copy.textContent = t(ok ? 'action.copied' : 'action.failed');
    setTimeout(() => {
      copy.textContent = t('action.copy');
    }, 1200);
  });
  actions.append(copy);

  const isLast = state.turns[state.turns.length - 1]?.id === turn.id;
  if (isLast && !state.busy) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'msg-action';
    again.textContent = t('action.regenerate');
    again.addEventListener('click', () => regenerate());
    actions.append(again);
  }
}

function paintBubble(turn, bubble) {
  if (turn.role === 'user') {
    bubble.textContent = turn.content;
    return;
  }
  if (turn.kind === 'agent') {
    paintAgentBubble(turn, bubble);
    return;
  }

  if (turn.status === 'error') {
    bubble.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = turn.error?.title ?? t('msg.errorDefault');
    bubble.append(title);
    if (turn.error?.hint) {
      const hint = document.createElement('p');
      hint.style.margin = '4px 0 0';
      hint.textContent = turn.error.hint;
      bubble.append(hint);
    }
    if (turn.content) {
      const partial = document.createElement('div');
      partial.innerHTML = renderMarkdown(turn.content);
      bubble.append(partial);
    }
    return;
  }

  bubble.innerHTML = renderMarkdown(turn.content ?? '');
  if (turn.status === 'done') renderCitations(turn, bubble);
  if (turn.status === 'streaming') {
    const dot = document.createElement('span');
    dot.className = 'typing';
    bubble.append(dot);
  }
  if (turn.status === 'stopped') {
    const note = document.createElement('p');
    note.style.cssText = 'margin:6px 0 0;font-size:11px;opacity:.7';
    note.textContent = t('msg.stopped');
    bubble.append(note);
  }
  enhanceCodeBlocks(bubble);
}

/** 코드 블록에 복사 버튼을 달아 줍니다. */
function enhanceCodeBlocks(bubble) {
  for (const pre of bubble.querySelectorAll('pre[data-code="1"]')) {
    if (pre.dataset.enhanced === '1') continue;
    pre.dataset.enhanced = '1';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('action.copy');
    button.style.cssText =
      'position:absolute;top:5px;right:5px;padding:1px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg-muted);font-size:10.5px;cursor:pointer';
    button.addEventListener('click', async () => {
      const ok = await copyText(pre.querySelector('code')?.textContent ?? '');
      button.textContent = t(ok ? 'action.copied' : 'action.failed');
      setTimeout(() => {
        button.textContent = t('action.copy');
      }, 1200);
    });
    pre.append(button);
  }
}

/* ------------------------------------------------------- 에이전트 표시 */

const STEP_STATUSES = new Set(['running', 'done', 'error', 'denied', 'confirm']);

function renderAgentSteps(turn) {
  const steps = turn.steps ?? [];
  const details = document.createElement('details');
  details.className = 'agent-steps';
  details.open = turn.status === 'streaming' || state.openSteps.has(turn.id) || steps.length <= 3;
  details.addEventListener('toggle', () => {
    if (details.open) state.openSteps.add(turn.id);
    else state.openSteps.delete(turn.id);
  });

  const summary = document.createElement('summary');
  const failed = steps.filter((step) => step.status === 'error').length;
  summary.textContent =
    steps.length === 0
      ? t('steps.reading')
      : `${t('steps.count', { n: steps.length })}${failed ? t('steps.failed', { n: failed }) : ''}`;
  details.append(summary);

  const list = document.createElement('ol');
  for (const step of steps) {
    const item = document.createElement('li');
    item.className = `agent-step is-${step.status}`;
    const icon = document.createElement('span');
    // 상태 표시는 CSS 가 그립니다(진행 중 = 회전 링, 완료 = 체크 등).
    icon.className = 'agent-step-icon';
    icon.title = STEP_STATUSES.has(step.status) ? t(`step.${step.status}`) : '';
    const label = document.createElement('span');
    label.className = 'agent-step-label';
    label.textContent = step.label;
    item.append(icon, label);
    if (step.result && step.status !== 'running') {
      const result = document.createElement('span');
      result.className = 'agent-step-result';
      result.textContent = step.result;
      item.append(result);
    }
    list.append(item);
  }
  details.append(list);
  return details;
}

function renderConfirmCard(turn, pending) {
  const card = document.createElement('div');
  card.className = 'agent-confirm';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', t('confirm.aria'));

  const title = document.createElement('strong');
  title.textContent = t('confirm.title');
  const what = document.createElement('p');
  what.className = 'agent-confirm-what';
  what.textContent = pending.label;
  card.append(title, what);
  if (pending.reason) {
    const why = document.createElement('p');
    why.className = 'agent-confirm-why';
    why.textContent = pending.reason;
    card.append(why);
  }

  const buttons = document.createElement('div');
  buttons.className = 'agent-confirm-actions';
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'msg-action is-primary';
  allow.textContent = t('confirm.allow');
  allow.addEventListener('click', () => answerConfirm(turn, true));
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'msg-action';
  deny.textContent = t('confirm.deny');
  deny.addEventListener('click', () => answerConfirm(turn, false));
  buttons.append(allow, deny);
  card.append(buttons);
  return card;
}

function paintAgentBubble(turn, bubble) {
  // 다시 그리는 동안 승인 버튼의 포커스를 잃지 않게 기억해 둡니다.
  const focusedConfirm = bubble.contains(document.activeElement)
    ? document.activeElement?.textContent
    : null;
  bubble.replaceChildren();
  bubble.append(renderAgentSteps(turn));

  const pending = state.confirms.get(turn.id);
  if (pending) {
    const card = renderConfirmCard(turn, pending);
    bubble.append(card);
    const again = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === focusedConfirm);
    // 기본 포커스는 '거부' — 무심코 누른 Enter 가 위험한 동작을 승인하지 않게 합니다.
    (again ?? card.querySelector('.agent-confirm-actions button:last-child'))?.focus({ preventScroll: true });
  }

  if (turn.status === 'error') {
    const title = document.createElement('strong');
    title.textContent = turn.error?.title ?? t('msg.errorDefault');
    bubble.append(title);
    if (turn.error?.hint) {
      const hint = document.createElement('p');
      hint.style.margin = '4px 0 0';
      hint.textContent = turn.error.hint;
      bubble.append(hint);
    }
    return;
  }

  if (turn.content) {
    const body = document.createElement('div');
    body.className = 'agent-answer';
    body.innerHTML = renderMarkdown(turn.content);
    bubble.append(body);
    enhanceCodeBlocks(body);
  }
  if (turn.status === 'streaming' && !pending) {
    const dot = document.createElement('span');
    dot.className = 'typing';
    bubble.append(dot);
  }
  if (turn.status === 'stopped') {
    const note = document.createElement('p');
    note.style.cssText = 'margin:6px 0 0;font-size:11px;opacity:.7';
    note.textContent = t('msg.stopped');
    bubble.append(note);
  }
}

function answerConfirm(turn, allowed) {
  const pending = state.confirms.get(turn.id);
  if (!pending) return;
  state.confirms.delete(turn.id);
  pending.resolve(allowed);
  updateTurn(turn);
}

/** 승인 카드를 띄우고 사용자의 답(또는 중지)을 기다립니다. */
function askConfirm(turn, request, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const done = (value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      state.confirms.delete(turn.id);
      done(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    state.confirms.set(turn.id, { label: request.label, reason: request.reason, resolve: done });
    updateTurn(turn);
    scrollToBottom();
    setStatus(t('confirm.waiting'));
  });
}

function renderWelcome() {
  const box = document.createElement('div');
  box.className = 'welcome';

  const agentMode = Boolean(state.settings?.agentMode);
  const heading = document.createElement('h2');
  heading.textContent = t(agentMode ? 'welcome.agentTitle' : 'welcome.chatTitle');
  const lead = document.createElement('p');
  lead.textContent = t(agentMode ? 'welcome.agentLead' : 'welcome.chatLead');
  box.append(heading, lead);

  // 타이핑 없이 첫 질문을 던질 수 있게 카드로 배치합니다.
  const cards = document.createElement('div');
  cards.className = 'welcome-cards';
  const items = agentMode ? AGENT_EXAMPLES() : QUICK_PROMPTS().filter((entry) => entry.card);
  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'welcome-card';
    card.title = item.prompt;
    card.disabled = state.busy;

    const icon = document.createElement('span');
    icon.className = 'ico-wrap';
    icon.setAttribute('aria-hidden', 'true');
    const glyph = document.createElement('span');
    glyph.className = `ico ico-${item.icon ?? 'chat'}`;
    icon.append(glyph);

    const text = document.createElement('span');
    text.className = 'text';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.card;
    text.append(label);
    if (item.desc) {
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = item.desc;
      text.append(desc);
    }

    card.append(icon, text);
    card.addEventListener('click', () => send(item.prompt));
    cards.append(card);
  }
  box.append(cards);

  const note = document.createElement('p');
  note.className = 'welcome-note';
  note.textContent = t(agentMode ? 'welcome.agentNote' : 'welcome.chatNote');
  box.append(note);

  els.messages.replaceChildren(box);
}

function renderAll() {
  state.nodes.clear();
  if (state.turns.length === 0) {
    renderWelcome();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const turn of state.turns) {
    const node = buildMessageNode(turn);
    applyState(turn, node);
    fillActions(turn, node.actions);
    paintBubble(turn, node.bubble);
    state.nodes.set(turn.id, node);
    fragment.append(node.wrap);
  }
  els.messages.replaceChildren(fragment);
  scrollToBottom();
  updateQuickVisibility();
}

function appendTurn(turn) {
  const stick = nearBottom();
  if (state.turns.length === 0) els.messages.replaceChildren();
  state.turns.push(turn);

  // 직전 답변의 "다시 생성" 버튼을 갱신합니다.
  const previous = state.turns[state.turns.length - 2];
  if (previous) {
    const node = state.nodes.get(previous.id);
    if (node) fillActions(previous, node.actions);
  }

  const node = buildMessageNode(turn);
  applyState(turn, node);
  fillActions(turn, node.actions);
  paintBubble(turn, node.bubble);
  state.nodes.set(turn.id, node);
  els.messages.append(node.wrap);
  if (stick) scrollToBottom();
  updateQuickVisibility();
}

function updateTurn(turn, { force = false } = {}) {
  const node = state.nodes.get(turn.id);
  if (!node) {
    if (force) renderAll();
    return;
  }
  const stick = nearBottom();
  applyState(turn, node);
  paintBubble(turn, node.bubble);
  fillActions(turn, node.actions);
  if (stick) scrollToBottom();
}

/** 스트리밍 중에는 70ms 간격으로만 다시 그립니다. */
function createThrottledPainter(turn) {
  let timer = null;
  let last = 0;
  const paint = () => {
    last = Date.now();
    timer = null;
    updateTurn(turn);
  };
  return {
    tick() {
      if (timer !== null) return;
      const wait = Math.max(0, 70 - (Date.now() - last));
      timer = setTimeout(paint, wait);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      updateTurn(turn);
    },
  };
}

/* ------------------------------------------------------------- 전송 */

function setBusy(busy) {
  const active = document.activeElement;
  state.busy = busy;
  els.send.disabled = busy;
  els.stop.hidden = !busy;
  els.input.disabled = false; // 응답 중에도 다음 질문을 미리 적을 수 있게 둡니다.
  for (const button of els.quick.querySelectorAll('button')) button.disabled = busy;
  for (const card of els.messages.querySelectorAll('.welcome-card')) card.disabled = busy;

  // 방금 누른 버튼이 disabled 가 되면 포커스가 사라져 키보드 조작이 끊깁니다.
  if (busy && (active === els.send || active?.closest?.('#quick'))) els.stop.focus();
  else if (!busy && active === els.stop) els.input.focus();
}

/**
 * 질문을 보냅니다.
 * @param {string} text
 * @param {{contextMode?: string, selectionText?: string, fromInput?: boolean}} [options]
 *   fromInput: 입력창에서 보낸 경우에만 입력창을 비웁니다(작성 중인 초안 보호).
 */
async function send(text, { contextMode, selectionText, fromInput = false, agent } = {}) {
  const question = String(text ?? '').trim();
  if (!question || state.busy) return;
  if (agent ?? state.settings.agentMode) {
    await sendAgent(question, { fromInput });
    return;
  }

  hideBanner();
  const history = state.turns
    .filter((turn) => turn.status !== 'error')
    .map((turn) => ({ role: turn.role, content: turn.content }));

  const effectiveMode = contextMode ?? state.settings.contextMode;
  appendTurn({
    id: nextId(),
    role: 'user',
    content: question,
    status: 'done',
    at: Date.now(),
    // 다시 생성할 때 같은 조건을 재사용합니다.
    contextMode: effectiveMode,
  });
  if (fromInput) {
    els.input.value = '';
    autoGrow();
  }

  const answer = {
    id: nextId(),
    role: 'assistant',
    content: '',
    status: 'streaming',
    at: Date.now(),
  };
  appendTurn(answer);

  // 질문과 답변 자리를 먼저 저장해 둡니다. 응답 중에 패널이 닫혀도
  // 다시 열면 질문과 그때까지의 답변이 남아 있습니다.
  await persistConversation();

  const painter = createThrottledPainter(answer);
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  setStatus(t('send.waiting'));

  const effective = contextMode ? { ...state.settings, contextMode } : state.settings;

  const started = Date.now();
  try {
    // 질문 시점의 화면 내용을 쓰도록 매번 새로 읽습니다.
    // 이번 요청의 참조 범위를 함께 넘겨야 '참조 안 함' 설정에서도
    // 우클릭 "선택한 내용 묻기" 가 선택 영역을 보낼 수 있습니다.
    if (effective.contextMode !== 'off') await refreshContext(effective.contextMode);

    // 우클릭 시점의 선택 문장을 받아 두었고, 지금은 선택이 풀렸다면 그것을 씁니다.
    let page = state.page;
    if (selectionText && page && !page.selection) {
      page = { ...page, selection: String(selectionText) };
    }

    const messages = buildMessages({
      settings: effective,
      page,
      history,
      userText: question,
    });

    let firstChunkAt = 0;
    const result = await chat({
      settings: effective,
      messages,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          setStatus(t('send.streaming'));
        }
        answer.content += delta;
        painter.tick();
      },
    });

    answer.status = 'done';
    answer.content = result.text || answer.content;
    if (!answer.content.trim()) {
      answer.content = t('send.empty');
    }
    answer.ms = Date.now() - started;
    // 답변에서 인용한 문장 중 실제로 페이지 내용에 있는 것만 근거로 남깁니다.
    // 참조하지 않은 경우(off)에는 근거를 만들지 않습니다 — 모델이 본 적 없는 내용입니다.
    // 선택 영역은 사용자가 화면에서 직접 고른 텍스트이므로 대조 대상에 포함합니다.
    answer.citations =
      effective.contextMode === 'off'
        ? []
        : findCitations(answer.content, [page?.selection, page?.text].filter(Boolean).join('\n\n'));

    // 토큰 수는 일반 사용자에게 불필요한 인지 부하이므로 툴팁으로만 보여 줍니다.
    const seconds = (answer.ms / 1000).toFixed(1);
    const usage = result.usage;
    setStatus(
      t('send.done', { s: seconds }),
      usage?.total_tokens ? t('send.tokens', { n: fmt(usage.total_tokens) }) : '',
    );
  } catch (error) {
    const described = describeError(error, {
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
    });
    if (described.kind === 'aborted') {
      answer.status = answer.content ? 'stopped' : 'error';
      if (!answer.content) answer.error = { title: t('send.stoppedTitle'), hint: '' };
      setStatus(t('send.stopped'));
    } else {
      answer.status = 'error';
      answer.error = described;
      setStatus('');
      showBanner({
        title: described.title,
        hint: described.hint,
        action:
          described.kind === 'auth' || described.kind === 'config' || described.kind === 'notfound'
            ? { label: t('banner.openSettings'), run: openOptions }
            : { label: t('banner.retry'), run: () => regenerate() },
      });
      console.warn('[page-chatbot]', error);
    }
  } finally {
    state.controller = null;
    setBusy(false);
    painter.flush();
    await persistConversation();

    await drainAfterRun();
  }
}

/** 응답 중에 쌓인 일(탭 이동, 우클릭 요청)을 순서대로 처리합니다. */
async function drainAfterRun({ refresh = false } = {}) {
  const queued = state.queuedPrompt;
  state.queuedPrompt = null;
  const nextTab = state.pendingTabId;
  state.pendingTabId = null;

  if (nextTab != null && nextTab !== state.tabId) {
    await switchTab(nextTab);
  } else if (queued?.prompt) {
    send(queued.prompt, {
      contextMode: queued.intent === 'selection' ? 'selection' : undefined,
      selectionText: queued.selectionText,
      agent: false,
    });
  } else if (refresh) {
    await refreshContext(undefined, { force: true });
  } else {
    renderContextBar();
  }
}

/**
 * 에이전트 모드: 모델이 도구를 호출해 브라우저를 직접 조작합니다.
 * 대화에는 사용자 지시와 최종 보고만 남기고, 중간 동작은 단계 목록으로 보여 줍니다.
 */
async function sendAgent(question, { fromInput = false } = {}) {
  hideBanner();
  if (state.tabId == null) {
    setStatus(t('ctx.noTab'));
    return;
  }

  const limit = state.settings.historyTurns;
  const history =
    limit > 0
      ? state.turns
          .filter((turn) => turn.status !== 'error' && String(turn.content ?? '').trim())
          .slice(-limit)
          .map((turn) => ({ role: turn.role, content: turn.content }))
      : [];

  appendTurn({ id: nextId(), role: 'user', content: question, status: 'done', at: Date.now(), agent: true });
  if (fromInput) {
    els.input.value = '';
    autoGrow();
  }
  const answer = {
    id: nextId(),
    role: 'assistant',
    kind: 'agent',
    content: '',
    steps: [],
    status: 'streaming',
    at: Date.now(),
  };
  appendTurn(answer);
  await persistConversation();

  const settings = state.settings;
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  setStatus(t('agent.reading'));

  const painter = createThrottledPainter(answer);
  const startTab = state.tabId;
  const executor = createBrowserExecutor({ tabId: state.tabId, windowId: state.windowId });
  const started = Date.now();
  const total = settings.agentMaxSteps;

  try {
    const result = await runAgent({
      task: question,
      history,
      systemPrompt: buildAgentSystemPrompt({ maxSteps: total }),
      callModel: (messages, { tools, signal }) => {
        const done = answer.steps.length;
        setStatus(done === 0 ? t('agent.planning') : t('agent.deciding', { done, total }));
        return chatWithTools({ settings, messages, tools, signal });
      },
      executor,
      confirm: (request) => askConfirm(answer, request, controller.signal),
      onStep: (step, steps) => {
        answer.steps = steps.map(({ id, name, label, status, result, reason }) => ({
          id,
          name,
          label,
          status,
          result,
          reason,
        }));
        if (step.status === 'running') setStatus(`${steps.length}/${total} · ${step.label}`);
        painter.tick();
      },
      signal: controller.signal,
      maxSteps: total,
      confirmMode: settings.agentConfirm,
    });

    answer.status = 'done';
    answer.content =
      result.text ||
      (result.steps.length > 0
        ? t('agent.noSummary')
        : t('send.empty'));
    if (result.outcome === 'max_steps') {
      answer.content += `\n\n${t('agent.maxSteps', { n: total })}`;
    }
    answer.ms = Date.now() - started;
    const seconds = (answer.ms / 1000).toFixed(1);
    setStatus(
      t('agent.done', { n: result.steps.length, s: seconds }),
      result.usage?.total_tokens ? t('send.tokens', { n: fmt(result.usage.total_tokens) }) : '',
    );
  } catch (error) {
    if (controller.signal.aborted) {
      // 진행 중이던(또는 승인을 기다리던) 단계는 실행되지 않았음을 표시합니다.
      answer.steps = answer.steps.map((step) =>
        step.status === 'running' || step.status === 'confirm'
          ? { ...step, status: 'denied', result: t('agent.stepStopped') }
          : step,
      );
      answer.status = answer.steps.length > 0 || answer.content ? 'stopped' : 'error';
      if (answer.status === 'error') answer.error = { title: t('send.stoppedTitle'), hint: '' };
      setStatus(t('send.stopped'));
    } else {
      const described = describeError(error, { baseUrl: settings.baseUrl, model: settings.model });
      if (described.kind === 'badrequest') {
        described.hint =
          t('agent.toolHint', { model: settings.model }) +
          (described.hint ?? '');
      }
      answer.status = 'error';
      answer.error = described;
      setStatus('');
      showBanner({
        title: described.title,
        hint: described.hint,
        action:
          described.kind === 'auth' || described.kind === 'config' || described.kind === 'notfound'
            ? { label: t('banner.openSettings'), run: openOptions }
            : { label: t('banner.retry'), run: () => regenerate() },
      });
      console.warn('[page-chatbot] agent', error);
    }
  } finally {
    state.confirms.delete(answer.id);
    state.controller = null;
    setBusy(false);
    painter.flush();
    executor.cleanup();

    // 에이전트가 다른 탭으로 옮겨 갔다면 대화도 그 탭으로 가져갑니다.
    // (사용자가 직접 다른 탭을 고른 경우는 그대로 그 탭으로 따라갑니다.)
    const endTab = executor.tabId;
    const moved = endTab !== startTab;
    if (moved) {
      await persistConversation(startTab, state.turns, state.tabUrl);
      state.tabId = endTab;
      state.tabUrl = '';
      state.page = null;
      state.pageError = '';
      if (state.pendingTabId === endTab) state.pendingTabId = null;
    }
    await persistConversation();
    await drainAfterRun({ refresh: true });
  }
}

function regenerate() {
  if (state.busy) return;
  const lastUser = [...state.turns].reverse().find((turn) => turn.role === 'user');
  if (!lastUser) return;

  // 마지막 사용자 질문 이후의 턴을 걷어내고 다시 물어봅니다.
  const index = state.turns.lastIndexOf(lastUser);
  state.turns = state.turns.slice(0, index);
  renderAll();
  send(lastUser.content, lastUser.agent ? { agent: true } : { contextMode: lastUser.contextMode, agent: false });
}

async function newChat() {
  if (state.busy) state.controller?.abort();
  state.turns = [];
  state.nodes.clear();
  state.quickOpen = false;
  renderAll();
  setStatus('');
  hideBanner();
  await persistConversation();
  els.input.focus();
}

const openOptions = () => {
  chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {
    chrome.runtime.openOptionsPage?.();
  });
};

/* -------------------------------------------------------------- 모델 */

async function refreshModels() {
  const current = state.settings.model;
  const paint = (ids, note) => {
    els.model.replaceChildren();
    const list = ids.includes(current) ? ids : [current, ...ids].filter(Boolean);
    for (const id of list) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      els.model.append(option);
    }
    if (note) {
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = note;
      els.model.append(option);
    }
    els.model.value = current;
  };

  paint([], t('models.loading'));
  // 앞선 요청이 늦게 도착해 최신 목록을 덮어쓰지 않도록 취소합니다.
  state.modelsController?.abort();
  const controller = new AbortController();
  state.modelsController = controller;
  try {
    const ids = await listModels({
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    paint(ids, ids.length ? '' : t('models.none'));
  } catch (error) {
    const described = describeError(error, { baseUrl: state.settings.baseUrl });
    if (described.kind === 'aborted') return; // 새 요청이 시작된 경우
    paint([], t('models.failed'));
    if (described.kind === 'network') {
      showBanner({
        title: described.title,
        hint: described.hint,
        action: { label: t('banner.openSettings'), run: openOptions },
      });
    }
  }
}

/* --------------------------------------------------------- 입력 동작 */

function autoGrow() {
  els.input.style.height = 'auto';
  // box-sizing: border-box 이므로 테두리 두께를 더해야 스크롤바 없이 딱 맞습니다.
  const border = els.input.offsetHeight - els.input.clientHeight;
  els.input.style.height = `${Math.min(els.input.scrollHeight + border, 160)}px`;
}

function renderQuick() {
  els.quick.replaceChildren();
  for (const item of QUICK_PROMPTS()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.title = item.prompt;
    button.disabled = state.busy;
    button.addEventListener('click', () => send(item.prompt));
    els.quick.append(button);
  }
  updateQuickVisibility();
}

/**
 * 빈 상태에서는 카드가 그 역할을 하므로 칩 줄을 숨깁니다.
 * 대화가 시작되면 기본적으로 접어 두고(대화 본문 가시성 우선) 토글로 펼칩니다.
 */
function updateQuickVisibility() {
  const hasConversation = state.turns.length > 0;
  els.quickToggle.hidden = !hasConversation;
  // 빈 상태: 카드가 이미 크게 보여 주므로 칩 줄은 숨깁니다(중복 제거).
  // 대화 시작 후: 기본 접힘 — 토글로 펼칩니다.
  els.quick.hidden = !hasConversation || !state.quickOpen;
  els.quickToggle.setAttribute('aria-expanded', String(Boolean(state.quickOpen)));
  els.quickToggle.title = t(state.quickOpen ? 'quick.collapse' : 'quick.expand');
  if (!els.quick.hidden) updateQuickFade();
}

/** 오른쪽에 더 있는지 알리는 페이드 — 끝까지 스크롤하면 걷습니다. */
function updateQuickFade() {
  const el = els.quick;
  const atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < 4;
  el.dataset.atEnd = String(atEnd);
}

/* ------------------------------------------------------- 대기 중 요청 */

async function consumePending() {
  if (state.tabId == null) return;
  const key = pendingKey(state.tabId);
  let payload = null;
  try {
    const stored = await chrome.storage.session.get(key);
    payload = stored?.[key] ?? null;
    if (payload) await chrome.storage.session.remove(key);
  } catch {
    return;
  }
  if (!payload?.prompt) return;
  // 30초보다 오래된 요청은 무시합니다(이전에 열었던 흔적).
  if (payload.createdAt && Date.now() - payload.createdAt > 30000) return;

  // 응답 중이면 버리지 않고 기억해 두었다가 끝난 뒤 실행합니다.
  if (state.busy) {
    state.queuedPrompt = payload;
    setStatus(t('send.streaming'));
    return;
  }

  send(payload.prompt, {
    contextMode: payload.intent === 'selection' ? 'selection' : undefined,
    selectionText: payload.selectionText,
    agent: false, // 우클릭 메뉴는 읽기 요청이므로 에이전트 모드여도 대답으로 처리합니다.
  });
}

/* ------------------------------------------------------------ 초기화 */

async function switchTab(tabId) {
  if (tabId === state.tabId) return;
  if (state.busy) {
    // 응답 중에는 옮기지 않고 기억해 두었다가, 끝난 뒤 그 탭으로 따라갑니다.
    state.pendingTabId = tabId;
    renderContextBar();
    return;
  }

  // 다른 탭으로 옮기기 전에 이 탭에 남은 선택 오버레이를 치웁니다.
  if (state.picking) await cancelPicking({ silent: true });

  const gen = ++state.switchGen;
  state.ctxGen += 1; // 진행 중인 컨텍스트 읽기를 폐기합니다.
  await persistConversation(state.tabId, state.turns, state.tabUrl);
  if (gen !== state.switchGen) return;

  state.tabId = tabId;
  state.page = null;
  state.pageError = '';
  state.tabUrl = '';
  await restoreConversation(tabId);
  if (gen !== state.switchGen) return;

  renderAll();
  setStatus('');
  hideBanner();
  await refreshContext();
  if (gen !== state.switchGen) return;
  await consumePending();
}

/** 테마를 적용하고, 버튼은 '누르면 바뀔 테마' 의 아이콘(라이트면 달, 다크면 해)을 보여 줍니다. */
function renderTheme() {
  const theme = state.settings?.theme ?? 'system';
  applyTheme(theme);
  const dark = effectiveTheme(theme) === 'dark';
  const icon = els.theme.querySelector('.ico');
  icon.className = `ico ${dark ? 'ico-sun' : 'ico-moon'}`;
  const label = t(dark ? 'theme.toLight' : 'theme.toDark');
  els.theme.title = label;
  els.themeLabel.textContent = label;
  els.theme.setAttribute('aria-pressed', String(dark));
}

/** 에이전트 모드 여부에 맞춰 토글·입력창 안내·빈 화면을 바꿉니다. */
function applyAgentUi() {
  const on = Boolean(state.settings?.agentMode);
  els.agent.setAttribute('aria-checked', String(on));
  els.chat.setAttribute('aria-checked', String(!on));
  els.agent.tabIndex = on ? 0 : -1;
  els.chat.tabIndex = on ? -1 : 0;
  document.body.classList.toggle('is-agent', on);
  els.input.placeholder = t(on ? 'input.agentPlaceholder' : 'input.chatPlaceholder');
  if (state.turns.length === 0) renderWelcome();
}

function wireUi() {
  els.send.addEventListener('click', () => send(els.input.value, { fromInput: true }));
  els.stop.addEventListener('click', () => state.controller?.abort());
  els.newChat.addEventListener('click', () => newChat());
  els.settings.addEventListener('click', openOptions);
  els.refresh.addEventListener('click', () => refreshContext(undefined, { force: true }));
  els.bannerClose.addEventListener('click', hideBanner);

  els.quickToggle.addEventListener('click', () => {
    state.quickOpen = !state.quickOpen;
    updateQuickVisibility();
  });
  els.quick.addEventListener('scroll', updateQuickFade, { passive: true });
  window.addEventListener('resize', updateQuickFade);

  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', (event) => {
    // 한글 등 IME 조합 중의 Enter 는 확정 키이므로 전송하지 않습니다.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      send(els.input.value, { fromInput: true });
    }
  });

  // 어디에 포커스가 있어도 Esc 로 생성 중지·입력 위치 선택 취소가 되게 합니다.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.picking) {
      event.preventDefault();
      cancelPicking();
      return;
    }
    if (state.busy) {
      event.preventDefault();
      state.controller?.abort();
    }
  });

  els.ctxMode.addEventListener('change', async () => {
    state.settings = await saveSettings({ contextMode: els.ctxMode.value });
    await refreshContext();
  });

  const setMode = async (agentMode) => {
    if (state.busy || agentMode === state.settings.agentMode) return;
    state.settings = await saveSettings({ agentMode });
    applyAgentUi();
    setStatus(t(agentMode ? 'mode.agentOn' : 'mode.chatOn'));
    els.input.focus();
  };
  els.theme.addEventListener('click', async () => {
    state.settings = await saveSettings({ theme: nextTheme(state.settings.theme) });
    renderTheme();
  });
  // '시스템 설정 따름' 일 때 운영체제 테마가 바뀌면 버튼 아이콘도 맞춥니다.
  onSystemThemeChange(() => renderTheme());

  els.chat.addEventListener('click', () => setMode(false));
  els.agent.addEventListener('click', () => setMode(true));
  // 라디오 그룹답게 좌우 화살표로도 바꿀 수 있게 합니다.
  for (const button of [els.chat, els.agent]) {
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = button === els.chat ? els.agent : els.chat;
      next.focus();
      setMode(next === els.agent);
    });
  }

  els.model.addEventListener('change', async () => {
    if (!els.model.value) return;
    state.settings = await saveSettings({ model: els.model.value });
    setStatus(t('models.changed', { model: state.settings.model }));
  });

  if (state.embedded) {
    els.close.hidden = false;
    els.close.addEventListener('click', () => {
      chrome.runtime
        .sendMessage({ type: 'close-inpage-panel', tabId: state.tabId })
        .catch(() => {});
    });
  }

  onSettingsChanged((settings) => {
    const baseChanged =
      settings.baseUrl !== state.settings.baseUrl || settings.apiKey !== state.settings.apiKey;
    const contextChanged =
      settings.contextMode !== state.settings.contextMode ||
      settings.maxContextChars !== state.settings.maxContextChars;
    const agentChanged = settings.agentMode !== state.settings.agentMode;
    const themeChanged = settings.theme !== state.settings.theme;
    const languageChanged = settings.language !== state.settings.language;
    state.settings = settings;
    if (themeChanged) renderTheme();
    if (languageChanged) {
      // 고정 문구·빠른 질문·대화(버튼 문구)·테마 버튼까지 새 언어로 다시 그립니다.
      applyLanguage();
      renderQuick();
      renderTheme();
      applyAgentUi();
      renderAll();
    }
    els.ctxMode.value = settings.contextMode;
    if (agentChanged) applyAgentUi();
    // 목록을 다시 불러야 하는 경우는 한 번만 호출합니다.
    if (baseChanged || els.model.value !== settings.model) refreshModels();
    if (contextChanged) refreshContext();
    else renderContextBar();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'pending-prompt' && message.tabId === state.tabId) {
      consumePending();
    }
    if (message?.type === 'insert-result') {
      onInsertResult(message);
    }
    return false;
  });
}

/**
 * 탭 이벤트 구독은 현재 탭을 확정한 뒤에 시작합니다.
 * 초기화 중에 onActivated 가 끼어들면 resolveTab 이 그 전환을 덮어써서
 * 옛 탭에 고착되고, 직전 탭의 대화가 빈 배열로 지워집니다.
 */
function wireTabEvents() {
  if (!state.embedded) {
    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
      if (state.windowId != null && windowId !== state.windowId) return;
      switchTab(tabId);
    });
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // 페이지가 바뀌면 그 탭의 캐시는 더 이상 유효하지 않습니다.
    if (changeInfo.url || changeInfo.status === 'loading') state.pageCache.delete(tabId);
    if (tabId !== state.tabId) return;
    if (changeInfo.status === 'complete' || changeInfo.url) {
      if (!state.busy) refreshContext(undefined, { force: true });
    }
  });
}

/** 설정의 언어(자동이면 브라우저 언어)를 적용하고 화면의 고정 문구를 번역합니다. */
function applyLanguage() {
  setLanguage(resolveLanguage(state.settings?.language));
  localizeDocument(document);
}

async function init() {
  state.settings = await loadSettings();
  applyLanguage();
  els.ctxMode.value = state.settings.contextMode;
  renderTheme();
  applyAgentUi();
  renderQuick();
  wireUi();
  autoGrow();

  await resolveTab();
  await restoreConversation();
  renderAll();
  // 탭이 확정된 뒤에 탭 이벤트를 구독합니다.
  wireTabEvents();
  refreshModels();
  await refreshContext();
  await consumePending();
  // 컨텍스트 메뉴는 "패널 열기" 를 먼저 하고 요청 저장을 그 뒤에 하므로,
  // 아주 빠르게 열린 경우를 대비해 한 번 더 확인합니다.
  setTimeout(() => consumePending(), 400);
  // 빈 상태에서는 포커스를 두지 않습니다. 포커스가 있으면 입력창 아래가
  // 단축키 힌트로 바뀌어, 첫 화면에서 "무엇을 참조 중인지" 가 가려집니다.
  if (state.turns.length > 0) els.input.focus();
}

init().catch((error) => {
  console.error('[page-chatbot] 초기화 실패:', error);
  showBanner({
    title: t('init.failed'),
    hint: String(error?.message ?? error),
    action: { label: t('banner.openSettings'), run: openOptions },
  });
});
