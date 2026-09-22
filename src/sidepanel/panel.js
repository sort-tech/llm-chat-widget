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
import { chat, describeError, listModels } from '../lib/llm.js';
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
};

/**
 * 빠른 질문.
 *   label  — 입력창 위 칩에 쓰는 짧은 이름
 *   card   — 빈 상태 카드에 쓰는 문구(무엇을 해 주는지 한눈에)
 *   emoji  — 카드 아이콘. onboarding 에서만 씁니다.
 * card 가 있는 항목만 빈 상태 카드로 보여 줍니다(6개 = 2열 × 3행).
 */
const QUICK_PROMPTS = [
  {
    label: '요약',
    emoji: '📌',
    card: '3줄 핵심 요약',
    prompt: '이 페이지의 핵심 내용을 5줄 이내로 요약해 주세요.',
  },
  {
    label: '핵심 포인트',
    emoji: '🔑',
    card: '중요 포인트 뽑기',
    prompt: '이 페이지에서 가장 중요한 포인트를 불릿으로 정리해 주세요.',
  },
  {
    label: '표로 정리',
    emoji: '📊',
    card: '표로 한눈에 정리',
    prompt: '이 페이지의 주요 정보를 표로 정리해 주세요.',
  },
  {
    label: '쉽게 설명',
    emoji: '🌐',
    card: '쉬운 말로 풀기',
    prompt: '이 페이지 내용을 비전문가도 이해할 수 있게 쉬운 말로 설명해 주세요.',
  },
  {
    label: '용어 정리',
    emoji: '🗂',
    card: '나오는 용어 정리',
    prompt: '이 페이지에 나오는 주요 용어를 뜻과 함께 정리해 주세요.',
  },
  {
    label: '다음 행동',
    emoji: '➡️',
    card: '다음에 할 일 제안',
    prompt: '이 페이지를 읽은 사람이 이어서 확인하거나 실행하면 좋을 일을 제안해 주세요.',
  },
  {
    label: '한국어 번역',
    prompt:
      '이 페이지 본문을 자연스러운 한국어로 번역해 주세요. 분량이 많으면 핵심 단락부터 번역하고 그 사실을 알려 주세요.',
  },
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
  const queued = state.queuedPrompt ? ' · 대기 중인 요청 1건' : '';
  els.status.textContent = `${text ?? ''}${text ? queued : ''}`;
  els.status.title = tooltip;
};

const fmt = (n) => Number(n ?? 0).toLocaleString('ko-KR');

/** 받침 유무에 따라 목적격 조사를 고릅니다('페이지를' / '영역을'). */
const objectParticle = (word) => {
  const last = String(word ?? '').trim().slice(-1);
  const code = last.charCodeAt(0);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return '를';
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
};

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
    setTop('loading', '다른 탭으로 이동했습니다', '응답이 끝나면 그 탭의 대화로 전환합니다');
    setBadge('응답이 끝나면 새 탭으로 전환합니다');
    return;
  }

  if (mode === 'off') {
    setTop('off', '페이지를 참조하지 않습니다', '일반 챗봇처럼 동작합니다');
    setBadge('페이지 참조 안 함', '참조 범위를 바꾸면 현재 페이지를 함께 보냅니다', 'off');
    return;
  }

  if (state.pageLoading) {
    setTop('loading', '페이지를 읽는 중…');
    setBadge('페이지를 읽는 중…');
    return;
  }

  if (state.pageError) {
    setTop('warn', '페이지를 읽을 수 없습니다', state.pageError);
    setBadge(state.pageError, state.pageError, 'off');
    return;
  }

  const page = state.page;
  if (!page) {
    setTop('warn', '읽은 페이지가 없습니다', '⟳ 를 눌러 다시 시도하세요');
    setBadge('참조할 내용이 없습니다', '⟳ 를 눌러 다시 읽어 보세요', 'off');
    return;
  }

  if (!page.text && !page.selection) {
    const why = page.hasFrames
      ? '본문이 내부 프레임(iframe)에 있어 읽지 못했습니다'
      : page.hasShadowRoots
        ? '웹 컴포넌트(shadow DOM) 안에서도 글자를 찾지 못했습니다'
        : 'PDF·이미지이거나 아직 로딩 중일 수 있습니다';
    setTop('warn', page.title || '본문을 찾지 못했습니다', why);
    setBadge('참조할 내용이 없습니다', why, 'off');
    return;
  }

  // 정상 — 제목은 위에, 분량·참조 범위는 입력창 아래 뱃지에.
  const scopeName = mode === 'selection' && page.selection ? '선택 영역' : '전체 페이지';
  setTop(
    'ok',
    page.title || page.url || '제목 없음',
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
    `${scopeName}${objectParticle(scopeName)} 참조합니다`,
    `본문 ${fmt(page.charCount)}자 중 ${fmt(shown)}자 전송`,
    context ? `약 ${fmt(approxTokens(context))} 토큰` : '',
    page.truncated || page.depthClipped ? '본문이 매우 길어 일부만 읽었습니다' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  setBadge(`${scopeName} 참조 중 · ${fmt(shown)}자`, tip);
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
    state.pageError = '현재 탭을 확인할 수 없습니다.';
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
        ? `본문 추출 실패: ${failure.error}`
        : '본문을 추출하지 못했습니다.';
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
            source: `${richest.source} (내부 프레임)`,
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
      : `본문을 읽지 못했습니다: ${message}`;
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
    args: [options],
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
  if (!silent && picking) setStatus('입력을 취소했습니다.');
}

/**
 * 답변을 웹페이지 입력창에 넣습니다.
 *   1) 이미 포커스된 입력창이 있으면 그대로 넣습니다(선택 단계 없음).
 *   2) 없으면 웹페이지에서 위치를 고르는 선택 모드로 넘어갑니다.
 *   3) 입력창을 하나도 못 찾으면(캔버스 기반 편집기 등) 복사를 안내합니다.
 */
async function insertIntoPage(turn, button) {
  if (state.tabId == null) {
    setStatus('현재 탭을 확인할 수 없습니다.');
    return;
  }
  const url = await currentTabUrl();
  if (!isInjectable(url)) {
    showBanner({ title: '이 페이지에는 입력할 수 없습니다.', hint: describeRestriction(url) });
    return;
  }

  // 마크다운 기호가 폼에 그대로 들어가지 않도록 평문으로 바꿉니다.
  const text = toPlainText(turn.content);
  if (!text.trim()) {
    setStatus('넣을 내용이 없습니다.');
    return;
  }

  await cancelPicking({ silent: true });
  hideBanner();

  let outcomes;
  try {
    outcomes = await runInsertInTab({ mode: 'auto', text });
  } catch (error) {
    showBanner({ title: '입력 위치를 찾지 못했습니다.', hint: String(error?.message ?? error) });
    return;
  }

  if (outcomes.some((outcome) => outcome.status === 'inserted')) {
    setStatus('입력 완료');
    return;
  }

  if (outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'noTargets')) {
    showBanner({
      title: '이 페이지는 자동 입력을 지원하지 않습니다.',
      hint: '입력할 수 있는 칸을 찾지 못했습니다(구글 문서·피그마처럼 화면을 직접 그리는 편집기). 답변을 복사해 붙여 넣어 주세요.',
      action: {
        label: '답변 복사',
        run: async () => {
          const ok = await copyText(turn.content);
          setStatus(ok ? '답변을 복사했습니다.' : '복사하지 못했습니다.');
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
      setStatus('입력할 위치를 찾지 못했습니다.');
      return;
    }
  } catch (error) {
    setStatus(`입력 위치 선택을 시작하지 못했습니다: ${String(error?.message ?? error)}`);
    return;
  }

  state.picking = { button, label };
  if (button) button.textContent = '선택 중…';
  setStatus('웹페이지에서 입력할 위치를 선택하세요 (취소: ESC)');
}

/** 컨텐츠 스크립트가 보내는 선택 결과. */
function onInsertResult(message) {
  const picking = state.picking;
  state.picking = null;
  if (picking?.button) picking.button.textContent = picking.label;

  if (message.status === 'inserted') setStatus('입력 완료');
  else if (message.status === 'cancelled') setStatus('입력을 취소했습니다.');
  else setStatus('입력하지 못했습니다. 다른 입력창을 골라 보세요.');

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
    setCiteStatus('현재 탭을 확인할 수 없습니다.');
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
      if (partial > 0) notes.push('문장 앞부분만 일치해 그 부분만 표시했습니다');
      if (!styled) notes.push('색을 적용하지 못해 위치로만 이동했습니다');
      setCiteStatus(notes.length ? `근거 표시 — ${notes.join(' · ')}` : '페이지에서 근거를 표시했습니다.');
      if (chip) {
        chip.dataset.state = partial > 0 ? 'partial' : 'found';
        chip.textContent = partial > 0 ? '일부 표시' : '표시됨';
        if (chip.dataset.timer) clearTimeout(Number(chip.dataset.timer));
        chip.dataset.timer = String(setTimeout(restore, 1400));
      }
    } else if (!supported) {
      setCiteStatus('이 브라우저는 하이라이트 기능을 지원하지 않습니다.');
    } else if (truncated) {
      setCiteStatus('문서가 매우 길어 앞부분에서만 찾았습니다. 해당 위치를 찾지 못했습니다.');
    } else {
      setCiteStatus('페이지에서 그 문장을 찾지 못했습니다(내용이 바뀐 것 같습니다).');
    }
  } catch (error) {
    setCiteStatus(`근거 표시 실패: ${String(error?.message ?? error)}`);
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
  caption.title = '칩을 누르면 페이지에서 그 문장을 찾아 표시하고 그 위치로 이동합니다.';
  caption.textContent = '근거 — 누르면 본문 위치로 이동';
  box.append(caption);

  for (const quote of quotes) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cite-chip';
    chip.title = quote.exact
      ? `페이지에서 찾아 표시: ${quote.text}`
      : `원문과 완전히 같지 않아 앞부분만 확인됨: ${quote.text}`;
    const label = quote.text.length > 26 ? `${quote.text.slice(0, 26)}…` : quote.text;
    // 📍 는 '위치로 이동' 을 연상시키는 단서입니다(태그가 아니라 버튼임을 알림).
    chip.textContent = quote.exact ? `📍 ${label}` : `📍 ${label} (일부)`;
    // 클릭 피드백 후 되돌릴 이름을 DOM 이 아닌 dataset 에 보관합니다.
    chip.dataset.label = chip.textContent;
    if (!quote.exact) chip.dataset.exact = 'false';
    chip.addEventListener('click', () => showCitation(quote.text, chip));
    box.append(chip);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'cite-chip is-clear';
  clear.textContent = '표시 지우기';
  clear.dataset.label = clear.textContent;
  clear.addEventListener('click', () => clearCitations());
  box.append(clear);

  bubble.append(box);
}

/* -------------------------------------------------------------- 렌더링 */

const ROLE_LABEL = { user: '나', assistant: 'AI' };

function buildMessageNode(turn) {
  const wrap = document.createElement('article');
  wrap.className = `msg msg-${turn.role}`;
  wrap.dataset.id = turn.id;

  // 역할 라벨은 화면에서 지웠습니다(말풍선 모양·정렬로 구분). 다만 화면 낭독기에는
  // 누가 한 말인지 알려야 하므로 보이지 않는 라벨을 남깁니다.
  const role = document.createElement('span');
  role.className = 'sr-only';
  role.textContent = ROLE_LABEL[turn.role] ?? turn.role;

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
  if (turn.role !== 'assistant' || !text) {
    actions.hidden = true;
    return;
  }
  actions.hidden = false;

  // 이 확장 프로그램의 핵심 액션이므로 가장 먼저, 눈에 띄게 둡니다.
  if (turn.status !== 'error') {
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'msg-action is-primary';
    insert.textContent = '본문 입력';
    insert.dataset.label = '본문 입력';
    insert.title =
      '웹페이지의 입력창에 이 답변을 넣습니다. 커서가 있는 칸이 있으면 바로, 없으면 페이지에서 위치를 고릅니다.';
    insert.addEventListener('click', () => insertIntoPage(turn, insert));
    actions.append(insert);
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-action';
  copy.textContent = '복사';
  copy.addEventListener('click', async () => {
    const ok = await copyText(turn.content ?? '');
    copy.textContent = ok ? '복사됨' : '실패';
    setTimeout(() => {
      copy.textContent = '복사';
    }, 1200);
  });
  actions.append(copy);

  const isLast = state.turns[state.turns.length - 1]?.id === turn.id;
  if (isLast && !state.busy) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'msg-action';
    again.textContent = '다시 생성';
    again.addEventListener('click', () => regenerate());
    actions.append(again);
  }
}

function paintBubble(turn, bubble) {
  if (turn.role === 'user') {
    bubble.textContent = turn.content;
    return;
  }

  if (turn.status === 'error') {
    bubble.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = turn.error?.title ?? '오류가 발생했습니다.';
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
    note.textContent = '(중지됨)';
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
    button.textContent = '복사';
    button.style.cssText =
      'position:absolute;top:5px;right:5px;padding:1px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg-muted);font-size:10.5px;cursor:pointer';
    button.addEventListener('click', async () => {
      const ok = await copyText(pre.querySelector('code')?.textContent ?? '');
      button.textContent = ok ? '복사됨' : '실패';
      setTimeout(() => {
        button.textContent = '복사';
      }, 1200);
    });
    pre.append(button);
  }
}

function renderWelcome() {
  const box = document.createElement('div');
  box.className = 'welcome';

  const heading = document.createElement('h2');
  heading.textContent = '이 페이지를 함께 읽습니다';
  const lead = document.createElement('p');
  lead.textContent = '아래를 눌러 바로 시작하거나, 직접 질문을 입력하세요.';
  box.append(heading, lead);

  // 타이핑 없이 첫 질문을 던질 수 있게 카드로 배치합니다.
  const cards = document.createElement('div');
  cards.className = 'welcome-cards';
  for (const item of QUICK_PROMPTS.filter((entry) => entry.card)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'welcome-card';
    card.title = item.prompt;
    card.disabled = state.busy;

    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = item.emoji ?? '💬';
    emoji.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.card;

    card.append(emoji, label);
    card.addEventListener('click', () => send(item.prompt));
    cards.append(card);
  }
  box.append(cards);

  const note = document.createElement('p');
  note.className = 'welcome-note';
  note.textContent =
    '페이지에서 원하는 부분을 선택한 뒤 위쪽 참조 범위를 “선택 영역”으로 바꾸면 그 부분만 봅니다.';
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
async function send(text, { contextMode, selectionText, fromInput = false } = {}) {
  const question = String(text ?? '').trim();
  if (!question || state.busy) return;

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
  setStatus('응답을 기다리는 중…');

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
          setStatus('응답 중…');
        }
        answer.content += delta;
        painter.tick();
      },
    });

    answer.status = 'done';
    answer.content = result.text || answer.content;
    if (!answer.content.trim()) {
      answer.content = '_(모델이 빈 응답을 반환했습니다. 다시 시도해 보세요.)_';
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
      `완료 · ${seconds}초`,
      usage?.total_tokens ? `사용 토큰 ${fmt(usage.total_tokens)}` : '',
    );
  } catch (error) {
    const described = describeError(error, {
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
    });
    if (described.kind === 'aborted') {
      answer.status = answer.content ? 'stopped' : 'error';
      if (!answer.content) answer.error = { title: '요청을 중지했습니다.', hint: '' };
      setStatus('중지됨');
    } else {
      answer.status = 'error';
      answer.error = described;
      setStatus('');
      showBanner({
        title: described.title,
        hint: described.hint,
        action:
          described.kind === 'auth' || described.kind === 'config' || described.kind === 'notfound'
            ? { label: '설정 열기', run: openOptions }
            : { label: '다시 시도', run: () => regenerate() },
      });
      console.warn('[page-chatbot]', error);
    }
  } finally {
    state.controller = null;
    setBusy(false);
    painter.flush();
    await persistConversation();

    // 응답 중에 쌓인 일들을 순서대로 처리합니다.
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
      });
    } else {
      renderContextBar();
    }
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
  send(lastUser.content, { contextMode: lastUser.contextMode });
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

  paint([], '불러오는 중…');
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
    paint(ids, ids.length ? '' : '(서버에 등록된 모델 없음)');
  } catch (error) {
    const described = describeError(error, { baseUrl: state.settings.baseUrl });
    if (described.kind === 'aborted') return; // 새 요청이 시작된 경우
    paint([], '(목록 불러오기 실패)');
    if (described.kind === 'network') {
      showBanner({
        title: described.title,
        hint: described.hint,
        action: { label: '설정 열기', run: openOptions },
      });
    }
  }
}

/* --------------------------------------------------------- 입력 동작 */

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function renderQuick() {
  els.quick.replaceChildren();
  for (const item of QUICK_PROMPTS) {
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
  els.quickToggle.title = state.quickOpen ? '빠른 질문 접기' : '빠른 질문 펼치기';
  const arrow = els.quickToggle.querySelector('span[aria-hidden]');
  if (arrow) arrow.textContent = state.quickOpen ? '▴' : '▾';
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
    setStatus('응답 중…');
    return;
  }

  send(payload.prompt, {
    contextMode: payload.intent === 'selection' ? 'selection' : undefined,
    selectionText: payload.selectionText,
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

  els.model.addEventListener('change', async () => {
    if (!els.model.value) return;
    state.settings = await saveSettings({ model: els.model.value });
    setStatus(`모델을 ${state.settings.model} 로 바꿨습니다.`);
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
    state.settings = settings;
    els.ctxMode.value = settings.contextMode;
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

async function init() {
  state.settings = await loadSettings();
  els.ctxMode.value = state.settings.contextMode;
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
    title: '패널을 초기화하지 못했습니다.',
    hint: String(error?.message ?? error),
    action: { label: '설정 열기', run: openOptions },
  });
});
