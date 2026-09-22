/**
 * "페이지 내 패널" 모드용 주입 스크립트.
 *
 * 사이드 패널을 쓸 수 없거나(구버전/특정 창) 사용자가 그 모드를 골랐을 때,
 * 페이지 오른쪽에 확장 프로그램 페이지를 담은 iframe 을 띄웁니다.
 * iframe 안은 chrome-extension:// 출처라서 사이드 패널과 완전히 같은 UI/권한으로 동작합니다.
 *
 * 같은 탭에 다시 주입되면 열고/닫기를 토글합니다.
 */

(() => {
  'use strict';

  const HOST_ID = '__page_chatbot_host__';
  const MIN_WIDTH = 300;
  const MAX_WIDTH_RATIO = 0.9;
  const WIDTH_KEY = 'inpagePanelWidth';

  if (!document.body) return { ok: false, reason: 'no-body' };

  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove();
    return { ok: true, state: 'closed' };
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'top: 0',
    'right: 0',
    'width: 400px',
    'height: 100vh',
    'z-index: 2147483647',
    'color-scheme: light dark',
    'box-shadow: -8px 0 24px rgba(15, 23, 42, 0.18)',
  ].join(';');

  // closed 로 만들어 페이지 스크립트가 host.shadowRoot 로 내부(iframe 주소에 담긴
  // 확장 프로그램 ID, 패널 내용)에 접근하지 못하게 합니다.
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; }
    .wrap {
      position: relative;
      display: flex;
      width: 100%;
      height: 100%;
      background: #ffffff;
      font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) { .wrap { background: #16181d; } }
    .grip {
      flex: 0 0 8px;
      cursor: col-resize;
      background: rgba(99, 102, 241, 0.18);
      touch-action: none;
    }
    .grip:hover, .grip.dragging { background: rgba(99, 102, 241, 0.5); }
    iframe { flex: 1 1 auto; width: 100%; height: 100%; border: 0; display: block; }
    .close {
      position: absolute;
      top: 6px;
      right: 8px;
      z-index: 2;
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      background: rgba(120, 130, 150, 0.18);
      color: #475569;
      font-size: 15px;
      line-height: 1;
    }
    .close:hover { background: rgba(239, 68, 68, 0.9); color: #fff; }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = '드래그해서 너비 조절';

  const frame = document.createElement('iframe');
  frame.title = '페이지 챗봇';
  frame.setAttribute('allow', 'clipboard-write');
  frame.src = chrome.runtime.getURL('src/sidepanel/panel.html?embedded=1');

  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.title = '닫기';
  close.textContent = '✕';
  close.addEventListener('click', () => host.remove());

  wrap.append(grip, frame, close);
  shadow.append(style, wrap);
  document.body.append(host);

  /* 저장된 너비 복원 */
  chrome.storage.local.get(WIDTH_KEY).then((stored) => {
    const width = Number(stored?.[WIDTH_KEY]);
    if (Number.isFinite(width) && width >= MIN_WIDTH) {
      host.style.width = `${Math.min(width, window.innerWidth * MAX_WIDTH_RATIO)}px`;
    }
  }).catch(() => {});

  /* 너비 조절 — 포인터 캡처를 쓰면 커서가 iframe 위로 가도 이벤트를 놓치지 않습니다. */
  let dragging = false;

  const onMove = (event) => {
    if (!dragging) return;
    const next = Math.min(
      Math.max(MIN_WIDTH, window.innerWidth - event.clientX),
      window.innerWidth * MAX_WIDTH_RATIO,
    );
    host.style.width = `${Math.round(next)}px`;
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    frame.style.pointerEvents = '';
    chrome.storage.local
      .set({ [WIDTH_KEY]: Number.parseInt(host.style.width, 10) })
      .catch(() => {});
  };

  grip.addEventListener('pointerdown', (event) => {
    dragging = true;
    grip.classList.add('dragging');
    frame.style.pointerEvents = 'none'; // 드래그 중 iframe 이 이벤트를 먹지 않도록
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      /* 캡처를 못 잡아도 아래 리스너로 동작합니다. */
    }
  });
  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('lostpointercapture', endDrag);

  return { ok: true, state: 'opened' };
})();
