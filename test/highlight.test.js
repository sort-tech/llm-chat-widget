/**
 * findCitations 는 순수 함수라 Node 에서 검증할 수 있습니다.
 * DOM 을 만지는 highlightQuotes/clearHighlights 는 브라우저에서 확인합니다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { findCitations } from '../src/content/highlight.js';

const pageText = [
  '# 환불 정책',
  '환불은 결제일로부터 14일 이내에 신청할 수 있으며, 수수료 3,000원이 차감됩니다.',
  '문의는 고객센터로 해주세요.',
].join('\n\n');

const texts = (citations) => citations.map((c) => c.text);

test('본문에 실제로 있는 인용만 근거로 남긴다', () => {
  const answer =
    '문서에 따르면 "수수료 3,000원이 차감됩니다" 라고 되어 있습니다. ' +
    '또 "환불은 30일 이내에 신청할 수 있습니다" 라는 말도 있습니다.';
  const citations = findCitations(answer, pageText);
  assert.deepEqual(texts(citations), ['수수료 3,000원이 차감됩니다']);
  assert.equal(citations[0].exact, true);
});

test('둥근 따옴표도 인식한다', () => {
  const citations = findCitations('“문의는 고객센터로 해주세요”', pageText);
  assert.deepEqual(texts(citations), ['문의는 고객센터로 해주세요']);
});

test('같은 인용이 여러 번 나와도 한 번만 남는다', () => {
  const answer = '"문의는 고객센터로" 그리고 다시 "문의는 고객센터로" 입니다.';
  assert.equal(findCitations(answer, pageText).length, 1);
});

test('줄여 인용하면 근거로 쓰되 exact: false 로 구분한다 (회귀)', () => {
  const answer = '"환불은 결제일로부터 14일 이내에 신청할 수 있으며, 수수료가 차감됩니다"';
  const citations = findCitations(answer, pageText);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].exact, false, '고쳐 쓴 인용이 정확한 근거로 표시됐습니다');
});

test('공백·표 기호·제로폭 공백 차이는 무시한다 (회귀)', () => {
  assert.equal(findCitations('"수수료  3,000원이   차감됩니다"', pageText)[0].exact, true);
  assert.equal(findCitations('"수수료 3,000원이​ 차감됩니다"', pageText)[0].exact, true);
  assert.equal(
    findCitations('"문의는 | 고객센터로 해주세요"', pageText)[0].exact,
    true,
    '표 구분자가 들어간 인용을 놓쳤습니다',
  );
});

test('아포스트로피·따옴표 종류가 달라도 같은 문장으로 본다 (회귀)', () => {
  const english = "Don't panic when the server returns 500 errors.";
  const citations = findCitations(`"Don’t panic when the server returns 500 errors."`, english);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].exact, true);
});

test('코드 블록·인라인 코드 안의 따옴표는 근거로 쓰지 않는다 (회귀)', () => {
  const body = 'name 필드에는 사용자 이름이 들어갑니다. 값은 예시로 표시합니다.';
  const answer = [
    '```json',
    '{ "name": "사용자 이름이 들어갑니다" }',
    '```',
    '인라인도 `{ "name": "사용자 이름이 들어갑니다" }` 처럼 씁니다.',
  ].join('\n');
  assert.deepEqual(findCitations(answer, body), []);
});

test('중첩 따옴표를 통째로 삼키지 않는다', () => {
  const body = '설정에서 항목을 고르면 값이 저장됩니다.';
  const answer = '문서는 "항목을 고르면" 이라고 하고 "값이 저장됩니다" 라고 합니다.';
  const citations = findCitations(answer, body);
  assert.ok(citations.every((c) => !c.text.includes('"')), JSON.stringify(citations));
});

test('너무 짧은 인용은 무시한다', () => {
  assert.deepEqual(findCitations('"환불"', pageText), []);
});

test('본문이 없으면 아무것도 돌려주지 않는다', () => {
  assert.deepEqual(findCitations('"수수료 3,000원이 차감됩니다"', ''), []);
  assert.deepEqual(findCitations('"x"', null), []);
  assert.deepEqual(findCitations(null, pageText), []);
});

test('근거는 최대 8개까지만 모은다', () => {
  const body = Array.from({ length: 20 }, (_, i) => `문장 번호 ${i} 입니다 충분히 길게.`).join('\n\n');
  const answer = Array.from({ length: 20 }, (_, i) => `"문장 번호 ${i} 입니다 충분히 길게."`).join(' ');
  assert.equal(findCitations(answer, body).length, 8);
});

test('선택 영역만 이어 붙여 넘겨도 근거를 찾는다', () => {
  const selection = '사용자가 화면에서 직접 고른 문장입니다.';
  const citations = findCitations('"사용자가 화면에서 직접 고른 문장입니다."', selection);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].exact, true);
});
