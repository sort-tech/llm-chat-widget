import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestBody,
  chatCompletionsUrl,
  describeError,
  LlmError,
  modelsUrl,
  normalizeBaseUrl,
  validateBaseUrl,
} from '../src/lib/llm.js';

test('여러 형태의 서버 주소를 하나로 정리한다', () => {
  const cases = [
    ['http://localhost:4000/', 'http://localhost:4000'],
    ['http://localhost:4000', 'http://localhost:4000'],
    ['localhost:4000', 'http://localhost:4000'],
    ['  http://localhost:4000//  ', 'http://localhost:4000'],
    ['http://localhost:4000/v1/', 'http://localhost:4000/v1'],
    ['http://localhost:4000/chat/completions', 'http://localhost:4000'],
    ['http://localhost:4000/v1/chat/completions', 'http://localhost:4000/v1'],
    ['https://litellm.example.com/api?x=1', 'https://litellm.example.com/api'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeBaseUrl(input), expected, `입력: ${JSON.stringify(input)}`);
  }
});

test('파이썬 예제와 같은 base_url 이 같은 엔드포인트를 만든다', () => {
  // OpenAI SDK 는 base_url 뒤에 chat/completions 를 붙입니다.
  assert.equal(chatCompletionsUrl('http://localhost:4000/'), 'http://localhost:4000/chat/completions');
  assert.equal(modelsUrl('http://localhost:4000/'), 'http://localhost:4000/models');
  assert.equal(
    chatCompletionsUrl('http://localhost:4000/v1'),
    'http://localhost:4000/v1/chat/completions',
  );
});

test('http/https 가 아닌 주소는 거부한다', () => {
  assert.equal(validateBaseUrl('ftp://a.com').ok, false);
  assert.equal(validateBaseUrl('file:///tmp').ok, false);
  assert.equal(validateBaseUrl('').ok, false);
  assert.equal(validateBaseUrl('http://localhost:4000').ok, true);
  assert.equal(validateBaseUrl('localhost:4000').ok, true);
});

test('max_tokens 는 0 보다 클 때만 보낸다', () => {
  const base = { model: 'gemini-flash', messages: [], temperature: 0.3 };
  assert.equal(Object.hasOwn(buildRequestBody({ ...base, maxTokens: 0 }), 'max_tokens'), false);
  assert.equal(buildRequestBody({ ...base, maxTokens: 256 }).max_tokens, 256);
});

test('요청 본문에 model/messages/stream 이 들어간다', () => {
  const body = buildRequestBody({
    model: 'gemini-flash',
    messages: [{ role: 'user', content: '안녕' }],
    temperature: 0.7,
    maxTokens: 0,
    stream: true,
  });
  assert.equal(body.model, 'gemini-flash');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.7);
  assert.deepEqual(body.messages, [{ role: 'user', content: '안녕' }]);
});

test('temperature 가 숫자가 아니면 보내지 않는다', () => {
  const body = buildRequestBody({ model: 'm', messages: [], temperature: Number.NaN });
  assert.equal(Object.hasOwn(body, 'temperature'), false);
});

test('오류 종류별로 한국어 안내를 돌려준다', () => {
  const network = describeError(new LlmError('연결 실패', { kind: 'network' }), {
    baseUrl: 'http://localhost:4000',
  });
  assert.ok(network.hint.includes('localhost:4000'));

  const auth = describeError(new LlmError('401', { kind: 'auth' }), {});
  assert.ok(auth.hint.includes('API 키'));

  const notFound = describeError(new LlmError('404', { kind: 'notfound' }), {
    baseUrl: 'http://localhost:4000',
    model: 'gemini-flash',
  });
  assert.ok(notFound.hint.includes('gemini-flash'));

  const aborted = describeError(new LlmError('취소', { kind: 'aborted' }), {});
  assert.equal(aborted.kind, 'aborted');
  assert.equal(aborted.hint, '');

  const plain = describeError(new Error('그냥 오류'), {});
  assert.equal(plain.title, '그냥 오류');
  assert.equal(plain.kind, 'unknown');
});
