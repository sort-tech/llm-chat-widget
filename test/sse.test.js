import assert from 'node:assert/strict';
import test from 'node:test';

import { coerceContent, createEventStreamParser, readChunk } from '../src/lib/sse.js';

const dataOf = (events) => events.map((event) => event.data);

test('줄 중간에서 끊긴 청크를 이어 붙여 해석한다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push('data: {"a":')), []);
  assert.deepEqual(dataOf(parser.push('1}\n')), []);
  assert.deepEqual(dataOf(parser.push('\n')), ['{"a":1}']);
});

test('한 청크에 여러 프레임이 들어와도 모두 돌려준다', () => {
  const parser = createEventStreamParser();
  const events = parser.push('data: one\n\ndata: two\n\ndata: [DONE]\n\n');
  assert.deepEqual(dataOf(events), ['one', 'two', '[DONE]']);
});

test('CRLF 와 청크 경계에 걸친 CR 을 처리한다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push('data: hi\r')), []);
  assert.deepEqual(dataOf(parser.push('\n\r\n')), ['hi']);
});

test('여러 data 줄은 개행으로 이어 붙인다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push('data: a\ndata: b\n\n')), ['a\nb']);
});

test('주석(keep-alive)과 빈 프레임은 무시한다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push(': ping\n\n\n\ndata: x\n\n')), ['x']);
});

test('event/id 필드를 읽는다', () => {
  const parser = createEventStreamParser();
  const [event] = parser.push('event: delta\nid: 7\ndata: x\n\n');
  assert.equal(event.event, 'delta');
  assert.equal(event.id, '7');
});

test('data 값 앞의 공백 한 칸만 제거한다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push('data:  두칸\n\n')), [' 두칸']);
});

test('빈 줄 없이 끝난 스트림도 flush 로 건져낸다', () => {
  const parser = createEventStreamParser();
  assert.deepEqual(dataOf(parser.push('data: tail')), []);
  assert.deepEqual(dataOf(parser.flush()), ['tail']);
});

test('flush 를 두 번 불러도 같은 프레임이 반복되지 않는다', () => {
  const parser = createEventStreamParser();
  parser.push('data: one');
  assert.deepEqual(dataOf(parser.flush()), ['one']);
  assert.deepEqual(dataOf(parser.flush()), []);
});

test('readChunk 는 delta.content 를 읽는다', () => {
  const parsed = readChunk({ choices: [{ delta: { content: '안녕' } }] });
  assert.equal(parsed.text, '안녕');
  assert.equal(parsed.error, null);
});

test('readChunk 는 배열 형태의 content 도 이어 붙인다', () => {
  const parsed = readChunk({
    choices: [{ delta: { content: [{ type: 'text', text: 'a' }, { text: 'b' }, 'c'] } }],
  });
  assert.equal(parsed.text, 'abc');
});

test('readChunk 는 스트리밍이 아닌 message 응답도 읽는다', () => {
  const parsed = readChunk({
    choices: [{ message: { role: 'assistant', content: '완성 응답' }, finish_reason: 'stop' }],
    usage: { total_tokens: 12 },
  });
  assert.equal(parsed.text, '완성 응답');
  assert.equal(parsed.finishReason, 'stop');
  assert.deepEqual(parsed.usage, { total_tokens: 12 });
});

test('readChunk 는 error 를 문자열로 정리한다', () => {
  assert.equal(readChunk({ error: { message: '모델 없음' } }).error, '모델 없음');
  assert.equal(readChunk({ error: '문자열 오류' }).error, '문자열 오류');
});

test('readChunk 는 이상한 입력에도 빈 결과를 돌려준다', () => {
  for (const input of [null, undefined, 42, 'text', {}, { choices: [] }]) {
    const parsed = readChunk(input);
    assert.equal(parsed.text, '');
    assert.equal(parsed.error, null);
  }
});

test('coerceContent 동작', () => {
  assert.equal(coerceContent('a'), 'a');
  assert.equal(coerceContent(['a', { text: 'b' }]), 'ab');
  assert.equal(coerceContent({ text: 'c' }), 'c');
  assert.equal(coerceContent(null), '');
  assert.equal(coerceContent(123), '');
});
