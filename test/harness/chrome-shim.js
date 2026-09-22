/**
 * 브라우저 확장 프로그램 없이 패널 UI 를 검증하기 위한 chrome API 흉내.
 * 개발 검증 전용이며 확장 프로그램 패키지에는 포함되지 않습니다.
 *
 * window.__harness 로 시나리오를 조종할 수 있습니다.
 *   __harness.activateTab(id)      탭 전환 이벤트 발생
 *   __harness.setFrames(list)      executeScript 가 돌려줄 프레임 결과 지정
 *   __harness.queuePending(tabId, payload)  컨텍스트 메뉴 요청 심기
 *   __harness.session / .local     저장소 내용 확인
 */
(() => {
  const local = {
    settings: {
      baseUrl: 'http://127.0.0.1:8731',
      apiKey: 'sk-harness',
      model: 'gemini-flash',
      stream: true,
      contextMode: 'page',
    },
  };
  const session = {};
  const changeListeners = [];
  const messageListeners = [];
  const activatedListeners = [];
  const updatedListeners = [];

  const makePage = (tabId) => ({
    ok: true,
    url: `http://127.0.0.1:8731/tab/${tabId}`,
    title: `탭 ${tabId} 의 문서`,
    siteName: '테스트 사이트',
    description: '설명',
    selection: '',
    headings: [{ level: 1, text: `탭 ${tabId} 제목` }],
    text: `탭 ${tabId} 본문입니다. `.repeat(40),
    get charCount() {
      return this.text.length;
    },
    truncated: false,
    depthClipped: false,
    hasFrames: false,
    hasShadowRoots: false,
    source: 'article',
  });

  let activeTabId = 1;
  let frames = null; // null 이면 makePage(activeTabId) 하나만 돌려줍니다.
  let textLengthOverride = null; // 페이지가 바뀐 상황을 흉내 낼 때 사용
  let insertScenario = 'needsPick'; // 'inserted' | 'needsPick' | 'noTargets'
  let selectionOverride = '';
  const calls = []; // executeScript 호출 기록(캐시 동작 확인용)

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const pick = (store, keys) => {
    if (keys === undefined || keys === null) return clone(store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) if (key in store) out[key] = clone(store[key]);
    return out;
  };

  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: null,
      getURL: (path) => `/${path}`,
      sendMessage: async (message) => {
        if (message?.type === 'whoami') return { tabId: activeTabId, windowId: 1 };
        if (message?.type === 'open-options') {
          window.open('/src/options/options.html', '_blank');
          return { ok: true };
        }
        return { ok: true };
      },
      openOptionsPage: () => window.open('/src/options/options.html', '_blank'),
      onMessage: { addListener: (fn) => messageListeners.push(fn), removeListener: () => {} },
    },
    storage: {
      local: {
        get: async (keys) => pick(local, keys),
        set: async (items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: local[key], newValue: value };
            local[key] = value;
          }
          for (const fn of changeListeners) fn(changes, 'local');
        },
        remove: async () => {},
      },
      session: {
        get: async (keys) => pick(session, keys),
        set: async (items) => Object.assign(session, clone(items)),
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn), removeListener: () => {} },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [
        { id: activeTabId, windowId: 1, url: makePage(activeTabId).url, title: `탭 ${activeTabId}`, active: true },
      ],
      get: async (id) => ({ id, windowId: 1, url: makePage(id).url, title: `탭 ${id}` }),
      onActivated: { addListener: (fn) => activatedListeners.push(fn) },
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      onRemoved: { addListener: () => {} },
    },
    scripting: {
      executeScript: async ({ target, files, func, args }) => {
        await new Promise((r) => setTimeout(r, 10)); // 실제 주입처럼 약간 늦게
        const tabId = target?.tabId ?? activeTabId;
        calls.push({ tabId, files, func: func?.name });

        // 값싼 신호 스크립트 — 실제 probe.js 와 같은 모양으로 돌려줍니다.
        if (files?.some((f) => f.endsWith('probe.js'))) {
          const page = makePage(tabId);
          const length = textLengthOverride ?? page.text.length;
          const probe = (frameId, extra = {}) => ({
            frameId,
            result: {
              ok: true,
              url: page.url,
              title: page.title,
              textLength: length,
              fingerprint: `fp${length}`,
              frameCount: 0,
              readyState: 'complete',
              selection: selectionOverride,
              ...extra,
            },
          });
          // frames 를 지정했다면 그 프레임들에도 신호가 있다고 봅니다.
          if (frames) {
            return frames.map((entry, index) =>
              probe(entry.frameId ?? index, {
                textLength: entry.result?.charCount ?? length,
                fingerprint: `fp${entry.result?.charCount ?? length}`,
              }),
            );
          }
          return [probe(0)];
        }

        // 주입 함수 — 실제 실행 대신 정해진 값을 돌려줍니다(함수 이름으로 구분).
        if (func?.name === 'runInsert') {
          const mode = args?.[0]?.mode ?? 'auto';
          calls[calls.length - 1].insertMode = mode;
          if (mode === 'cancel') return [{ frameId: 0, result: { status: 'cancelled' } }];
          if (mode === 'pick') {
            return [{ frameId: 0, result: insertScenario === 'noTargets' ? { status: 'noTargets' } : { status: 'picking', count: 2 } }];
          }
          if (insertScenario === 'inserted') {
            return [{ frameId: 0, result: { status: 'inserted', how: 'focused', editor: 'form' } }];
          }
          if (insertScenario === 'noTargets') return [{ frameId: 0, result: { status: 'noTargets' } }];
          return [{ frameId: 0, result: { status: 'needsPick', count: 2 } }];
        }
        if (func) {
          return [
            {
              frameId: 0,
              result: { supported: true, styled: true, found: 1, partial: 0, missed: [], total: 1 },
            },
          ];
        }

        if (frames) return clone(frames);
        return [{ frameId: 0, result: makePage(tabId) }];
      },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {}, setOptions: async () => {} },
    contextMenus: { create: () => {}, removeAll: (cb) => cb?.(), onClicked: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
  };

  window.__harness = {
    local,
    session,
    makePage,
    get activeTabId() {
      return activeTabId;
    },
    setFrames(list) {
      frames = list;
    },
    calls,
    setTextLength(value) {
      textLengthOverride = value;
    },
    setInsertScenario(value) {
      insertScenario = value;
    },
    /** 컨텐츠 스크립트가 보내는 선택 결과를 흉내 냅니다. */
    sendInsertResult(status) {
      for (const fn of messageListeners) fn({ type: 'insert-result', status }, {}, () => {});
    },
    setSelection(value) {
      selectionOverride = value;
    },
    activateTab(id) {
      activeTabId = id;
      for (const fn of activatedListeners) fn({ tabId: id, windowId: 1 });
    },
    fireUpdated(tabId, changeInfo = { status: 'complete' }) {
      for (const fn of updatedListeners) fn(tabId, changeInfo, {});
    },
    async queuePending(tabId, payload) {
      session[`pending:${tabId}`] = { ...payload, createdAt: Date.now() };
      for (const fn of messageListeners) fn({ type: 'pending-prompt', tabId, payload }, {}, () => {});
    },
  };
})();
