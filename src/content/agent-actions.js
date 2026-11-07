/**
 * 에이전트 모드에서 웹페이지를 읽고 조작하는 함수.
 *
 * chrome.scripting.executeScript({ func: runPageAction, args: [action] }) 로 주입되므로
 * **함수 하나로 자기완결적이어야 합니다**(모듈 최상단의 이름을 참조하면 주입된 뒤 ReferenceError).
 * tools/validate.mjs 가 이 조건을 정적으로 검사합니다.
 *
 * 조작은 DOM 이벤트로 합니다(실제 마우스·키보드가 아님). 대부분의 사이트에서 동작하지만,
 * isTrusted 를 확인하는 일부 사이트나 캔버스로 그리는 화면은 조작되지 않을 수 있습니다.
 *
 * action:
 *   { kind: 'snapshot', maxText?, maxElements? }
 *   { kind: 'click', ref }        { kind: 'hover', ref }
 *   { kind: 'type', ref, text, clear?, submit? }
 *   { kind: 'select', ref, option }
 *   { kind: 'key', key }
 *   { kind: 'scroll', direction?, ref? }
 *   { kind: 'cleanup' }
 *   모든 동작에 msgs(현재 언어 문구, pageActionMessages())를 함께 넘깁니다.
 */

import { t } from '../lib/i18n.js';

const MESSAGE_KEYS = [
  'pa.filled', 'pa.textCut', 'pa.missing', 'pa.disabled', 'pa.useSelect', 'pa.flashClick',
  'pa.flashHover', 'pa.flashType', 'pa.flashSelect', 'pa.flashHere', 'pa.newTabLink',
  'pa.clickedCovered', 'pa.clicked', 'pa.hovered', 'pa.submitted', 'pa.submitFailed', 'pa.enter',
  'pa.sensitive', 'pa.notText', 'pa.readonly', 'pa.typedThen', 'pa.typed', 'pa.notSelect',
  'pa.noOption', 'pa.selected', 'pa.noKey', 'pa.keyPressed', 'pa.scrolledTo', 'pa.noScroll',
  'pa.scrolledDown', 'pa.scrolledUp', 'pa.unknown',
];

/** 주입 함수에 넘길 문구(현재 언어). */
export const pageActionMessages = () => Object.fromEntries(MESSAGE_KEYS.map((key) => [key, t(key)]));

export function runPageAction(action) {
  const kind = action?.kind ?? 'snapshot';
  // 문구는 확장 프로그램이 현재 언어로 action.msgs 에 담아 넘깁니다. 없으면 키를 그대로 씁니다.
  const msg = (key, params) =>
    String(action?.msgs?.[key] ?? key).replace(/\{(\w+)\}/g, (m, name) =>
      params && name in params ? String(params[name]) : m,
    );
  const REF_ATTR = 'data-pcb-ref';
  const OVERLAY_ID = '__page_chatbot_agent__';
  // 패널(페이지 내 모드)·본문 입력 오버레이 등 우리가 만든 요소는 조작 대상에서 뺍니다.
  const OWN_IDS = [OVERLAY_ID, '__page_chatbot_host__', '__page_chatbot_inserter__'];
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'number']);

  // 주입은 매번 새로 되지만, 같은 확장 프로그램의 isolated world 는 페이지가 살아 있는 동안
  // 전역 객체를 공유하므로 ref → 요소 표를 여기에 보관합니다.
  const REFS_KEY = '__pageChatbotAgentRefs';
  const refs = (window[REFS_KEY] ??= new Map());

  const clip = (text, max) => {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  };

  const isOwn = (el) => OWN_IDS.some((id) => el.closest?.(`#${id}`));

  const isVisible = (el) => {
    try {
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })) return false;
      } else if (el.getClientRects().length === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    } catch {
      return false;
    }
  };

  /* ------------------------------------------------------- 요소 수집 */

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider',
    'spinbutton', 'treeitem',
  ]);

  const isInteractive = (el) => {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return (el.getAttribute('type') ?? '').toLowerCase() !== 'hidden';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    const role = (el.getAttribute('role') ?? '').toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0;
  };

  /** 열린 shadow root 안까지 포함해 문서 순서대로 모든 요소를 훑습니다. */
  const allElements = (root, out = []) => {
    let list;
    try {
      list = root.querySelectorAll('*');
    } catch {
      return out;
    }
    for (const el of list) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
    }
    return out;
  };

  const textOf = (node) => clip(node?.innerText ?? node?.textContent ?? '', 80);

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return clip(aria, 80);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => el.getRootNode()?.getElementById?.(id)?.textContent ?? '')
        .join(' ');
      if (text.trim()) return clip(text, 80);
    }
    if (el.labels?.length) {
      const text = Array.from(el.labels).map((label) => label.innerText).join(' ');
      if (text.trim()) return clip(text, 80);
    }
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const text = textOf(el);
      if (text) return text;
    }
    for (const attr of ['placeholder', 'title', 'alt', 'name']) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return clip(value, 80);
    }
    const img = el.querySelector?.('img[alt]');
    if (img?.alt?.trim()) return clip(img.alt, 80);
    if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return clip(el.value, 80);
    return '';
  };

  const describe = (el, ref) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') ?? '').toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : '';
    const rect = el.getBoundingClientRect();
    const info = {
      ref,
      tag,
      role,
      type,
      name: accessibleName(el),
      inView: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
    };
    if (tag === 'a') info.href = clip(el.getAttribute('href'), 120);
    if (tag === 'button') info.type = (el.getAttribute('type') ?? (el.form ? 'submit' : 'button')).toLowerCase();
    if (el.form || el.closest?.('form')) info.inForm = true;
    if (tag === 'input' || tag === 'textarea') {
      // 비밀번호는 값을 절대 내보내지 않습니다.
      if (type === 'password') info.value = el.value ? msg('pa.filled') : '';
      else if (type === 'checkbox' || type === 'radio') info.checked = el.checked;
      else info.value = clip(el.value, 60);
      if (el.placeholder) info.placeholder = clip(el.placeholder, 60);
    }
    if (tag === 'select') {
      info.value = clip(el.selectedOptions?.[0]?.textContent ?? '', 60);
      info.options = Array.from(el.options)
        .slice(0, 15)
        .map((option) => clip(option.textContent, 40));
    }
    if (el.isContentEditable) {
      info.role = info.role || 'textbox';
      info.value = clip(el.innerText, 60);
    }
    const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
    if (checked === 'true' || checked === 'false') info.checked = checked === 'true';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') info.expanded = expanded === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') info.disabled = true;
    if (document.activeElement === el) info.focused = true;
    return info;
  };

  const snapshot = () => {
    const maxElements = Math.max(20, Math.min(400, Number(action?.maxElements) || 150));
    const maxText = Math.max(500, Math.min(30000, Number(action?.maxText) || 3000));

    // 이전 표시를 지우고 번호를 새로 매깁니다(오래된 번호가 엉뚱한 요소를 가리키지 않게).
    for (const el of refs.values()) el.removeAttribute?.(REF_ATTR);
    refs.clear();

    const found = [];
    for (const el of allElements(document)) {
      if (!isInteractive(el) || isOwn(el) || !isVisible(el)) continue;
      found.push(el);
    }

    // 너무 많으면 화면에 보이는 것을 우선 남기고, 나머지는 문서 순서대로 채웁니다.
    let picked = found;
    if (found.length > maxElements) {
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
      };
      const visibleNow = found.filter(inView);
      const keep = new Set(visibleNow.slice(0, maxElements));
      for (const el of found) {
        if (keep.size >= maxElements) break;
        keep.add(el);
      }
      picked = found.filter((el) => keep.has(el));
    }

    const elements = picked.map((el, index) => {
      const ref = String(index + 1);
      refs.set(ref, el);
      try {
        el.setAttribute(REF_ATTR, ref);
      } catch {
        /* 일부 요소는 속성을 막아 둘 수 있습니다. */
      }
      return describe(el, ref);
    });

    const main =
      document.querySelector('main, [role="main"], article') ?? document.body ?? document.documentElement;
    const rawText = String(main?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    const text = rawText.length > maxText ? `${rawText.slice(0, maxText)}\n${msg('pa.textCut', { n: rawText.length })}` : rawText;

    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      ok: true,
      url: location.href,
      title: document.title,
      scroll: {
        y: Math.round(scroller.scrollTop),
        height: Math.round(scroller.scrollHeight),
        viewport: Math.round(innerHeight),
      },
      elements,
      totalInteractive: found.length,
      text,
    };
  };

  /* ---------------------------------------------------------- 조작 */

  const byRef = (ref) => {
    const key = String(ref ?? '').replace(/^\[|\]$/g, '').trim();
    let el = refs.get(key);
    if (!el || !el.isConnected) {
      el = document.querySelector(`[${REF_ATTR}="${CSS.escape(key)}"]`);
    }
    return el && el.isConnected ? el : null;
  };

  const missing = (ref) => ({
    ok: false,
    error: msg('pa.missing', { ref }),
  });

  /** 사용자가 지금 무엇을 누르는지 볼 수 있게 대상 위에 잠깐 테두리를 그립니다. */
  const flash = (el, label) => {
    try {
      document.getElementById(OVERLAY_ID)?.remove();
      const rect = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.id = OVERLAY_ID;
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'pointer-events:none',
        `left:${Math.max(0, rect.left - 3)}px`, `top:${Math.max(0, rect.top - 3)}px`,
        `width:${rect.width + 6}px`, `height:${rect.height + 6}px`,
        'border:2px solid #4f46e5', 'border-radius:6px', 'background:rgba(79,70,229,.12)',
        'box-shadow:0 0 0 4px rgba(79,70,229,.18)', 'transition:opacity .4s',
      ].join(';');
      const tag = document.createElement('span');
      tag.textContent = `AI · ${label}`;
      tag.style.cssText =
        'position:absolute;left:-2px;top:-22px;padding:1px 6px;border-radius:5px;background:#4f46e5;color:#fff;font:600 11px/18px system-ui,sans-serif;white-space:nowrap';
      box.append(tag);
      (document.body ?? document.documentElement).append(box);
      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => box.remove(), 450);
      }, 900);
    } catch {
      /* 표시는 부가 기능이므로 실패해도 조작은 계속합니다. */
    }
  };

  const reveal = (el) => {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      el.scrollIntoView?.();
    }
  };

  const pointerAt = (el) => {
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX ?? 0),
      screenY: y + (window.screenY ?? 0),
      button: 0,
    };
  };

  const fire = (el, Ctor, type, init) => {
    try {
      return el.dispatchEvent(new Ctor(type, init));
    } catch {
      return el.dispatchEvent(new Event(type, init));
    }
  };

  const click = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: msg('pa.disabled') };
    }
    if (el.tagName === 'OPTION') {
      return { ok: false, error: msg('pa.useSelect') };
    }
    reveal(el);
    flash(el, msg('pa.flashClick'));

    // 새 창으로 여는 링크는 팝업 차단에 걸리므로 확장 프로그램이 대신 탭을 엽니다.
    const anchor = el.closest('a[href]');
    if (anchor && anchor.target === '_blank' && /^https?:/i.test(anchor.href)) {
      return { ok: true, openTab: anchor.href, message: msg('pa.newTabLink') };
    }

    const init = pointerAt(el);
    // 다른 요소(쿠키 배너 등)가 위를 덮고 있으면 알려 줍니다.
    let covered = '';
    try {
      const top = document.elementFromPoint(init.clientX, init.clientY);
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !isOwn(top)) {
        covered = clip(top.innerText || top.getAttribute('aria-label') || top.tagName, 40);
      }
    } catch {
      /* 무시 */
    }

    fire(el, PointerEvent, 'pointerover', init);
    fire(el, MouseEvent, 'mouseover', init);
    fire(el, PointerEvent, 'pointerdown', { ...init, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    fire(el, MouseEvent, 'mousedown', init);
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* 포커스를 받지 않는 요소 */
    }
    fire(el, PointerEvent, 'pointerup', { ...init, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    fire(el, MouseEvent, 'mouseup', init);
    // dispatchEvent 로 보낸 click 도 링크 이동·체크박스 토글 같은 기본 동작을 일으킵니다.
    fire(el, MouseEvent, 'click', { ...init, detail: 1 });

    return {
      ok: true,
      message: covered ? msg('pa.clickedCovered', { covered }) : msg('pa.clicked'),
    };
  };

  const hover = (el) => {
    reveal(el);
    flash(el, msg('pa.flashHover'));
    const init = pointerAt(el);
    fire(el, PointerEvent, 'pointerover', init);
    fire(el, PointerEvent, 'pointerenter', { ...init, bubbles: false });
    fire(el, MouseEvent, 'mouseover', init);
    fire(el, MouseEvent, 'mouseenter', { ...init, bubbles: false });
    fire(el, PointerEvent, 'pointermove', init);
    fire(el, MouseEvent, 'mousemove', init);
    return { ok: true, message: msg('pa.hovered') };
  };

  /** 결제·인증 정보처럼 사용자가 직접 넣어야 하는 칸인지. */
  const isSensitiveField = (el) => {
    if (el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'password') return true;
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/cc-|one-time-code|current-password|new-password/.test(autocomplete)) return true;
    const hint = `${el.name} ${el.id} ${el.getAttribute('aria-label') ?? ''} ${el.placeholder}`.toLowerCase();
    return /card.?num|cvc|cvv|비밀번호|password|주민|ssn|계좌/.test(hint);
  };

  const keyInit = (key) => {
    const codes = {
      Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32,
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
      PageUp: 33, PageDown: 34, Home: 36, End: 35,
    };
    const keyCode = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
    return { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
  };

  const pressEnter = (el) => {
    const init = keyInit('Enter');
    const proceed = fire(el, KeyboardEvent, 'keydown', init);
    fire(el, KeyboardEvent, 'keypress', init);
    fire(el, KeyboardEvent, 'keyup', init);
    // 사이트가 Enter 를 직접 처리하지 않았다면 폼을 제출합니다.
    if (proceed && el.form) {
      try {
        if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        else el.form.submit();
        return msg('pa.submitted');
      } catch (error) {
        return msg('pa.submitFailed', { error: error?.message ?? error });
      }
    }
    return msg('pa.enter');
  };

  const typeText = (el, text, { clear = true, submit = false } = {}) => {
    if (isSensitiveField(el)) {
      return {
        ok: false,
        error: msg('pa.sensitive'),
      };
    }
    const tag = el.tagName;
    const editable = el.isContentEditable;
    if (!editable && tag !== 'TEXTAREA' && !(tag === 'INPUT' && TEXT_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()))) {
      return { ok: false, error: msg('pa.notText') };
    }
    if (el.disabled || el.readOnly) return { ok: false, error: msg('pa.readonly') };

    reveal(el);
    flash(el, msg('pa.flashType'));
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* 무시 */
    }

    if (editable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!clear) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      // execCommand 는 편집기(ProseMirror·Draft 등)가 인식하는 입력 이벤트를 만들어 줍니다.
      const ok = document.execCommand?.('insertText', false, text);
      if (!ok) {
        if (clear) el.textContent = text;
        else el.append(document.createTextNode(text));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      }
    } else {
      // React 등이 변경을 알아채도록 프로토타입의 네이티브 세터로 값을 바꿉니다.
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = clear ? text : `${el.value}${text}`;
      fire(el, KeyboardEvent, 'keydown', keyInit(text.slice(-1) || 'a'));
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      fire(el, KeyboardEvent, 'keyup', keyInit(text.slice(-1) || 'a'));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const message = submit ? msg('pa.typedThen', { then: pressEnter(el) }) : msg('pa.typed');
    return { ok: true, message };
  };

  const selectOption = (el, wanted) => {
    if (el.tagName !== 'SELECT') {
      return { ok: false, error: msg('pa.notSelect') };
    }
    const target = String(wanted ?? '').trim();
    const options = Array.from(el.options);
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const option =
      options.find((o) => o.value === target) ??
      options.find((o) => norm(o.textContent) === norm(target)) ??
      options.find((o) => norm(o.textContent).includes(norm(target)));
    if (!option) {
      return {
        ok: false,
        error: msg('pa.noOption', { target, options: options.map((o) => clip(o.textContent, 30)).join(', ') }),
      };
    }
    reveal(el);
    flash(el, msg('pa.flashSelect'));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, option.value);
    else el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, message: msg('pa.selected', { label: clip(option.textContent, 40) }) };
  };

  const pressKey = (key) => {
    const name = String(key ?? '').trim();
    if (!name) return { ok: false, error: msg('pa.noKey') };
    const target = document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document.body ?? document.documentElement;
    if (name === 'Enter') return { ok: true, message: pressEnter(target) };
    const init = keyInit(name === 'Space' ? ' ' : name);
    fire(target, KeyboardEvent, 'keydown', init);
    fire(target, KeyboardEvent, 'keyup', init);
    // 합성 키 이벤트로는 페이지가 움직이지 않으므로 스크롤 키는 직접 처리합니다.
    const scroller = document.scrollingElement ?? document.documentElement;
    if (name === 'PageDown') scroller.scrollBy(0, innerHeight * 0.85);
    if (name === 'PageUp') scroller.scrollBy(0, -innerHeight * 0.85);
    if (name === 'Home') scroller.scrollTo(0, 0);
    if (name === 'End') scroller.scrollTo(0, scroller.scrollHeight);
    return { ok: true, message: msg('pa.keyPressed', { key: name }) };
  };

  /** 창이 스크롤되지 않는 앱(내부 div 가 스크롤)을 위해 가장 큰 스크롤 영역을 찾습니다. */
  const mainScroller = () => {
    const doc = document.scrollingElement ?? document.documentElement;
    if (doc.scrollHeight > innerHeight + 4) return doc;
    let best = null;
    let bestArea = 0;
    for (const el of allElements(document)) {
      if (el.scrollHeight <= el.clientHeight + 4) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best ?? doc;
  };

  const scroll = ({ direction = 'down', ref } = {}) => {
    if (ref) {
      const el = byRef(ref);
      if (!el) return missing(ref);
      reveal(el);
      flash(el, msg('pa.flashHere'));
      return { ok: true, message: msg('pa.scrolledTo', { ref }) };
    }
    const scroller = mainScroller();
    const page = (scroller === document.scrollingElement ? innerHeight : scroller.clientHeight) * 0.85;
    const before = scroller.scrollTop;
    if (direction === 'up') scroller.scrollBy({ top: -page, behavior: 'instant' });
    else if (direction === 'top') scroller.scrollTo({ top: 0, behavior: 'instant' });
    else if (direction === 'bottom') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
    else scroller.scrollBy({ top: page, behavior: 'instant' });
    const moved = Math.round(scroller.scrollTop - before);
    return {
      ok: true,
      message:
        moved === 0
          ? msg('pa.noScroll')
          : msg(moved > 0 ? 'pa.scrolledDown' : 'pa.scrolledUp', { n: Math.abs(moved) }),
    };
  };

  /* ---------------------------------------------------------- 분기 */

  try {
    switch (kind) {
      case 'snapshot':
        return snapshot();
      case 'cleanup':
        for (const el of refs.values()) el.removeAttribute?.(REF_ATTR);
        refs.clear();
        document.getElementById(OVERLAY_ID)?.remove();
        return { ok: true };
      case 'click': {
        const el = byRef(action.ref);
        return el ? click(el) : missing(action.ref);
      }
      case 'hover': {
        const el = byRef(action.ref);
        return el ? hover(el) : missing(action.ref);
      }
      case 'type': {
        const el = byRef(action.ref);
        if (!el) return missing(action.ref);
        return typeText(el, String(action.text ?? ''), {
          clear: action.clear !== false,
          submit: Boolean(action.submit),
        });
      }
      case 'select': {
        const el = byRef(action.ref);
        return el ? selectOption(el, action.option) : missing(action.ref);
      }
      case 'key':
        return pressKey(action.key);
      case 'scroll':
        return scroll(action);
      default:
        return { ok: false, error: msg('pa.unknown', { kind }) };
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
