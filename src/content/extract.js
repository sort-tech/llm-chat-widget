/**
 * 현재 페이지의 본문을 추출해서 돌려주는 주입용 스크립트.
 *
 * chrome.scripting.executeScript({ files: ['src/content/extract.js'] }) 로 실행되며,
 * 마지막 표현식(아래 IIFE)의 값이 그대로 호출자에게 전달됩니다.
 * 격리된 월드(isolated world)에서 돌기 때문에 페이지 스크립트와 충돌하지 않습니다.
 */

(() => {
  'use strict';

  const HARD_LIMIT = 200000; // 메시지로 넘길 최대 글자 수
  const MIN_CANDIDATE_CHARS = 400;

  /** 본문과 무관하거나 잡음인 요소들. */
  /** 본문 컨테이너 안에 있으면 지우지 않을 요소들(기사 제목·바이라인·각주). */
  const KEEP_INSIDE = 'article, main, [role="main"], [itemprop="articleBody"]';

  /** 이름/역할로 보아 본문이 아닐 가능성이 높은 요소들(분량이 크면 남깁니다). */
  const NOISE_SELECTOR = [
    'nav',
    'aside',
    'footer',
    'header',
    'menu',
    'dialog',
    '[aria-hidden="true"]',
    '[hidden]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '[role="contentinfo"]',
    '[role="search"]',
    '[role="alert"]',
    '[role="dialog"]',
    '[role="tablist"]',
  ].join(',');

  /** 클래스/ID 이름으로 걸러낼 잡음 패턴. */
  const NOISE_NAME =
    /(^|[\s_-])(ad|ads|advert|advertisement|banner|sponsor|promo|popup|modal|overlay|cookie|consent|gdpr|newsletter|subscribe|share|social|sns|comment|comments|disqus|reply|sidebar|side-bar|related|recommend|recirc|widget|breadcrumb|pagination|paging|pager|nav|navbar|menu|toolbar|footer|header|masthead|skip|hidden|screen-reader|sr-only|visually-hidden)([\s_-]|$)/i;

  const BLOCK_TAGS = new Set([
    'DIV',
    'SECTION',
    'ARTICLE',
    'MAIN',
    'TD',
    'BLOCKQUOTE',
    'FORM',
    'DD',
    'PRE',
  ]);

  const SEMANTIC_SELECTORS = [
    'article',
    '[role="main"]',
    'main',
    '[itemprop="articleBody"]',
    '.article-body',
    '.article__body',
    '.post-content',
    '.entry-content',
    '.markdown-body',
    '#content',
    '.content',
  ];

  /** 공백을 한 칸으로 접습니다(양끝 공백은 유지 — 단어 경계 보존). */
  const collapse = (text) => String(text || '').replace(/[\s ​　]+/g, ' ');

  /** 접고 양끝까지 자릅니다(제목·메타데이터용). */
  const squash = (text) => collapse(text).trim();

  /** 필드별 길이 상한 — 페이지가 메타데이터로 요청 크기를 부풀리지 못하게. */
  const cap = (text, max) => squash(text).slice(0, max);

  const meta = (...names) => {
    for (const name of names) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`);
      const value = el?.getAttribute('content');
      if (value && value.trim()) return squash(value);
    }
    return '';
  };

  /* ---------------------------------------------------- 본문 후보 찾기 */

  /** 텍스트를 담을 수 없거나 절대 본문일 수 없는 태그 — 항상 제거합니다. */
  const ALWAYS_REMOVE =
    'script, style, noscript, template, svg, canvas, iframe, frame, object, embed, video, audio, source, track, map, select, option, textarea, input, button';

  /**
   * 잡음을 제거한 body 사본을 만듭니다.
   *
   * 2단계로 나눕니다.
   *   1) script/style 처럼 확실한 비-본문 태그를 먼저 지운 사본(baseline)을 만든다.
   *   2) 그 위에 이름/역할 기반 휴리스틱을 적용한다.
   * 2)가 과해서 본문까지 날아가면 1)의 결과로 되돌립니다.
   * (되돌릴 때도 script 소스가 본문에 섞이지 않습니다.)
   */
  const buildCleanClone = () => {
    if (!document.body) return null;

    const clone = document.body.cloneNode(true);
    for (const el of Array.from(clone.querySelectorAll(ALWAYS_REMOVE))) el.remove();

    // 비율 비교용이라 정밀도가 필요 없어 원문 길이를 그대로 씁니다(정규식 비용 회피).
    const baseline = clone.cloneNode(true);
    const originalChars = (clone.textContent || '').length;

    /**
     * 이 요소가 페이지 본문 대부분을 담고 있으면 잡음이 아니라 본문 컨테이너입니다.
     * (예: 클래스 이름에 'nav' 가 들어간 래퍼, 모달이 열려 aria-hidden 이 걸린 본문)
     */
    const holdsMostText = (el) => {
      // 자식이 없는 작은 요소는 본문 컨테이너일 수 없으므로 즉시 제외(빠른 경로).
      if (el.childElementCount === 0) return false;
      const chars = (el.textContent || '').length;
      return chars >= 150 && chars >= originalChars * 0.4;
    };

    for (const el of Array.from(clone.querySelectorAll(NOISE_SELECTOR))) {
      // 기사 컨테이너 안의 header/footer 에는 제목·작성자·각주가 들어 있어 남깁니다.
      if (/^(HEADER|FOOTER)$/.test(el.tagName) && el.closest(KEEP_INSIDE)) continue;
      if (holdsMostText(el)) continue;
      el.remove();
    }

    for (const el of Array.from(clone.querySelectorAll('[class],[id]'))) {
      const name = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
      if (!name.trim()) continue;
      if (!NOISE_NAME.test(name)) continue;
      if (holdsMostText(el)) continue;
      el.remove();
    }

    const keptChars = (clone.textContent || '').length;
    if (originalChars >= 100 && keptChars < Math.max(80, originalChars * 0.25)) {
      return { root: baseline, fellBack: true };
    }
    return { root: clone, fellBack: false };
  };

  /**
   * 요소별 텍스트/링크 길이를 한 번의 역순 순회로 계산합니다(O(n)).
   */
  const measure = (root) => {
    // root 도 포함해야 bodyChars 와 후보 길이의 단위가 같아집니다.
    const elements = [...Array.from(root.querySelectorAll('*')), root];
    const textLen = new Map();
    const linkLen = new Map();
    const pCount = new Map();

    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const el = elements[i];
      let chars = 0;
      let links = 0;
      let paragraphs = 0;

      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          chars += squash(node.nodeValue).length;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          chars += textLen.get(node) || 0;
          links += linkLen.get(node) || 0;
          paragraphs += pCount.get(node) || 0;
          if (node.tagName === 'P' || node.tagName === 'LI') paragraphs += 1;
        }
      }

      if (el.tagName === 'A') links = chars;
      textLen.set(el, chars);
      linkLen.set(el, links);
      pCount.set(el, paragraphs);
    }

    return { elements, textLen, linkLen, pCount };
  };

  const scoreOf = (el, stats) => {
    const chars = stats.textLen.get(el) || 0;
    if (chars < MIN_CANDIDATE_CHARS) return 0;
    const links = stats.linkLen.get(el) || 0;
    const linkDensity = chars > 0 ? links / chars : 1;
    if (linkDensity > 0.6) return 0; // 링크 목록 페이지
    const paragraphs = stats.pCount.get(el) || 0;
    const semanticBonus =
      el.tagName === 'ARTICLE' || el.tagName === 'MAIN' || el.getAttribute('role') === 'main'
        ? 1.25
        : 1;
    return chars * (1 - linkDensity) * (1 + Math.min(paragraphs, 40) / 40) * semanticBonus;
  };

  /** 점수가 가장 높은 본문 컨테이너를 고릅니다. */
  const pickContainer = (clone) => {
    const stats = measure(clone);
    const bodyChars = stats.textLen.get(clone) || 0;

    // 1) 의미 있는 태그가 충분한 분량을 담고 있으면 그대로 사용
    for (const selector of SEMANTIC_SELECTORS) {
      let best = null;
      let bestChars = 0;
      for (const el of Array.from(clone.querySelectorAll(selector))) {
        const chars = stats.textLen.get(el) || 0;
        if (chars > bestChars) {
          best = el;
          bestChars = chars;
        }
      }
      if (best && bestChars >= MIN_CANDIDATE_CHARS && bestChars >= bodyChars * 0.35) {
        return { element: best, source: selector, stats };
      }
    }

    // 2) 점수 기반 탐색
    let best = null;
    let bestScore = 0;
    for (const el of stats.elements) {
      if (el === clone) continue; // root 는 후보가 아니라 기준값입니다.
      if (!BLOCK_TAGS.has(el.tagName)) continue;
      const score = scoreOf(el, stats);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    // 3) 부모 점수가 비슷하면 부모를 택해 잘려 나간 문단을 되살립니다.
    if (best) {
      let current = best;
      while (current.parentElement && current.parentElement !== clone) {
        const parentScore = scoreOf(current.parentElement, stats);
        if (parentScore >= bestScore * 0.92) {
          current = current.parentElement;
          bestScore = Math.max(bestScore, parentScore);
        } else break;
      }
      return { element: current, source: 'score', stats };
    }

    return { element: clone, source: 'body', stats };
  };

  /* ------------------------------------------------------ 텍스트 직렬화 */

  /**
   * 표 셀의 텍스트. 셀 안의 <br> 이나 블록 자식이 구분 없이 붙어
   * "3" + "4" → "34" 같은 없던 값이 만들어지는 것을 막습니다.
   */
  const cellText = (element) => {
    let out = '';
    const walkCell = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = squash(node.nodeValue);
        if (text) out += `${text} `;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        out += ' / ';
        return;
      }
      for (const child of node.childNodes) walkCell(child);
      if (/^(P|DIV|LI|UL|OL|SECTION|TABLE|DL|DD|DT|H[1-6])$/.test(node.tagName)) out += ' / ';
    };
    for (const child of element.childNodes) walkCell(child);
    return (
      out
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/ {2,}/g, ' ')
        // 빈 칸이 이어져 '/ / /' 처럼 되는 것을 하나로 접습니다(표로 레이아웃을 잡은 페이지).
        // 공백을 먼저 정리한 뒤에 해야 '/  /' 같은 경우도 접힙니다.
        .replace(/(?:\/ ){2,}/g, '/ ')
        .replace(/(?: \/){2,}/g, ' /')
        .replace(/^\s*\/\s*|\s*\/\s*$/g, '')
        .replace(/ {2,}/g, ' ')
        .trim()
    );
  };

  const serialize = (root) => {
    const out = [];
    let length = 0;
    let truncated = false;
    let depthClipped = false;

    const push = (text) => {
      if (truncated || !text) return;
      if (length + text.length > HARD_LIMIT) {
        out.push(text.slice(0, Math.max(0, HARD_LIMIT - length)));
        length = HARD_LIMIT;
        truncated = true;
        return;
      }
      out.push(text);
      length += text.length;
    };

    const walk = (node, depth) => {
      if (truncated) return;
      if (depth > 40) {
        depthClipped = true;
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        // 공백은 접기만 하고 양끝은 자르지 않습니다. trim 하고 뒤에 공백을 붙이면
        // "안녕<b>하세요</b>" 가 "안녕 하세요" 로 갈라지고, 반대로 원문에 있던
        // 단어 사이 공백이 사라집니다.
        const text = collapse(node.nodeValue);
        if (text.trim() !== '' || /[ ]/.test(text)) push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;

      if (tag === 'BR') {
        push('\n');
        return;
      }
      if (tag === 'HR') {
        push('\n---\n');
        return;
      }
      if (tag === 'PRE') {
        const code = (node.textContent || '').replace(/\s+$/, '');
        if (code.trim()) push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
        return;
      }
      if (/^H[1-6]$/.test(tag)) {
        const text = squash(node.textContent);
        if (text) push(`\n\n${'#'.repeat(Number(tag[1]))} ${text}\n`);
        return;
      }
      if (tag === 'LI') {
        push('\n- ');
        for (const child of node.childNodes) walk(child, depth + 1);
        return;
      }
      if (tag === 'TR') {
        // 표로 레이아웃을 잡은 페이지(중첩 표)는 일반 경로로 내려가야 내용이 붙지 않습니다.
        if (node.querySelector('table')) {
          for (const child of node.childNodes) walk(child, depth + 1);
          push('\n');
          return;
        }
        const cells = Array.from(node.children)
          .map((cell) => cellText(cell))
          .filter((cell) => cell !== '');
        if (cells.length) push(`\n| ${cells.join(' | ')} |`);
        return;
      }
      if (tag === 'IMG') {
        const alt = squash(node.getAttribute('alt'));
        if (alt) push(`[이미지: ${alt}] `);
        return;
      }

      const isBlock = /^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|DL|DT|DD|TABLE|BLOCKQUOTE|FIGURE|FIGCAPTION|ADDRESS|DETAILS|SUMMARY|ASIDE|FOOTER|HEADER)$/.test(
        tag,
      );
      if (isBlock) push('\n\n');
      for (const child of node.childNodes) walk(child, depth + 1);
      if (isBlock) push('\n\n');
    };

    // ShadowRoot/Document 는 요소가 아니라 문서 조각이므로 자식부터 훑습니다.
    if (root.nodeType === Node.ELEMENT_NODE) walk(root, 0);
    else for (const child of root.childNodes) walk(child, 0);

    const text = out
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+/, '')
      .replace(/\s+$/, '');

    return { text, truncated, depthClipped };
  };

  /**
   * 열린 shadow root 안의 텍스트를 모읍니다(웹 컴포넌트로 만든 사이트용).
   * 잡음 제거를 적용하지 않는 예비 경로이므로, 본문을 못 찾았을 때만 씁니다.
   */
  const collectShadowText = () => {
    const parts = [];
    let total = 0;
    const visit = (root, depth) => {
      if (depth > 3 || total > 60000) return;
      let hosts;
      try {
        hosts = Array.from(root.querySelectorAll('*'));
      } catch {
        return;
      }
      for (const el of hosts) {
        const shadow = el.shadowRoot;
        if (!shadow) continue;
        const piece = serialize(shadow);
        if (piece.text.length >= 25) {
          parts.push(piece.text);
          total += piece.text.length;
        }
        visit(shadow, depth + 1);
        if (total > 60000) return;
      }
    };
    visit(document, 0);
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  /* ---------------------------------------------------------- 실행부 */

  try {
    const selection = (() => {
      try {
        const value = window.getSelection?.()?.toString() ?? '';
        if (value.trim().length < 2) return '';
        return value.replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
      } catch {
        return '';
      }
    })();

    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .map((el) => ({ level: Number(el.tagName[1]), text: cap(el.textContent, 200) }))
      .filter((h) => h.text)
      .slice(0, 40);

    const cleaned = buildCleanClone();
    const clone = cleaned?.root ?? null;
    let text = '';
    let truncated = false;
    let depthClipped = false;
    let source = cleaned?.fellBack ? 'body(정리 취소)' : 'none';

    if (clone) {
      const picked = pickContainer(clone);
      const primary = serialize(picked.element);
      text = primary.text;
      truncated = primary.truncated;
      depthClipped = primary.depthClipped;
      source = cleaned.fellBack ? `${picked.source}(정리 취소)` : picked.source;

      // 후보가 너무 짧으면 body 전체로 다시 시도합니다.
      if (text.length < 200) {
        const fallback = serialize(clone);
        if (fallback.text.length > text.length) {
          text = fallback.text;
          truncated = fallback.truncated;
          depthClipped = fallback.depthClipped;
          source = 'body';
        }
      }

      // 그래도 짧으면 웹 컴포넌트(열린 shadow root) 안을 봅니다.
      // cloneNode 는 shadow root 를 복제하지 않아 위 경로로는 보이지 않습니다.
      if (text.length < 200) {
        const shadowText = collectShadowText();
        if (shadowText.length > text.length) {
          text = shadowText;
          source = 'shadow-dom';
        }
      }
    }

    return {
      ok: true,
      // 필드마다 상한을 둡니다(페이지가 메타데이터로 요청을 부풀리지 못하게).
      url: (document.location?.href ?? '').slice(0, 2000),
      title: cap(meta('og:title', 'twitter:title') || document.title, 300),
      description: cap(meta('description', 'og:description', 'twitter:description'), 1000),
      siteName: cap(meta('og:site_name') || (document.location?.hostname ?? ''), 300),
      publishedTime: cap(
        meta('article:published_time', 'datePublished') ||
          (document.querySelector('time[datetime]')?.getAttribute('datetime') ?? ''),
        64,
      ),
      lang: cap(document.documentElement?.lang ?? '', 32),
      selection,
      headings,
      text,
      charCount: text.length,
      truncated,
      depthClipped,
      source,
      // 본문을 못 읽었을 때 "내부 프레임 때문"인지 안내하기 위한 정보
      hasFrames: document.querySelectorAll('iframe,frame').length > 0,
      hasShadowRoots: Array.from(document.querySelectorAll('*')).some((el) => el.shadowRoot != null),
    };
  } catch (error) {
    return {
      ok: false,
      url: document.location?.href ?? '',
      title: cap(document.title, 300),
      selection: '',
      text: '',
      charCount: 0,
      hasFrames: false,
      error: String(error?.message ?? error).slice(0, 500),
    };
  }
})();
