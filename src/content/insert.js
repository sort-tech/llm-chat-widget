/**
 * 답변을 웹페이지의 입력창에 넣어 주는 주입용 에이전트.
 *
 * `chrome.scripting.executeScript({ func: runInsert, args: [옵션], allFrames: true })` 로
 * 모든 프레임에 주입됩니다. 주입 시 함수는 문자열화되므로 **바깥 스코프의 값을 참조하면
 * 안 됩니다**(tools/validate.mjs 가 이 규칙을 정적으로 검사합니다).
 *
 * 그래서 이 파일은 함수 하나로 모든 모드를 처리합니다. 모드별로 함수를 나누면
 * 판별·주입 헬퍼를 그만큼 복사해야 하기 때문입니다.
 *
 *   mode: 'auto'    포커스된 입력창이 있으면 바로 넣고, 없으면 후보 수만 알려 줍니다.
 *   mode: 'pick'    선택 모드 — 마우스로 가리키는 입력창을 강조하고, 클릭하면 넣습니다.
 *   mode: 'cancel'  선택 모드를 끄고 오버레이·리스너를 모두 정리합니다.
 *
 * 선택 결과는 비동기로 나오므로 chrome.runtime.sendMessage 로 패널에 알립니다
 * ({ type: 'insert-result', status: 'inserted' | 'cancelled' | 'failed' }).
 */

/**
 * @param {{mode?: 'auto'|'pick'|'cancel', text?: string}} options
 * @returns {{status: string, count?: number, how?: string, editor?: string}}
 */
export function runInsert(options) {
  const mode = options?.mode ?? 'auto';
  const text = String(options?.text ?? '');

  const HOST_ID = '__page_chatbot_inserter__';
  const CLEANUP_KEY = '__pageChatbotInsertCleanup';
  // 글자를 넣을 수 있는 input 종류만. password·number·date 등은 제외합니다.
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel']);

  /* ------------------------------------------------------ 입력창 판별 */

  const isVisible = (el) => {
    try {
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
      } else if (el.getClientRects().length === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 12;
    } catch {
      return false;
    }
  };

  const isEditable = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest(`#${HOST_ID}`)) return false; // 우리 오버레이
    if (el.isContentEditable) return isVisible(el);

    const tag = el.tagName;
    if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-readonly') === 'true') return false;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (!TEXT_TYPES.has(type)) return false;
    }
    return isVisible(el);
  };

  /** 마우스 아래에서 가장 가까운 입력창(라벨·아이콘을 눌러도 잡히도록). */
  const editableAt = (x, y) => {
    let node = document.elementFromPoint(x, y);
    for (let depth = 0; node && depth < 6; depth += 1) {
      if (isEditable(node)) return node;
      node = node.parentElement;
    }
    return null;
  };

  const candidates = () => {
    let found;
    try {
      found = Array.from(
        document.querySelectorAll('textarea, input, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'),
      );
    } catch {
      return [];
    }
    return found.filter(isEditable);
  };

  const focusedEditable = () => {
    const active = document.activeElement;
    return active && isEditable(active) ? active : null;
  };

  /* ---------------------------------------------------------- 주입 */

  /**
   * 프레임워크(React·Vue 등)가 변경을 인지하게 하려면
   * 프로퍼티에 직접 대입하지 않고 **프로토타입의 네이티브 세터**를 호출한 뒤
   * input·change 이벤트를 직접 발생시켜야 합니다.
   * (React 는 요소에 자체 value 트래커를 심어 두므로, 인스턴스 세터로 값을 바꾸면
   *  트래커가 같이 갱신되어 "바뀐 적 없음" 으로 판단합니다.)
   */
  const setFormValue = (el, next, caret) => {
    const proto =
      typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;

    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* email 등 일부 타입은 선택 범위를 지원하지 않습니다. */
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const insertInto = (el, value) => {
    if (!el || !value) return { ok: false };

    /*
     * 사용자가 이미 그 칸에 커서를 두고 있었다면 그 위치를 존중해 끼워 넣습니다.
     * 반대로 우리가 방금 포커스를 준 경우(선택 모드로 고른 칸)에는 맨 끝에 붙입니다 —
     * focus() 자체가 커서를 맨 앞에 놓는 경우가 있어, 그대로 두면 기존 내용 앞에
     * 답변이 끼어듭니다.
     */
    const selectionBefore = window.getSelection();
    const preserveCaret =
      document.activeElement === el &&
      (!el.isContentEditable ||
        Boolean(
          selectionBefore &&
            selectionBefore.rangeCount > 0 &&
            el.contains(selectionBefore.anchorNode),
        ));

    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      /* 무시 */
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* 무시 */
    }

    // 리치 에디터: DOM 을 직접 고치면 내부 서식 트리와 실행 취소 기록이 깨집니다.
    if (el.isContentEditable) {
      const selection = window.getSelection();
      try {
        if (
          !preserveCaret ||
          !selection ||
          selection.rangeCount === 0 ||
          !el.contains(selection.anchorNode)
        ) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false); // 끝에 커서
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      } catch {
        /* 무시 */
      }

      let ok = false;
      try {
        ok = document.execCommand('insertText', false, value);
      } catch {
        ok = false;
      }
      if (!ok) {
        // execCommand 를 막는 에디터를 위한 폴백
        try {
          const range = window.getSelection()?.getRangeAt(0);
          if (!range) return { ok: false };
          range.deleteContents();
          const node = document.createTextNode(value);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }),
          );
          ok = true;
        } catch {
          return { ok: false };
        }
      }
      return { ok: true, editor: 'rich' };
    }

    // 일반 폼: 커서 위치에 끼워 넣어 이미 쓴 내용을 지우지 않습니다.
    const before = typeof el.value === 'string' ? el.value : '';
    let start = before.length;
    let end = before.length;
    if (preserveCaret) {
      try {
        if (Number.isInteger(el.selectionStart)) start = el.selectionStart;
        if (Number.isInteger(el.selectionEnd)) end = el.selectionEnd;
      } catch {
        /* 선택 범위를 지원하지 않는 타입 */
      }
    }
    if (end < start) end = start;

    const next = before.slice(0, start) + value + before.slice(end);
    setFormValue(el, next, start + value.length);
    return { ok: true, editor: 'form' };
  };

  /* -------------------------------------------------- 오버레이 정리 */

  const cleanup = () => {
    try {
      globalThis[CLEANUP_KEY]?.();
    } catch {
      /* 무시 */
    }
    delete globalThis[CLEANUP_KEY];
    document.getElementById(HOST_ID)?.remove();
  };

  if (mode === 'cancel') {
    cleanup();
    return { status: 'cancelled' };
  }

  /* ------------------------------------------------------ auto 모드 */

  if (mode === 'auto') {
    const focused = focusedEditable();
    if (focused) {
      const result = insertInto(focused, text);
      return result.ok
        ? { status: 'inserted', how: 'focused', editor: result.editor }
        : { status: 'failed', how: 'focused' };
    }
    const count = candidates().length;
    return count > 0 ? { status: 'needsPick', count } : { status: 'noTargets' };
  }

  /* ------------------------------------------------------ pick 모드 */

  cleanup(); // 이전 선택 모드가 남아 있으면 먼저 정리
  const list = candidates();
  if (list.length === 0) return { status: 'noTargets' };

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647', // 페이지의 모달·헤더에 가리지 않도록
    'pointer-events: none', // 클릭을 가로채지 않도록(클릭은 리스너로 처리)
  ].join(';');

  // 페이지 스크립트가 내부를 들여다보지 못하게 닫힌 shadow root 를 씁니다.
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .tip {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      max-width: 90vw;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.94);
      color: #f9fafb;
      font: 600 13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tip small { margin-left: 8px; font-weight: 400; opacity: 0.75; }
    .box {
      position: fixed;
      border: 2px solid #6366f1;
      border-radius: 6px;
      background: rgba(99, 102, 241, 0.14);
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.06);
      transition: top 0.06s linear, left 0.06s linear, width 0.06s linear, height 0.06s linear;
      display: none;
    }
  `;

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = '입력할 위치를 클릭하세요';
  const tipHint = document.createElement('small');
  tipHint.textContent = '취소: ESC';
  tip.append(tipHint);

  const box = document.createElement('div');
  box.className = 'box';

  shadow.append(style, box, tip);
  (document.body ?? document.documentElement).append(host);

  let current = null;

  const place = () => {
    if (!current) {
      box.style.display = 'none';
      return;
    }
    const rect = current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.top = `${rect.top - 2}px`;
    box.style.left = `${rect.left - 2}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  };

  const notify = (status, extra) => {
    try {
      chrome.runtime.sendMessage({ type: 'insert-result', status, ...extra }).catch(() => {});
    } catch {
      /* 패널이 닫혀 있으면 받을 곳이 없습니다 — 무시 */
    }
  };

  const onMove = (event) => {
    const found = editableAt(event.clientX, event.clientY);
    if (found !== current) {
      current = found;
      place();
    }
  };

  const onScroll = () => place();

  /** 선택 클릭이 사이트의 링크 이동·폼 전송으로 이어지지 않게 모두 막습니다. */
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  };

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const target = editableAt(event.clientX, event.clientY);
    swallow(event);
    if (!target) return; // 입력창이 아닌 곳을 누르면 계속 선택 모드
    const result = insertInto(target, text);
    finish(result.ok ? 'inserted' : 'failed', { editor: result.editor });
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      swallow(event);
      finish('cancelled');
    }
  };

  const onHide = () => finish('cancelled');

  const targets = [
    ['pointerdown', onPointerDown],
    ['mousedown', swallow],
    ['mouseup', swallow],
    ['click', swallow],
    ['dblclick', swallow],
    ['contextmenu', swallow],
    ['keydown', onKeyDown],
  ];

  function finish(status, extra) {
    cleanup();
    notify(status, extra);
  }

  // 패널이 닫혀 취소 신호를 못 받는 경우를 대비한 안전장치.
  const autoCancel = setTimeout(() => finish('cancelled'), 60000);

  const detach = () => {
    clearTimeout(autoCancel);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    document.removeEventListener('visibilitychange', onHide);
    for (const [name, handler] of targets) window.removeEventListener(name, handler, true);
    document.getElementById(HOST_ID)?.remove();
  };

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);
  document.addEventListener('visibilitychange', onHide);
  for (const [name, handler] of targets) window.addEventListener(name, handler, true);

  globalThis[CLEANUP_KEY] = detach;

  return { status: 'picking', count: list.length };
}
