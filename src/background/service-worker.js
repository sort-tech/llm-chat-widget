/**
 * 서비스 워커: 툴바 아이콘/컨텍스트 메뉴/패널 모드만 담당합니다.
 * 모델 호출은 사이드 패널(확장 프로그램 페이지)에서 직접 수행합니다.
 */

import { loadSettings, saveSettings } from '../lib/settings.js';
import { conversationKey, pendingKey, SETTINGS_KEY } from '../lib/defaults.js';
import { isInjectable } from '../lib/pages.js';

const MENU = {
  ask: 'page-chatbot-ask-selection',
  summarize: 'page-chatbot-summarize',
  open: 'page-chatbot-open',
};

/* ------------------------------------------------------------ 패널 모드 */

/**
 * chrome.sidePanel.open() 은 "사용자 제스처에 대한 응답" 안에서만 허용됩니다.
 * await 를 한 번이라도 거치면 제스처가 소진되어 호출이 거부되므로,
 * 게스처 경로에서 저장소를 읽지 않도록 패널 모드를 메모리에 캐시합니다.
 * (서비스 워커가 깨어날 때마다 아래 초기화가 다시 실행됩니다.)
 */
let panelMode = 'sidepanel';

async function applyPanelBehavior(settings) {
  panelMode = settings.panelMode;
  const useSidePanel = settings.panelMode !== 'inpage';
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useSidePanel });
  } catch (error) {
    console.warn('[page-chatbot] setPanelBehavior 실패:', error);
  }
}

// 워커 기동/웨이크업 시 캐시를 채웁니다.
loadSettings()
  .then(applyPanelBehavior)
  .catch((error) => console.warn('[page-chatbot] 설정 초기화 실패:', error));

/** 사용자 제스처 안에서 곧바로(await 없이) 사이드 패널을 엽니다. */
function openSidePanelNow(tab) {
  const target =
    tab?.id !== undefined ? { tabId: tab.id } : tab?.windowId !== undefined ? { windowId: tab.windowId } : null;
  if (!target) return;
  chrome.sidePanel
    .open(target)
    .catch((error) => console.warn('[page-chatbot] 사이드 패널 열기 실패:', error));
}

/**
 * 페이지 안에 패널을 띄웁니다. panel-host.js 는 다시 주입하면 토글되므로,
 * 이미 열려 있어 닫혀 버린 경우에는 한 번 더 주입해 "열림"으로 맞춥니다.
 */
async function openInPagePanel(tab) {
  if (!tab?.id || !isInjectable(tab.url)) return false;
  const inject = () =>
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/panel-host.js'],
    });
  try {
    let results = await inject();
    if (results?.[0]?.result?.state === 'closed') results = await inject();
    return results?.[0]?.result?.ok !== false;
  } catch (error) {
    console.warn('[page-chatbot] 페이지 내 패널 주입 실패:', error);
    return false;
  }
}

/* -------------------------------------------------------- 컨텍스트 메뉴 */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.ask,
      title: '선택한 내용을 페이지 챗봇에 묻기',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.summarize,
      title: '이 페이지 요약하기',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU.open,
      title: '페이지 챗봇 열기',
      contexts: ['page', 'selection', 'link', 'image'],
    });
    if (chrome.runtime.lastError) {
      console.warn('[page-chatbot] 메뉴 생성 경고:', chrome.runtime.lastError.message);
    }
  });
}

/** 패널이 아직 열리지 않았을 수 있으므로 요청을 session 저장소에 남겨 둡니다. */
async function queuePrompt(tabId, payload) {
  if (tabId === undefined) return;
  try {
    await chrome.storage.session.set({ [pendingKey(tabId)]: { ...payload, createdAt: Date.now() } });
  } catch (error) {
    console.warn('[page-chatbot] 대기 요청 저장 실패:', error);
  }
  // 이미 열려 있는 패널에는 곧바로 알립니다(없으면 무시).
  chrome.runtime.sendMessage({ type: 'pending-prompt', tabId, payload }).catch(() => {});
}

/* ------------------------------------------------------------- 리스너 */

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  (async () => {
    const settings = await loadSettings();
    await saveSettings(settings); // 기본값을 실제 저장소에 기록해 둡니다.
    await applyPanelBehavior(settings);
    if (details.reason === 'install') {
      chrome.runtime.openOptionsPage().catch(() => {});
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
  loadSettings().then(applyPanelBehavior);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  loadSettings().then(applyPanelBehavior);
});

// openPanelOnActionClick 이 false 일 때(= 페이지 내 패널 모드)만 호출됩니다.
chrome.action.onClicked.addListener((tab) => {
  if (panelMode !== 'inpage') {
    openSidePanelNow(tab); // await 없이 — 제스처가 살아 있는 동안 호출
    return;
  }
  openInPagePanel(tab).then((ok) => {
    // 주입할 수 없는 페이지(chrome:// 등)라면 사이드 패널로 대체합니다.
    if (!ok) openSidePanelNow(tab);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // 1) 제스처가 살아 있는 지금 곧바로 패널을 엽니다(await 를 끼우면 거부됩니다).
  if (panelMode !== 'inpage') openSidePanelNow(tab);

  // 2) 요청 저장과 페이지 내 패널 주입은 제스처가 필요 없으므로 뒤에서 처리합니다.
  (async () => {
    if (info.menuItemId === MENU.ask) {
      await queuePrompt(tab?.id, {
        intent: 'selection',
        prompt: '선택한 부분을 이해하기 쉽게 설명해 주세요.',
        selectionText: info.selectionText ?? '',
      });
    } else if (info.menuItemId === MENU.summarize) {
      await queuePrompt(tab?.id, {
        intent: 'page',
        prompt: '이 페이지의 핵심 내용을 요약해 주세요.',
      });
    }
    if (panelMode === 'inpage' && !(await openInPagePanel(tab))) openSidePanelNow(tab);
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'whoami') {
    // 페이지에 삽입된 iframe 에서 보낸 경우 sender.tab 으로 자기 탭을 알 수 있습니다.
    sendResponse({ tabId: sender.tab?.id ?? null, windowId: sender.tab?.windowId ?? null });
    return false;
  }
  if (message?.type === 'open-options') {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'close-inpage-panel') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (tabId !== undefined && tabId !== null) {
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => document.getElementById('__page_chatbot_host__')?.remove(),
        })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 탭이 닫히면 그 탭의 대화/대기 요청을 정리합니다.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([conversationKey(tabId), pendingKey(tabId)]).catch(() => {});
});
