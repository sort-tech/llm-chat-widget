/**
 * 모델이 인용한 문장을 페이지에서 찾아 형광펜으로 표시합니다.
 *
 * highlightQuotes / clearHighlights 는 `chrome.scripting.executeScript({ func, args })` 로
 * 주입됩니다. 주입 시 함수는 문자열화되어 페이지의 격리된 월드에서 실행되므로,
 * **바깥 스코프의 값을 참조하면 안 됩니다(자기완결이어야 합니다).**
 * (tools/validate.mjs 가 이 규칙을 정적으로 검사합니다.)
 *
 * 페이지 DOM 을 고치지 않고 CSS Custom Highlight API 만 사용하므로
 * 사이트의 스크립트나 레이아웃에 영향을 주지 않습니다(Chrome/Edge 105+).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 중요: 아래 세 곳은 **같은 정규화 규칙**을 써야 합니다. 하나만 달라지면
 * "근거 칩은 생기는데 하이라이트는 안 되는" 상태가 됩니다.
 *   1) highlightQuotes 의 haystack (페이지 DOM → 검색용 문자열)
 *   2) highlightQuotes 의 normalize  (인용문 → 검색어)
 *   3) findCitations 의 flatten      (본문·인용문 → 대조용 문자열)
 * 규칙: 따옴표 계열 → `"` / 공백·NBSP·제로폭공백·전각공백·`|` → 공백(연속은 한 칸)
 *       / 소문자화. **글자를 지우지 않습니다**(지우면 위치 매핑이 깨집니다).
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * @param {string[]} quotes 찾을 문장들
 * @returns {{supported:boolean, styled:boolean, found:number, partial:number,
 *            missed:string[], total:number, truncated:boolean}}
 */
export function highlightQuotes(quotes) {
  const NAME = 'page-chatbot-cite';
  const MAX_CHARS = 300000; // 아주 긴 문서에서 인덱스가 무한히 커지지 않게
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|SELECT|OPTION|TEMPLATE)$/;
  const BLOCKS =
    'p,div,li,td,th,h1,h2,h3,h4,h5,h6,section,article,main,blockquote,pre,tr,dt,dd,figcaption,header,footer,aside,nav,body';

  const list = (Array.isArray(quotes) ? quotes : [quotes]).filter(
    (quote) => typeof quote === 'string' && quote.trim().length >= 4,
  );

  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') {
    return {
      supported: false,
      styled: false,
      found: 0,
      partial: 0,
      missed: list,
      total: list.length,
      truncated: false,
    };
  }
  if (list.length === 0) {
    CSS.highlights.delete(NAME);
    return {
      supported: true,
      styled: true,
      found: 0,
      partial: 0,
      missed: [],
      total: 0,
      truncated: false,
    };
  }

  /* 정규화 규칙 — 파일 상단 주석의 3곳이 같아야 합니다. */
  const QUOTE_CHARS = /['"‘’‚‛“”„‟]/;
  const SPACE_CHARS = /[\s ​　|]/;
  const canon = (ch) => {
    if (QUOTE_CHARS.test(ch)) return '"';
    if (SPACE_CHARS.test(ch)) return ' ';
    return ch.toLowerCase();
  };

  /* 1) 검색할 뿌리들 — 본문과 열린 shadow root(중첩 포함).
        extract.js 가 shadow root 안에서 본문을 읽는 경우가 있어 여기서도 봐야 합니다. */
  const roots = [];
  const collectRoots = (root, depth) => {
    if (!root || depth > 3 || roots.length > 200) return;
    roots.push(root);
    let elements;
    try {
      elements = Array.from(root.querySelectorAll('*'));
    } catch {
      return;
    }
    for (const element of elements) {
      if (element.shadowRoot) collectRoots(element.shadowRoot, depth + 1);
    }
  };
  collectRoots(document.body ?? document, 0);

  /* 2) 텍스트 노드를 이어 붙여 검색용 문자열과 위치 매핑을 만듭니다.
        공백만 있는 노드와 <br> 도 포함해야 extract.js 가 만든 본문과 단어 경계가 같아집니다. */
  const nodes = [];
  const flat = [];
  const nodeOf = [];
  const offsetOf = [];
  let lastWasSpace = true;
  let truncated = false;
  let previousNode = null;
  let previousNodeIndex = -1;

  /** 노드 경계·줄바꿈에서 넣는 공백은 '이전 노드의 마지막 글자' 에 매핑합니다.
      (새 노드의 0번째에 매핑하면 다음 단락 첫 글자까지 함께 칠해집니다.) */
  const pushBoundarySpace = () => {
    if (lastWasSpace || !previousNode || previousNodeIndex < 0) return;
    flat.push(' ');
    nodeOf.push(previousNodeIndex);
    offsetOf.push(Math.max(0, (previousNode.nodeValue ?? '').length - 1));
    lastWasSpace = true;
  };

  const blockOf = (node) => {
    try {
      return node.parentElement?.closest(BLOCKS) ?? null;
    } catch {
      return null;
    }
  };

  for (const root of roots) {
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (SKIP.test(node.tagName)) return NodeFilter.FILTER_REJECT; // 서브트리 전체 제외
            return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
          const parent = node.parentElement;
          if (parent && SKIP.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
    } catch {
      continue;
    }

    let previousBlock = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (flat.length >= MAX_CHARS) {
        truncated = true;
        break;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        pushBoundarySpace(); // <br> = 눈에 보이는 줄바꿈
        continue;
      }

      const block = blockOf(node);
      if (previousBlock !== null && block !== previousBlock) pushBoundarySpace();
      previousBlock = block;

      const nodeIndex = nodes.length;
      nodes.push(node);
      const value = node.nodeValue;
      for (let i = 0; i < value.length; i += 1) {
        const mapped = canon(value[i]);
        if (mapped === ' ') {
          if (lastWasSpace) continue; // 연속 공백은 한 칸으로
          flat.push(' ');
          nodeOf.push(nodeIndex);
          offsetOf.push(i);
          lastWasSpace = true;
          continue;
        }
        flat.push(mapped);
        nodeOf.push(nodeIndex);
        offsetOf.push(i);
        lastWasSpace = false;
      }
      previousNode = node;
      previousNodeIndex = nodeIndex;
    }
    // 뿌리(예: shadow root)가 바뀌면 경계로 취급합니다.
    pushBoundarySpace();
  }

  const haystack = flat.join('');

  /** 인용문을 haystack 과 같은 규칙으로 정규화합니다. */
  const normalize = (text) => {
    const stripped = String(text)
      .replace(/^#{1,6}\s+/, '') // extract.js 가 제목에 붙이는 표시
      .replace(/\s+\/\s+/g, ' '); // extract.js 가 표 셀 사이에 넣는 표시
    let out = '';
    let space = true;
    for (const ch of stripped) {
      const mapped = canon(ch);
      if (mapped === ' ') {
        if (!space) {
          out += ' ';
          space = true;
        }
        continue;
      }
      out += mapped;
      space = false;
    }
    return out.trim();
  };

  // extract.js 가 본문에서 제외하는 영역 — 여기의 중복 문장을 먼저 집으면
  // 모델이 근거로 삼지 않은 목차·메뉴로 스크롤하게 됩니다.
  const NOISE_CONTAINERS = 'nav,aside,footer,header,menu,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';

  /**
   * 일치 후보의 품질 점수(높을수록 좋음).
   *   2 = 화면에 보이고 본문 영역
   *   1 = 화면에 보이지만 메뉴·푸터 등
   *   0 = 화면에 보이지 않음(숨김 또는 화면 밖)
   */
  const rankOf = (node) => {
    const element = node?.parentElement;
    if (!element) return 0;
    let visible = true;
    try {
      if (typeof element.checkVisibility === 'function') {
        visible = element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
      } else {
        visible = element.getClientRects().length > 0;
      }
      if (visible) {
        // position:absolute; left:-9999px 처럼 '화면 밖으로 밀어내는' 숨김도 걸러냅니다.
        const rect = element.getBoundingClientRect();
        const width = Math.max(document.documentElement?.scrollWidth ?? 0, window.innerWidth || 0);
        const height = Math.max(document.documentElement?.scrollHeight ?? 0, window.innerHeight || 0);
        const pageLeft = rect.left + window.scrollX;
        const pageTop = rect.top + window.scrollY;
        if (pageLeft + rect.width < 0 || pageTop + rect.height < 0) visible = false;
        else if (pageLeft > width || pageTop > height) visible = false;
      }
    } catch {
      visible = true; // 판단할 수 없으면 후보로 둡니다.
    }
    if (!visible) return 0;
    try {
      return element.closest(NOISE_CONTAINERS) ? 1 : 2;
    } catch {
      return 2;
    }
  };

  const rangeFor = (start, end) => {
    if (start < 0 || end > flat.length || end <= start) return null;
    try {
      const range = document.createRange();
      range.setStart(nodes[nodeOf[start]], offsetOf[start]);
      range.setEnd(nodes[nodeOf[end - 1]], offsetOf[end - 1] + 1);
      return range;
    } catch {
      return null;
    }
  };

  /** 일치 위치가 여러 곳이면 '보이는 본문 쪽 첫 번째' 를 고릅니다. */
  const findBest = (needle) => {
    let at = haystack.indexOf(needle);
    let best = -1;
    let bestRank = -1;
    let guard = 0;
    while (at !== -1 && guard < 50) {
      const rank = rankOf(nodes[nodeOf[at]]);
      if (rank > bestRank) {
        best = at;
        bestRank = rank;
        if (rank === 2) return best; // 더 좋을 수 없음
      }
      at = haystack.indexOf(needle, at + 1);
      guard += 1;
    }
    return best;
  };

  const ranges = [];
  const missed = [];
  let partial = 0;

  for (const quote of list) {
    const needle = normalize(quote);
    if (needle.length < 4) {
      missed.push(quote);
      continue;
    }

    let at = findBest(needle);
    let length = needle.length;
    let isPartial = false;

    // 전체가 안 맞으면(모델이 중간을 줄여 인용한 경우) 앞부분만으로 다시 찾습니다.
    // 이때는 '일부만 일치' 로 보고해 사용자가 오해하지 않게 합니다.
    if (at === -1) {
      for (const size of [64, 48, 32, 24]) {
        if (needle.length <= size) continue;
        const candidate = findBest(needle.slice(0, size));
        if (candidate !== -1) {
          at = candidate;
          length = size;
          isPartial = true;
          break;
        }
      }
    }

    if (at === -1) {
      missed.push(quote);
      continue;
    }
    const range = rangeFor(at, at + length);
    if (!range) {
      missed.push(quote);
      continue;
    }
    ranges.push(range);
    if (isPartial) partial += 1;
  }

  if (ranges.length === 0) {
    CSS.highlights.delete(NAME);
    return {
      supported: true,
      styled: true,
      found: 0,
      partial: 0,
      missed,
      total: list.length,
      truncated,
    };
  }

  /* 3) 스타일은 구성 가능한 스타일시트로 넣습니다(DOM 을 건드리지 않음).
        커스텀 하이라이트는 기본 스타일이 없어, 스타일이 없으면 아무것도 보이지 않습니다. */
  let styled = true;
  try {
    let sheet = globalThis.__pageChatbotHighlightSheet;
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(
        `::highlight(${NAME}) { background-color: #fde68a; color: #111827; text-shadow: none; }`,
      );
      globalThis.__pageChatbotHighlightSheet = sheet;
    }
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
  } catch {
    styled = false;
  }

  CSS.highlights.set(NAME, new Highlight(...ranges));

  /* 4) 첫 번째 위치로 스크롤합니다. */
  try {
    ranges[0].startContainer.parentElement?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    });
  } catch {
    /* 스크롤 실패는 무시 */
  }

  return {
    supported: true,
    styled,
    found: ranges.length,
    partial,
    missed,
    total: list.length,
    truncated,
  };
}

/** 표시를 지웁니다. */
export function clearHighlights() {
  try {
    CSS.highlights?.delete('page-chatbot-cite');
  } catch {
    /* 무시 */
  }
  return { ok: true };
}

/* ------------------------------------------------ 패널 쪽에서 쓰는 순수 함수 */

/** highlightQuotes 의 haystack·normalize 와 같은 규칙(파일 상단 주석 참고). */
function flatten(value) {
  const QUOTE_CHARS = /['"‘’‚‛“”„‟]/;
  const SPACE_CHARS = /[\s ​　|]/;
  let out = '';
  let space = true;
  for (const ch of String(value ?? '')) {
    if (QUOTE_CHARS.test(ch)) {
      out += '"';
      space = false;
      continue;
    }
    if (SPACE_CHARS.test(ch)) {
      if (!space) {
        out += ' ';
        space = true;
      }
      continue;
    }
    out += ch.toLowerCase();
    space = false;
  }
  return out.trim();
}

/** 코드 블록·인라인 코드를 지웁니다(코드 안의 따옴표를 근거로 오인하지 않게). */
function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * 모델 답변에서 인용된 문장을 뽑고, 실제로 페이지 내용에 있는 것만 남깁니다.
 * (없는 문장을 근거처럼 보여 주지 않기 위해 반드시 원문과 대조합니다.)
 *
 * 전체가 일치하지 않고 앞부분만 일치하면 exact: false 로 표시합니다 —
 * 모델이 문장을 고쳐 쓴 경우이므로 '검증된 근거' 처럼 보여 주면 안 됩니다.
 *
 * @param {string} answer 모델 응답
 * @param {string} pageText 추출된 본문(필요하면 선택 영역까지 이어 붙여 넘깁니다)
 * @returns {Array<{text: string, exact: boolean}>}
 */
export function findCitations(answer, pageText) {
  const text = stripCode(answer);
  if (!text || !pageText) return [];

  const haystack = flatten(pageText);
  if (!haystack) return [];

  const found = [];
  const seen = new Set();
  // 중첩 따옴표를 삼키지 않도록 따옴표가 아닌 문자만 받습니다.
  const patterns = [
    /"([^"\n“”]{8,240})"/g,
    /[“„]([^”‟\n"]{8,240})[”‟]/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const quote = match[1].trim();
      const key = flatten(quote);
      if (key.length < 8 || seen.has(key)) continue;

      const exact = haystack.includes(key);
      if (!exact) {
        // 앞부분만 맞는 경우도 근거로 쓸 수 있지만 '일부' 로 구분합니다.
        const prefixes = [64, 48, 32, 24].filter((size) => key.length > size);
        if (!prefixes.some((size) => haystack.includes(key.slice(0, size)))) continue;
      }

      seen.add(key);
      found.push({ text: quote, exact });
      if (found.length >= 8) return found;
    }
  }
  return found;
}
