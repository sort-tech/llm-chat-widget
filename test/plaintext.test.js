/**
 * 폼에 붙여 넣을 평문 변환 — 기호는 걷고 구조(목록·표·줄바꿈)는 남겨야 합니다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { toPlainText } from '../src/lib/markdown.js';

test('강조·인라인 코드 기호를 걷어낸다', () => {
  assert.equal(toPlainText('이건 **중요**하고 `코드` 이며 _기울임_ 입니다.'), '이건 중요하고 코드 이며 기울임 입니다.');
  assert.equal(toPlainText('~~취소선~~'), '취소선');
});

test('제목·인용 기호를 없애고 글자만 남긴다', () => {
  assert.equal(toPlainText('## 제목\n\n> 인용문'), '제목\n\n인용문');
});

test('목록은 구조를 유지한다', () => {
  assert.equal(toPlainText('* 하나\n+ 둘\n- 셋'), '- 하나\n- 둘\n- 셋');
  assert.equal(toPlainText('1. 첫째\n2. 둘째'), '1. 첫째\n2. 둘째');
});

test('체크박스 목록은 읽을 수 있는 표시로 바꾼다', () => {
  assert.equal(toPlainText('- [x] 완료\n- [ ] 미완'), '- [완료] 완료\n- [ ] 미완');
});

test('코드 블록은 펜스만 걷고 내용과 줄바꿈을 유지한다', () => {
  assert.equal(toPlainText('```js\nconst x = 1;\nconsole.log(x);\n```'), 'const x = 1;\nconsole.log(x);');
});

test('코드 블록 안의 마크다운 기호는 건드리지 않는다', () => {
  assert.equal(toPlainText('```\n**그대로** `유지`\n```'), '**그대로** `유지`');
});

test('표는 구분선을 지우고 셀 구분만 남긴다', () => {
  const md = '| 구분 | 값 |\n| :--- | ---: |\n| 가 | 1 |';
  assert.equal(toPlainText(md), '구분 | 값\n가 | 1');
});

test('링크는 글자와 주소를 함께, 이미지는 대체 텍스트만 남긴다', () => {
  assert.equal(toPlainText('[문서](https://example.com) 참고'), '문서 (https://example.com) 참고');
  assert.equal(toPlainText('![그림](https://example.com/a.png)'), '그림');
  // 글자와 주소가 같으면 한 번만
  assert.equal(toPlainText('[https://a.com](https://a.com)'), 'https://a.com');
  // 글자가 없으면 주소만
  assert.equal(toPlainText('[](https://a.com)'), 'https://a.com');
});

test('구분선은 지우고 빈 줄이 과하게 쌓이지 않는다', () => {
  assert.equal(toPlainText('앞\n\n---\n\n뒤'), '앞\n\n뒤');
  assert.equal(toPlainText('앞\n\n\n\n뒤'), '앞\n\n뒤');
});

test('빈 입력과 null 을 안전하게 처리한다', () => {
  assert.equal(toPlainText(''), '');
  assert.equal(toPlainText(null), '');
  assert.equal(toPlainText(undefined), '');
});

test('전체 답변을 한 번에 변환해도 구조가 남는다', () => {
  const md = [
    '## 이 페이지 요약',
    '',
    '핵심은 **세 가지**입니다.',
    '',
    '1. 첫째 항목',
    '2. 둘째 항목',
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    '| 단락 | 3 |',
    '',
    '자세한 내용은 [문서](https://example.com) 를 보세요.',
  ].join('\n');
  const plain = toPlainText(md);
  assert.ok(!plain.includes('**'));
  assert.ok(!plain.includes('##'));
  assert.ok(!/^\|/m.test(plain), plain);
  assert.ok(plain.includes('1. 첫째 항목'));
  assert.ok(plain.includes('항목 | 값'));
  assert.ok(plain.includes('문서 (https://example.com)'));
});
