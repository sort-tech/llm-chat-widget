/**
 * 에이전트의 도구를 실제 브라우저에서 실행합니다(사이드 패널에서 동작).
 *
 *  - 페이지 안 조작은 runPageAction 을 탭에 주입해서 합니다.
 *  - 이동·탭 전환은 chrome.tabs API 로 합니다.
 *  - 동작이 끝나면 로딩이 가라앉기를 기다렸다가 새 화면 정보를 붙여 돌려줍니다.
 */

import { pageActionMessages, runPageAction } from '../content/agent-actions.js';
import { formatSnapshot, normalizeAgentUrl } from '../lib/agent-tools.js';
import { describeRestriction, isInjectable } from '../lib/pages.js';
import { t } from '../lib/i18n.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** 페이지 이동 중이라 주입이 실패한 경우인지(이동 자체는 성공일 수 있음). */
const isNavigationError = (error) =>
  /frame (was|with id \d+ was) removed|No frame with id|Cannot access contents|The tab was closed|Frame with ID/i.test(
    String(error?.message ?? error),
  );

/**
 * @param {{tabId:number, windowId:number|null, onTabChange?:(tabId:number)=>void}} options
 */
export function createBrowserExecutor({ tabId, windowId, onTabChange = () => {} }) {
  let currentTab = tabId;
  /** 최근 화면 정보의 ref → 요소 정보. 승인 창 문구와 위험 판단에 씁니다. */
  let elements = new Map();

  const setTab = (id) => {
    currentTab = id;
    elements = new Map();
    onTabChange(id);
  };

  async function getTab() {
    return chrome.tabs.get(currentTab);
  }

  async function inject(action) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab },
      func: runPageAction,
      args: [{ ...action, msgs: pageActionMessages() }],
    });
    return results?.[0]?.result ?? { ok: false, error: t('br.noResult') };
  }

  /** 로딩이 끝날 때까지(최대 timeoutMs) 기다립니다. 이동이 시작되기까지의 짧은 틈도 기다립니다. */
  async function settle(signal, { grace = 350, timeoutMs = 15000 } = {}) {
    await sleep(grace, signal);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !signal?.aborted) {
      let tab;
      try {
        tab = await getTab();
      } catch {
        return; // 탭이 닫힘
      }
      if (tab.status === 'complete') break;
      await sleep(250, signal);
    }
    // 단일 페이지 앱이 화면을 다시 그릴 시간을 조금 줍니다.
    await sleep(250, signal);
  }

  async function snapshot({ fullText = false } = {}) {
    let tab;
    try {
      tab = await getTab();
    } catch {
      return formatSnapshot({ tabId: currentTab, url: '', title: '', restricted: t('br.tabClosed') });
    }
    if (!isInjectable(tab.url)) {
      elements = new Map();
      return formatSnapshot({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        restricted: describeRestriction(tab.url),
      });
    }
    let result;
    try {
      result = await inject({ kind: 'snapshot', maxText: fullText ? 12000 : 3000 });
    } catch (error) {
      return formatSnapshot({ tabId: tab.id, url: tab.url, title: tab.title, restricted: String(error?.message ?? error) });
    }
    elements = new Map((result.elements ?? []).map((el) => [String(el.ref), el]));
    return formatSnapshot({ ...result, tabId: tab.id });
  }

  /** 페이지 안 동작을 실행하고 결과 + 새 화면 정보를 만듭니다. */
  async function pageAction(action, signal) {
    const tab = await getTab();
    if (!isInjectable(tab.url)) {
      return { ok: false, text: t('loop.error', { error: describeRestriction(tab.url) }) };
    }
    let result;
    let navigated = false;
    try {
      result = await inject(action);
    } catch (error) {
      if (!isNavigationError(error)) throw error;
      navigated = true;
      result = { ok: true, message: t('br.navigatedDuring') };
    }

    // 새 탭으로 열어야 하는 링크
    if (result?.ok && result.openTab) {
      const created = await chrome.tabs.create({ url: result.openTab, active: true, windowId: windowId ?? undefined });
      setTab(created.id);
      await settle(signal);
      return { ok: true, summary: t('br.openedSummary'), text: `${t('br.openedLink', { id: created.id })}\n\n${await snapshot()}` };
    }

    if (!result?.ok) return { ok: false, text: `${t('loop.error', { error: result?.error ?? t('br.failed') })}\n\n${await snapshot()}` };

    await settle(signal, { grace: navigated ? 600 : 350 });
    return { ok: true, summary: result.message, text: `${result.message}\n\n${await snapshot()}` };
  }

  async function navigate(rawUrl, signal) {
    const check = normalizeAgentUrl(rawUrl);
    if (!check.ok) return { ok: false, text: t('loop.error', { error: check.error }) };
    await chrome.tabs.update(currentTab, { url: check.url });
    await settle(signal, { grace: 600 });
    return { ok: true, summary: t('br.navigatedSummary'), text: `${t('br.navigated', { url: check.url })}\n\n${await snapshot()}` };
  }

  async function execute(name, args, signal) {
    switch (name) {
      case 'read_page':
        return { ok: true, summary: t('br.readSummary'), text: await snapshot({ fullText: Boolean(args.full_text) }) };
      case 'click':
        return pageAction({ kind: 'click', ref: args.ref }, signal);
      case 'hover':
        return pageAction({ kind: 'hover', ref: args.ref }, signal);
      case 'type':
        return pageAction(
          { kind: 'type', ref: args.ref, text: String(args.text ?? ''), clear: args.clear !== false, submit: Boolean(args.submit) },
          signal,
        );
      case 'select_option':
        return pageAction({ kind: 'select', ref: args.ref, option: args.option }, signal);
      case 'press_key':
        return pageAction({ kind: 'key', key: args.key }, signal);
      case 'scroll':
        return pageAction({ kind: 'scroll', direction: args.direction, ref: args.ref }, signal);
      case 'navigate':
        return navigate(args.url, signal);
      case 'go_back': {
        try {
          await chrome.tabs.goBack(currentTab);
        } catch (error) {
          return { ok: false, text: t('loop.error', { error: t('br.backFailed', { error: String(error?.message ?? error) }) }) };
        }
        await settle(signal, { grace: 600 });
        return { ok: true, summary: t('br.backSummary'), text: `${t('br.backSummary')}\n\n${await snapshot()}` };
      }
      case 'open_tab': {
        const check = normalizeAgentUrl(args.url);
        if (!check.ok) return { ok: false, text: t('loop.error', { error: check.error }) };
        const created = await chrome.tabs.create({ url: check.url, active: true, windowId: windowId ?? undefined });
        setTab(created.id);
        await settle(signal, { grace: 600 });
        return { ok: true, summary: t('br.newTabSummary'), text: `${t('br.newTab', { id: created.id })}\n\n${await snapshot()}` };
      }
      case 'list_tabs': {
        const tabs = await chrome.tabs.query(windowId != null ? { windowId } : { currentWindow: true });
        const lines = tabs.map(
          (tab) =>
            t('br.tabLine', {
              id: tab.id,
              current: tab.id === currentTab ? t('br.tabCurrent') : '',
              title: tab.title ?? '',
              url: tab.url ?? '',
            }),
        );
        return { ok: true, summary: t('br.tabsSummary', { n: tabs.length }), text: t('br.tabs', { lines: lines.join('\n') }) };
      }
      case 'switch_tab': {
        const id = Number(args.tab_id);
        let tab;
        try {
          tab = await chrome.tabs.get(id);
        } catch {
          return { ok: false, text: t('loop.error', { error: t('br.tabMissing', { id: args.tab_id }) }) };
        }
        if (windowId != null && tab.windowId !== windowId) {
          return { ok: false, text: t('loop.error', { error: t('br.otherWindow') }) };
        }
        await chrome.tabs.update(id, { active: true });
        setTab(id);
        await settle(signal, { grace: 200 });
        return { ok: true, summary: t('br.switchedSummary'), text: `${t('br.switched', { id })}\n\n${await snapshot()}` };
      }
      case 'wait': {
        const seconds = Math.min(10, Math.max(0.5, Number(args.seconds) || 1));
        await sleep(seconds * 1000, signal);
        await settle(signal, { grace: 0 });
        return { ok: true, summary: t('br.waited', { s: seconds }), text: `${t('br.waited', { s: seconds })}\n\n${await snapshot()}` };
      }
      default:
        return { ok: false, text: t('loop.error', { error: t('br.unknown', { name }) }) };
    }
  }

  return {
    get tabId() {
      return currentTab;
    },
    snapshot: () => snapshot(),
    target: (name, args) => (args?.ref != null ? (elements.get(String(args.ref).replace(/^\[|\]$/g, '')) ?? null) : null),
    execute,
    /** 표시해 둔 ref 속성과 강조 테두리를 치웁니다. */
    async cleanup() {
      try {
        const tab = await getTab();
        if (isInjectable(tab.url)) await inject({ kind: 'cleanup' });
      } catch {
        /* 탭이 닫혔거나 이동 중 */
      }
    },
  };
}
