/**
 * 서비스 워커를 가짜 chrome API 위에서 실제로 불러와,
 * 리스너 등록과 주요 분기가 오류 없이 동작하는지 확인합니다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: () => {},
    async fire(...args) {
      for (const fn of listeners) await fn(...args);
    },
  };
}

function makeChrome() {
  const calls = { panelBehavior: [], menus: [], sidePanelOpen: [], executeScript: [], sessionSet: [], sessionRemove: [], options: 0 };
  const localStore = {};

  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
      openOptionsPage: async () => {
        calls.options += 1;
      },
      sendMessage: async () => {
        throw new Error('no receiver');
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = keys === undefined ? Object.keys(localStore) : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in localStore) out[key] = localStore[key];
          return out;
        },
        set: async (items) => Object.assign(localStore, items),
      },
      session: {
        set: async (items) => calls.sessionSet.push(items),
        remove: async (keys) => calls.sessionRemove.push(keys),
      },
      onChanged: makeEvent(),
    },
    action: { onClicked: makeEvent() },
    tabs: { onRemoved: makeEvent() },
    contextMenus: {
      removeAll: (cb) => cb?.(),
      create: (definition) => calls.menus.push(definition),
      onClicked: makeEvent(),
    },
    sidePanel: {
      setPanelBehavior: async (options) => calls.panelBehavior.push(options),
      open: async (options) => calls.sidePanelOpen.push(options),
    },
    scripting: {
      executeScript: async (options) => {
        calls.executeScript.push(options);
        return [{ result: { ok: true, state: 'opened' } }];
      },
    },
  };
  return { chrome, calls, localStore };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('서비스 워커가 필요한 리스너를 모두 등록한다', async () => {
  const { chrome } = makeChrome();
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=listeners`);

  assert.equal(chrome.runtime.onInstalled.listeners.length, 1);
  assert.equal(chrome.runtime.onStartup.listeners.length, 1);
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(chrome.action.onClicked.listeners.length, 1);
  assert.equal(chrome.contextMenus.onClicked.listeners.length, 1);
  assert.equal(chrome.storage.onChanged.listeners.length, 1);
  assert.equal(chrome.tabs.onRemoved.listeners.length, 1);
});

test('설치 시 메뉴를 만들고 사이드 패널 동작을 설정하고 설정 화면을 연다', async () => {
  const { chrome, calls, localStore } = makeChrome();
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=install`);

  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();

  assert.deepEqual(
    calls.menus.map((m) => m.id).sort(),
    ['page-chatbot-ask-selection', 'page-chatbot-open', 'page-chatbot-summarize'],
  );
  assert.deepEqual(calls.panelBehavior.at(-1), { openPanelOnActionClick: true });
  assert.equal(calls.options, 1);
  // 기본 설정이 저장소에 기록된다
  assert.equal(localStore.settings.model, 'gemini-flash');
  assert.equal(localStore.settings.baseUrl, 'http://localhost:4000');
});

test('컨텍스트 메뉴로 선택 영역을 물으면 대기 요청을 남기고 패널을 연다', async () => {
  const { chrome, calls } = makeChrome();
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=menu`);

  await chrome.contextMenus.onClicked.fire(
    { menuItemId: 'page-chatbot-ask-selection', selectionText: '선택한 문장' },
    { id: 42, windowId: 7, url: 'https://example.com' },
  );
  await settle();

  const queued = calls.sessionSet.at(-1);
  assert.ok(queued['pending:42'], '탭별 대기 요청 키가 있어야 한다');
  assert.equal(queued['pending:42'].intent, 'selection');
  assert.equal(queued['pending:42'].selectionText, '선택한 문장');
  assert.deepEqual(calls.sidePanelOpen.at(-1), { tabId: 42 });
});

test('페이지 내 패널 모드에서는 아이콘 클릭이 스크립트를 주입한다', async () => {
  const { chrome, calls, localStore } = makeChrome();
  localStore.settings = { panelMode: 'inpage' };
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=inpage`);

  await chrome.action.onClicked.fire({ id: 5, windowId: 1, url: 'https://example.com/a' });
  await settle();

  assert.equal(calls.executeScript.at(-1).files[0], 'src/content/panel-host.js');
  assert.equal(calls.executeScript.at(-1).target.tabId, 5);
  assert.equal(calls.sidePanelOpen.length, 0, '주입이 성공하면 사이드 패널은 열지 않는다');
});

test('주입할 수 없는 페이지에서는 사이드 패널로 대체한다', async () => {
  const { chrome, calls, localStore } = makeChrome();
  localStore.settings = { panelMode: 'inpage' };
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=restricted`);

  await chrome.action.onClicked.fire({ id: 6, windowId: 2, url: 'chrome://extensions' });
  await settle();

  assert.equal(calls.executeScript.length, 0);
  assert.deepEqual(calls.sidePanelOpen.at(-1), { tabId: 6 });
});

test('탭이 닫히면 그 탭의 대화와 대기 요청을 지운다', async () => {
  const { chrome, calls } = makeChrome();
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=removed`);

  await chrome.tabs.onRemoved.fire(99, {});
  await settle();

  assert.deepEqual(calls.sessionRemove.at(-1), ['conversation:99', 'pending:99']);
});

test('whoami 메시지에 보낸 탭 정보를 돌려준다', async () => {
  const { chrome } = makeChrome();
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=whoami`);

  const [listener] = chrome.runtime.onMessage.listeners;
  let response = null;
  const keepAlive = listener({ type: 'whoami' }, { tab: { id: 3, windowId: 8 } }, (value) => {
    response = value;
  });
  assert.deepEqual(response, { tabId: 3, windowId: 8 });
  assert.equal(keepAlive, false);
});

test('컨텍스트 메뉴에서 저장소를 기다리기 전에 사이드 패널을 먼저 연다 (user gesture 보존)', async () => {
  const { chrome, calls } = makeChrome();
  // 저장소 쓰기를 느리게 만들어, open() 이 그보다 먼저 불렸는지 확인한다.
  const order = [];
  chrome.storage.session.set = async (items) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('storage');
    calls.sessionSet.push(items);
  };
  chrome.sidePanel.open = async (options) => {
    order.push('open');
    calls.sidePanelOpen.push(options);
  };
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=gesture-order`);

  chrome.contextMenus.onClicked.fire(
    { menuItemId: 'page-chatbot-summarize' },
    { id: 11, windowId: 1, url: 'https://example.com' },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(order, ['open', 'storage'], 'open() 이 저장보다 먼저 불려야 한다');
  assert.deepEqual(calls.sidePanelOpen.at(-1), { tabId: 11 });
});

test('아이콘 클릭(사이드 패널 모드)도 await 없이 곧바로 연다', async () => {
  const { chrome, calls } = makeChrome();
  const order = [];
  chrome.storage.local.get = async (keys) => {
    order.push('storage');
    return {};
  };
  chrome.sidePanel.open = async (options) => {
    order.push('open');
    calls.sidePanelOpen.push(options);
  };
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=action-order`);
  await settle();
  order.length = 0;

  chrome.action.onClicked.fire({ id: 12, windowId: 1, url: 'https://example.com' });
  assert.deepEqual(order, ['open'], '클릭 처리 중 저장소를 읽지 않아야 한다');
  assert.deepEqual(calls.sidePanelOpen.at(-1), { tabId: 12 });
});

test('페이지 내 패널 모드에서 토글로 닫혔으면 한 번 더 주입해 연다', async () => {
  const { chrome, calls, localStore } = makeChrome();
  localStore.settings = { panelMode: 'inpage' };
  let injections = 0;
  chrome.scripting.executeScript = async (options) => {
    injections += 1;
    calls.executeScript.push(options);
    // 첫 주입은 "이미 열려 있어서 닫힘" 을 흉내 낸다.
    return [{ result: { ok: true, state: injections === 1 ? 'closed' : 'opened' } }];
  };
  globalThis.chrome = chrome;
  await import(`../src/background/service-worker.js?case=inpage-toggle`);
  await settle();

  await chrome.action.onClicked.fire({ id: 13, windowId: 1, url: 'https://example.com' });
  await settle();

  assert.equal(injections, 2, '닫혔으면 다시 주입해 열림 상태로 맞춘다');
  assert.equal(calls.sidePanelOpen.length, 0);
});
