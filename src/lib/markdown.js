/**
 * 모델 응답을 보여주기 위한 작은 마크다운 → HTML 변환기.
 *
 * 외부 라이브러리를 쓰지 않고, 확장 프로그램의 기본 CSP 안에서 동작합니다.
 * 안전성 원칙:
 *   1) 블록 구조를 먼저 나눈다(원문의 '>' 같은 기호가 살아 있어야 하므로).
 *   2) 텍스트가 실제로 HTML 이 되는 지점(renderInline / 코드 블록)에서 반드시 이스케이프한다.
 *   3) 그 뒤에만 우리가 만든 태그(<strong>, <a>, <pre> …)를 끼워 넣는다.
 *   4) 링크는 http/https/mailto 만 허용한다.
 * 따라서 원문에 있던 `<script>` 같은 문자열은 절대 태그로 살아나지 않습니다.
 */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** http/https/mailto 만 통과시킵니다. 그 밖(javascript:, data: …)은 null. */
export function sanitizeUrl(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;
  // 이스케이프된 문자열이 들어오므로 스킴 판별 전에 &amp; 만 되돌려 검사합니다.
  const probe = url.replace(/&amp;/g, '&');
  if (/^(https?:\/\/|mailto:)/i.test(probe)) return url;
  return null;
}

// 마커는 문서에 나타나지 않는 사용자 영역(Private Use Area) 문자를 씁니다.
// (실제 NUL 바이트를 쓰면 소스가 바이너리로 취급되어 grep/diff 가 깨집니다.)
const MARKER = '\uE000';

/** 완성된 HTML 조각을 잠시 숨겨 두는 보관소(이스케이프/강조 변환에서 보호). */
function createVault() {
  const slots = [];
  return {
    stash(html) {
      slots.push(html);
      return `${MARKER}v${slots.length - 1}${MARKER}`;
    },
    restore(text) {
      let out = text;
      // 숨겨 둔 조각 안에 또 마커가 있을 수 있어 몇 번 반복합니다.
      for (let i = 0; i < 5 && out.includes(MARKER); i += 1) {
        out = out.replace(
          new RegExp(`${MARKER}v(\\d+)${MARKER}`, 'g'),
          (_, index) => slots[Number(index)] ?? '',
        );
      }
      return out;
    },
  };
}

/**
 * 속성값(title/alt/href)에 넣기 전, 안에 남아 있을 수 있는 내부 마커를 지웁니다.
 * `[x](url "![y](img)")` 처럼 title 캡처 안으로 stash 마커가 들어오면,
 * 복원 단계에서 따옴표가 실려 와 속성/태그 탈출이 일어납니다.
 * 이 시점의 문자열은 이미 escapeHtml 을 거쳤으므로 다시 이스케이프하지 않습니다.
 */
const MARKER_RE = new RegExp(`${MARKER}v\\d+${MARKER}`, 'g');
const attr = (value) => String(value ?? '').replace(MARKER_RE, '');

/* ------------------------------------------------------------- 인라인 */

function renderInline(raw, vault) {
  // 이 지점에서 텍스트가 HTML 로 들어가므로 여기서 반드시 이스케이프합니다.
  let text = escapeHtml(raw);

  // 1) 인라인 코드 (`code`, ``co`de``)
  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) =>
    vault.stash(`<code>${code.trim()}</code>`),
  );

  // 2) 이미지 ![alt](url) — 링크보다 먼저 처리해야 합니다.
  //    실제 <img> 로 만들지 않습니다. 원격 이미지는 클릭 없이 자동으로 요청되므로,
  //    페이지 내용이 모델을 조종(프롬프트 인젝션)하면 대화 내용을 URL 에 실어
  //    외부로 내보내는 통로가 됩니다. 사용자가 눌러야 열리는 링크로 바꿉니다.
  text = text.replace(
    /!\[([^\]\n]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (match, alt, url) => {
      const safe = sanitizeUrl(url);
      if (!safe) return match;
      return vault.stash(
        `<a class="md-image" href="${attr(safe)}" target="_blank" rel="noopener noreferrer nofollow">🖼 ${
          attr(alt) || '이미지'
        }</a>`,
      );
    },
  );

  // 3) 링크 [text](url)
  text = text.replace(
    /\[([^\]\n]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (match, label, url, title) => {
      const safe = sanitizeUrl(url);
      if (!safe) return match;
      const titleAttr = title ? ` title="${attr(title)}"` : '';
      return vault.stash(
        `<a href="${attr(safe)}" target="_blank" rel="noopener noreferrer nofollow"${titleAttr}>${
          label || attr(safe)
        }</a>`,
      );
    },
  );

  // 4) 남아 있는 맨 URL 자동 링크
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"'`)\uE000]+)/g,
    (match, lead, url) => {
      // 문장 끝 기호는 링크에서 제외합니다.
      const trimmed = url.replace(/[.,;:!?]+$/, '');
      const tail = url.slice(trimmed.length);
      const safe = sanitizeUrl(trimmed);
      if (!safe) return match;
      return `${lead}${vault.stash(
        `<a href="${attr(safe)}" target="_blank" rel="noopener noreferrer nofollow">${attr(safe)}</a>`,
      )}${tail}`;
    },
  );

  // 5) 강조
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|\W)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  text = text.replace(/\*(?=\S)([^*\n]*?\S)\*/g, '<em>$1</em>');
  text = text.replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');

  // 6) 줄 안의 개행은 <br> (대화형 답변에서는 이게 더 자연스럽습니다)
  text = text.replace(/\n/g, '<br>');

  return text;
}

/* -------------------------------------------------------------- 블록 */

const RE_FENCE = /^\s{0,3}(```+|~~~+)\s*([^\n`]*)$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const isBlockStart = (line) =>
  RE_FENCE.test(line) ||
  RE_HEADING.test(line) ||
  RE_HR.test(line) ||
  RE_QUOTE.test(line) ||
  RE_LIST.test(line) ||
  line.trim() === '';

const indentWidth = (spaces) => spaces.replace(/\t/g, '    ').length;

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function renderList(items, vault) {
  let i = 0;

  const build = (indent) => {
    const ordered = items[i].ordered;
    let html = ordered ? '<ol>' : '<ul>';
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        html += build(items[i].indent);
        continue;
      }
      if (items[i].ordered !== ordered) break;

      const item = items[i];
      i += 1;
      let nested = '';
      while (i < items.length && items[i].indent > indent) {
        nested += build(items[i].indent);
      }
      const box =
        item.checked === null
          ? ''
          : `<span class="md-task ${item.checked ? 'is-done' : ''}" aria-hidden="true">${
              item.checked ? '☑' : '☐'
            }</span> `;
      html += `<li>${box}${renderInline(item.text, vault)}${nested}</li>`;
    }
    return html + (ordered ? '</ol>' : '</ul>');
  };

  let out = '';
  while (i < items.length) out += build(items[i].indent);
  return out;
}

function renderBlocks(source, vault) {
  const lines = source.split('\n');
  let out = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 코드 블록
    const fence = line.match(RE_FENCE);
    if (fence) {
      const [, ticks, info] = fence;
      const closer = new RegExp(`^\\s{0,3}${ticks[0]}{${ticks.length},}\\s*$`);
      i += 1;
      const body = [];
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 닫는 펜스 소비
      const lang = (info || '').trim().split(/\s+/)[0];
      const langClass = /^[\w+#.-]{1,24}$/.test(lang) ? ` class="language-${lang}"` : '';
      const label = langClass ? `<span class="md-lang">${escapeHtml(lang)}</span>` : '';
      out += `<pre data-code="1">${label}<code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`;
      continue;
    }

    // 제목
    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = heading[1].length;
      out += `<h${level}>${renderInline(heading[2].trim(), vault)}</h${level}>`;
      i += 1;
      continue;
    }

    // 구분선
    if (RE_HR.test(line)) {
      out += '<hr>';
      i += 1;
      continue;
    }

    // 인용
    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length) {
        const match = lines[i].match(RE_QUOTE);
        if (match) {
          body.push(match[1]);
        } else if (body.length > 0 && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
          body.push(lines[i].trim()); // '>' 없이 이어지는 줄(lazy continuation)
        } else {
          break;
        }
        i += 1;
      }
      out += `<blockquote>${renderBlocks(body.join('\n'), vault)}</blockquote>`;
      continue;
    }

    // 표 (헤더 + 구분선이 연속으로 올 때만)
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const alignAttr = (index) => (aligns[index] ? ` style="text-align:${aligns[index]}"` : '');
      const head = header
        .map((cell, index) => `<th${alignAttr(index)}>${renderInline(cell, vault)}</th>`)
        .join('');
      const body = rows
        .map((row) => {
          const cells = [];
          for (let c = 0; c < header.length; c += 1) {
            cells.push(`<td${alignAttr(c)}>${renderInline(row[c] ?? '', vault)}</td>`);
          }
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('');
      out += `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }

    // 목록
    if (RE_LIST.test(line)) {
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(RE_LIST);
        if (match) {
          const [, spaces, marker, rest] = match;
          const task = rest.match(/^\[([ xX])\]\s+(.*)$/);
          items.push({
            indent: indentWidth(spaces),
            ordered: /\d/.test(marker),
            checked: task ? task[1].toLowerCase() === 'x' : null,
            text: task ? task[2] : rest,
          });
          i += 1;
          continue;
        }
        // 목록 항목에 이어지는 들여쓴 줄은 직전 항목에 붙입니다.
        if (items.length && /^\s+\S/.test(lines[i]) && !isBlockStart(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out += renderList(items, vault);
      continue;
    }

    // 문단
    const paragraph = [line];
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    out += `<p>${renderInline(paragraph.join('\n').trim(), vault)}</p>`;
  }

  return out;
}

/**
 * 마크다운을 안전한 HTML 문자열로 바꿉니다.
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
  const normalized = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    // 제어문자와 내부 마커 문자는 미리 제거합니다(마커 위조 방지).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uE000]/g, '');

  const vault = createVault();
  const html = renderBlocks(normalized, vault);
  return vault.restore(html);
}

/** 사람이 읽는 평문만 필요할 때(예: 클립보드 미리보기) 사용합니다. */
export function stripMarkdown(source) {
  return String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
