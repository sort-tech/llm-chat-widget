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
import { renderMarkdown } from '../lib/markdown.js';
import { describeRestriction, isInjectable } from '../lib/pages.js';

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
  ctxMeta: $('ctx-meta'),
  banner: $('banner'),
  bannerTitle: $('banner-title'),
  bannerHint: $('banner-hint'),
  bannerAction: $('banner-action'),
  bannerClose: $('banner-close'),
  composerMeta: $('composer-meta'),
};

const QUICK_PROMPTS = [
  { label: '요약', prompt: '이 페이지의 핵심 내용을 5줄 이내로 요약해 주세요.' },
  { label: '핵심 포인트', prompt: '이 페이지에서 가장 중요한 포인트를 불릿으로 정리해 주세요.' },
  { label: '표로 정리', prompt: '이 페이지의 주요 정보를 표로 정리해 주세요.' },
  {
    label: '쉽게 설명',
    prompt: '이 페이지 내용을 비전문가도 이해할 수 있게 쉬운 말로 설명해 주세요.',
  },
  {
    label: '한국어 번역',
    prompt:
      '이 페이지 본문을 자연스러운 한국어로 번역해 주세요. 분량이 많으면 핵심 단락부터 번역하고 그 사실을 알려 주세요.',
  },
  { label: '용어 정리', prompt: '이 페이지에 나오는 주요 용어를 뜻과 함께 정리해 주세요.' },
  {
    label: '다음 행동',
    prompt: '이 페이지를 읽은 사람이 이어서 확인하거나 실행하면 좋을 일을 제안해 주세요.',
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

const setStatus = (text) => {
  const queued = state.queuedPrompt ? ' · 대기 중인 요청 1건' : '';
  els.status.textContent = `${text ?? ''}${text ? queued : ''}`;
};

const fmt = (n) => Number(n ?? 0).toLocaleString('ko-KR');

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

function renderContextBar(modeOverride) {
  const mode = modeOverride ?? state.settings?.contextMode ?? 'page';

  if (state.pendingTabId != null) {
    els.ctxDot.dataset.state = 'loading';
    els.ctxTitle.textContent = '다른 탭으로 이동했습니다';
    els.ctxMeta.textContent = '응답이 끝나면 그 탭의 대화로 전환합니다';
    return;
  }

  if (mode === 'off') {
    els.ctxDot.dataset.state = 'off';
    els.ctxTitle.textContent = '페이지를 참조하지 않습니다';
    els.ctxMeta.textContent = '일반 챗봇처럼 동작합니다';
    els.composerMeta.textContent = '';
    return;
  }
  if (state.pageLoading) {
    els.ctxDot.dataset.state = 'loading';
    els.ctxTitle.textContent = '페이지를 읽는 중…';
    els.ctxMeta.textContent = '';
    return;
  }
  if (state.pageError) {
    els.ctxDot.dataset.state = 'warn';
    els.ctxTitle.textContent = '페이지를 읽을 수 없습니다';
    els.ctxMeta.textContent = state.pageError;
    els.composerMeta.textContent = '';
    return;
  }

  const page = state.page;
  if (!page) {
    els.ctxDot.dataset.state = 'warn';
    els.ctxTitle.textContent = '읽은 페이지가 없습니다';
    els.ctxMeta.textContent = '⟳ 를 눌러 다시 시도하세요';
    return;
  }

  if (!page.text && !page.selection) {
    els.ctxDot.dataset.state = 'warn';
    els.ctxTitle.textContent = page.title || '본문을 찾지 못했습니다';
    els.ctxMeta.textContent = page.hasFrames
      ? '본문이 내부 프레임(iframe)에 있어 읽지 못했습니다'
      : page.hasShadowRoots
        ? '웹 컴포넌트(shadow DOM) 안에서도 글자를 찾지 못했습니다'
        : 'PDF·이미지이거나 아직 로딩 중일 수 있습니다';
    els.composerMeta.textContent = '';
    return;
  }

  els.ctxDot.dataset.state = 'ok';
  els.ctxTitle.textContent = page.title || page.url || '제목 없음';

  const bits = [];
  if (mode === 'selection' && page.selection) bits.push(`선택 ${fmt(page.selection.length)}자`);
  else if (page.selection) bits.push(`선택 ${fmt(page.selection.length)}자 포함`);
  bits.push(`본문 ${fmt(page.charCount)}자`);
  if (page.charCount > state.settings.maxContextChars) {
    bits.push(`${fmt(state.settings.maxContextChars)}자까지 전송`);
  }
  els.ctxMeta.textContent = bits.join(' · ');

  const context = formatPageContext(page, {
    mode,
    maxChars: state.settings.maxContextChars,
    sendUrl: state.settings.sendPageUrl,
  });
  if (page.truncated || page.depthClipped) {
    els.ctxMeta.textContent += ' · 본문이 매우 길어 일부만 읽었습니다';
  }
  els.composerMeta.textContent = context
    ? `페이지 컨텍스트 약 ${fmt(approxTokens(context))} 토큰 전송`
    : '';
}

/**
 * 현재 탭의 본문을 새로 읽습니다.
 * @param {'page'|'selection'|'off'} [modeOverride] 이번 한 번만 적용할 참조 범위
 */
async function refreshContext(modeOverride) {
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
    state.page =
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

/* -------------------------------------------------------------- 렌더링 */

const ROLE_LABEL = { user: '나', assistant: 'AI' };

function buildMessageNode(turn) {
  const wrap = document.createElement('article');
  wrap.className = `msg msg-${turn.role}`;
  wrap.dataset.id = turn.id;

  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('span');
  who.textContent = ROLE_LABEL[turn.role] ?? turn.role;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  head.append(who, spacer, tools);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  wrap.append(head, bubble);
  return { wrap, bubble, tools };
}

/** 상태(오류 등)에 따라 래퍼 클래스를 맞춥니다. */
function applyState(turn, node) {
  node.wrap.className = `msg msg-${turn.role}${turn.status === 'error' ? ' msg-error' : ''}`;
}

function fillTools(turn, tools) {
  tools.replaceChildren();

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '복사';
  copy.addEventListener('click', async () => {
    const ok = await copyText(turn.content ?? '');
    copy.textContent = ok ? '복사됨' : '실패';
    setTimeout(() => {
      copy.textContent = '복사';
    }, 1200);
  });
  tools.append(copy);

  const isLastAssistant =
    turn.role === 'assistant' && state.turns[state.turns.length - 1]?.id === turn.id;
  if (isLastAssistant && !state.busy) {
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = '다시 생성';
    again.addEventListener('click', () => regenerate());
    tools.append(again);
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
  const h = document.createElement('h2');
  h.textContent = '이 페이지를 함께 읽습니다';
  const p = document.createElement('p');
  p.style.margin = '0';
  p.textContent =
    '아래 버튼을 누르거나 직접 질문을 입력하세요. 답변은 현재 탭에서 읽은 본문을 근거로 만들어집니다.';
  const ul = document.createElement('ul');
  for (const text of [
    '“요약”으로 시작하면 빠르게 감을 잡을 수 있습니다.',
    '페이지에서 원하는 부분을 선택한 뒤 참조 범위를 “선택 영역”으로 바꾸면 그 부분만 봅니다.',
    '모델·서버 주소·API 키는 오른쪽 위 ⚙ 에서 바꿉니다.',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  box.append(h, p, ul);
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
    fillTools(turn, node.tools);
    paintBubble(turn, node.bubble);
    state.nodes.set(turn.id, node);
    fragment.append(node.wrap);
  }
  els.messages.replaceChildren(fragment);
  scrollToBottom();
}

function appendTurn(turn) {
  const stick = nearBottom();
  if (state.turns.length === 0) els.messages.replaceChildren();
  state.turns.push(turn);

  // 직전 답변의 "다시 생성" 버튼을 갱신합니다.
  const previous = state.turns[state.turns.length - 2];
  if (previous) {
    const node = state.nodes.get(previous.id);
    if (node) fillTools(previous, node.tools);
  }

  const node = buildMessageNode(turn);
  applyState(turn, node);
  fillTools(turn, node.tools);
  paintBubble(turn, node.bubble);
  state.nodes.set(turn.id, node);
  els.messages.append(node.wrap);
  if (stick) scrollToBottom();
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
  fillTools(turn, node.tools);
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
    // 이번 요청의 참조 범위를 함께 넘겨야 '사용 안 함' 설정에서도
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

    const seconds = (answer.ms / 1000).toFixed(1);
    const usage = result.usage;
    setStatus(
      usage?.total_tokens
        ? `완료 · ${seconds}초 · ${fmt(usage.total_tokens)} 토큰`
        : `완료 · ${seconds}초`,
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
    button.addEventListener('click', () => send(item.prompt));
    els.quick.append(button);
  }
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
  els.refresh.addEventListener('click', () => refreshContext());
  els.bannerClose.addEventListener('click', hideBanner);

  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', (event) => {
    // 한글 등 IME 조합 중의 Enter 는 확정 키이므로 전송하지 않습니다.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      send(els.input.value, { fromInput: true });
    }
  });

  // 어디에 포커스가 있어도 Esc 로 생성을 중지할 수 있게 합니다.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.busy) {
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
    if (tabId !== state.tabId) return;
    if (changeInfo.status === 'complete' || changeInfo.url) {
      if (!state.busy) refreshContext();
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
  els.input.focus();
}

init().catch((error) => {
  console.error('[page-chatbot] 초기화 실패:', error);
  showBanner({
    title: '패널을 초기화하지 못했습니다.',
    hint: String(error?.message ?? error),
    action: { label: '설정 열기', run: openOptions },
  });
});
