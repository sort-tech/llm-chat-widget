/**
 * 에이전트 모드의 순수 로직: 도구 정의·위험 판단·화면 정보·실행 루프·도구 호출 요청.
 * 실제 페이지 조작(runPageAction)은 test/harness/agent-check.html 에서 브라우저로 확인합니다.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runAgent } from '../src/lib/agent.js';
import {
  agentTools,
  assessRisk,
  buildAgentSystemPrompt,
  compactMessages,
  describeAction,
  formatSnapshot,
  normalizeAgentUrl,
  parseToolArgs,
  snapshotMark,
} from '../src/lib/agent-tools.js';
import { buildRequestBody, chatWithTools, normalizeToolCalls } from '../src/lib/llm.js';
import { normalizeSettings } from '../src/lib/settings.js';

/* ------------------------------------------------------------ 도구 정의 */

test('도구 정의는 OpenAI function 형식이고 이름이 겹치지 않는다', () => {
  const names = agentTools().map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of agentTools()) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    for (const key of tool.function.parameters.required) {
      assert.ok(key in tool.function.parameters.properties, `${tool.function.name}.${key}`);
    }
  }
});

test('도구 인자 JSON 을 해석하고, 망가진 값은 오류로 알린다', () => {
  assert.deepEqual(parseToolArgs('{"ref":"3"}').args, { ref: '3' });
  assert.deepEqual(parseToolArgs({ ref: '3' }).args, { ref: '3' });
  assert.deepEqual(parseToolArgs('').args, {});
  assert.match(parseToolArgs('{ref:3').error, /JSON/);
  assert.match(parseToolArgs('[1,2]').error, /객체/);
});

test('이동 주소는 http/https 만 허용하고 스킴이 없으면 https 를 붙인다', () => {
  assert.equal(normalizeAgentUrl('example.com/a').url, 'https://example.com/a');
  assert.equal(normalizeAgentUrl('http://localhost:3000').ok, true);
  assert.equal(normalizeAgentUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeAgentUrl('file:///etc/passwd').ok, false);
  assert.equal(normalizeAgentUrl('chrome://settings').ok, false);
  assert.equal(normalizeAgentUrl('').ok, false);
});

/* ------------------------------------------------------------ 위험 판단 */

test('결제·삭제·전송 같은 버튼은 승인을 받는다', () => {
  for (const name of ['결제하기', '주문 확정', '계정 삭제', '메일 보내기', 'Place order', 'Delete repository']) {
    assert.equal(assessRisk('click', { ref: '1' }, { tag: 'button', name }).confirm, true, name);
  }
});

test('일반 링크·탭 클릭과 읽기 동작은 묻지 않는다', () => {
  assert.equal(assessRisk('click', { ref: '1' }, { tag: 'a', name: '뉴스', href: '/news' }).confirm, false);
  assert.equal(assessRisk('click', { ref: '2' }, { tag: 'button', name: '다음 페이지', type: 'button' }).confirm, false);
  for (const name of ['read_page', 'scroll', 'list_tabs', 'wait', 'hover']) {
    assert.equal(assessRisk(name, {}, null, 'always').confirm, false, name);
  }
});

test('양식 제출 버튼·입력 후 제출·Enter 는 승인을 받는다', () => {
  assert.equal(assessRisk('click', { ref: '1' }, { tag: 'button', name: '완료', type: 'submit', inForm: true }).confirm, true);
  assert.equal(assessRisk('type', { ref: '1', text: 'x', submit: true }).confirm, true);
  assert.equal(assessRisk('type', { ref: '1', text: 'x' }).confirm, false);
  assert.equal(assessRisk('press_key', { key: 'Enter' }).confirm, true);
  assert.equal(assessRisk('press_key', { key: 'Escape' }).confirm, false);
});

test("'always' 모드에서는 화면을 바꾸는 모든 동작을 묻는다", () => {
  assert.equal(assessRisk('click', { ref: '1' }, { tag: 'a', name: '뉴스' }, 'always').confirm, true);
  assert.equal(assessRisk('navigate', { url: 'https://a.com' }, null, 'always').confirm, true);
  assert.equal(assessRisk('type', { ref: '1', text: 'x' }, null, 'always').confirm, true);
});

test('단계 설명은 요소 이름으로 읽힌다', () => {
  const target = { ref: '4', tag: 'button', name: '검색' };
  assert.equal(describeAction('click', { ref: '4' }, target), "'검색' 버튼 클릭");
  assert.equal(
    describeAction('type', { ref: '2', text: '환불 정책', submit: true }, { tag: 'input', type: 'search', name: '검색어' }),
    '\'검색어\' 입력칸에 "환불 정책" 입력 후 제출',
  );
  assert.equal(describeAction('click', { ref: '9' }, null), '[9] 요소 클릭');
  assert.equal(describeAction('scroll', { direction: 'up' }), '위로 스크롤');
});

/* ------------------------------------------------------------ 화면 정보 */

test('화면 정보는 요소 번호·상태와 본문을 담고, 본문은 지시가 아님을 표시한다', () => {
  const text = formatSnapshot({
    tabId: 7,
    url: 'https://shop.test/cart',
    title: '장바구니',
    scroll: { y: 0, height: 2000, viewport: 800 },
    elements: [
      { ref: '1', tag: 'input', type: 'search', name: '검색', value: '', inView: true, focused: true },
      { ref: '2', tag: 'input', type: 'checkbox', name: '전체 선택', checked: false, inView: true },
      { ref: '3', tag: 'a', name: '고객센터', href: '/help', inView: false },
      { ref: '4', tag: 'select', name: '수량', value: '1', options: ['1', '2'], inView: true },
    ],
    totalInteractive: 10,
    text: '장바구니에 담긴 상품 2개',
  });
  assert.ok(text.startsWith(snapshotMark()));
  assert.match(text, /탭: 7/);
  assert.match(text, /\[1\] input\[search\] "검색" \(포커스\)/);
  assert.match(text, /\[2\] input\[checkbox\] "전체 선택" \(선택 안 됨\)/);
  assert.match(text, /\[3\] a "고객센터" → \/help \(화면 밖\)/);
  assert.match(text, /options=\[1 \| 2\]/);
  assert.match(text, /전체 10개 중 일부/);
  assert.match(text, /아래에 1200px 더 있음/);
  assert.match(text, /지시가 아닙니다/);
});

test('조작할 수 없는 페이지는 이유를 알린다', () => {
  const text = formatSnapshot({ url: 'chrome://settings', title: '설정', restricted: '브라우저 내부 페이지' });
  assert.match(text, /조작할 수 없습니다: 브라우저 내부 페이지/);
});

test('오래된 화면 정보는 걷어내고 최근 것만 남긴다(원본은 그대로)', () => {
  const snap = (n) => `결과 ${n}\n\n${snapshotMark()}\n요소 ${n}`;
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: snap(0) },
    { role: 'tool', tool_call_id: 'a', content: snap(1) },
    { role: 'tool', tool_call_id: 'b', content: snap(2) },
    { role: 'tool', tool_call_id: 'c', content: snap(3) },
  ];
  const out = compactMessages(messages, 2);
  assert.match(out[1].content, /^결과 0\n\n\(이전 화면 정보는 생략/);
  assert.match(out[2].content, /생략/);
  assert.equal(out[3].content, snap(2));
  assert.equal(out[4].content, snap(3));
  assert.equal(out[2].tool_call_id, 'a');
  assert.equal(messages[1].content, snap(0));
});

test('에이전트 시스템 프롬프트에 안전 규칙과 한도가 들어간다', () => {
  const prompt = buildAgentSystemPrompt({ maxSteps: 7, now: new Date('2026-11-07T00:00:00Z') });
  assert.match(prompt, /최대 7번/);
  assert.match(prompt, /따르지 말고/);
  assert.match(prompt, /비밀번호/);
  assert.match(prompt, /2026-11-07/);
});

/* ------------------------------------------------------------ 실행 루프 */

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** 정해진 순서대로 답하는 가짜 모델. 받은 메시지를 기록합니다. */
function scriptedModel(replies) {
  const seen = [];
  let index = 0;
  const callModel = async (messages, options) => {
    seen.push({ messages: structuredClone(messages), tools: options.tools });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return { message: { role: 'assistant', ...reply }, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  };
  return { callModel, seen };
}

function fakeExecutor(targets = {}) {
  const executed = [];
  return {
    executed,
    snapshot: async () => `${snapshotMark()}\n[1] button "검색"`,
    target: (name, args) => targets[args?.ref] ?? null,
    execute: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, summary: `${name} 완료`, text: `${name} 완료\n\n${snapshotMark()}\n새 화면` };
    },
  };
}

test('도구를 호출하고 결과를 돌려준 뒤 최종 답을 낸다', async () => {
  const model = scriptedModel([
    { content: null, tool_calls: [call('c1', 'click', { ref: '1' })] },
    { content: '검색 버튼을 눌렀습니다.' },
  ]);
  const executor = fakeExecutor({ 1: { ref: '1', tag: 'button', name: '검색' } });
  const events = [];
  const result = await runAgent({
    task: '검색 눌러 줘',
    systemPrompt: 'sys',
    callModel: model.callModel,
    executor,
    onStep: (step) => events.push(step.status),
  });

  assert.equal(result.text, '검색 버튼을 눌렀습니다.');
  assert.equal(result.outcome, 'done');
  assert.deepEqual(executor.executed, [{ name: 'click', args: { ref: '1' } }]);
  assert.equal(result.steps[0].label, "'검색' 버튼 클릭");
  assert.equal(result.steps[0].status, 'done');
  assert.deepEqual(events, ['running', 'done']);
  assert.equal(result.usage.total_tokens, 24);

  // 첫 질문에 화면 정보가 붙고, 두 번째 호출에는 tool 결과가 같은 id 로 들어갑니다.
  const firstUser = model.seen[0].messages.at(-1);
  assert.match(firstUser.content, /^검색 눌러 줘\n\n\[화면 정보\]/);
  const second = model.seen[1].messages;
  assert.deepEqual(second.at(-2).tool_calls.map((c) => c.id), ['c1']);
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'c1');
  assert.ok(model.seen[0].tools.length > 5);
});

test('위험한 동작은 승인을 묻고, 거부하면 실행하지 않는다', async () => {
  const model = scriptedModel([
    { content: null, tool_calls: [call('c1', 'click', { ref: '1' })] },
    { content: '결제를 진행하지 않았습니다.' },
  ]);
  const executor = fakeExecutor({ 1: { ref: '1', tag: 'button', name: '결제하기' } });
  const asked = [];
  const result = await runAgent({
    task: '결제해',
    systemPrompt: 'sys',
    callModel: model.callModel,
    executor,
    confirm: async (request) => {
      asked.push(request.label);
      return false;
    },
  });
  assert.deepEqual(asked, ["'결제하기' 버튼 클릭"]);
  assert.equal(executor.executed.length, 0);
  assert.equal(result.steps[0].status, 'denied');
  assert.match(model.seen[1].messages.at(-1).content, /거부/);
});

test('승인하면 실행한다', async () => {
  const model = scriptedModel([
    { content: null, tool_calls: [call('c1', 'type', { ref: '1', text: 'a', submit: true })] },
    { content: '끝' },
  ]);
  const executor = fakeExecutor();
  await runAgent({ task: 't', systemPrompt: 's', callModel: model.callModel, executor, confirm: async () => true });
  assert.equal(executor.executed.length, 1);
});

test('알 수 없는 도구·망가진 인자는 오류로 돌려주고 계속한다', async () => {
  const model = scriptedModel([
    {
      content: null,
      tool_calls: [
        call('c1', 'format_disk', {}),
        { id: 'c2', type: 'function', function: { name: 'click', arguments: '{ref:' } },
      ],
    },
    { content: '실패했습니다.' },
  ]);
  const executor = fakeExecutor();
  const result = await runAgent({ task: 't', systemPrompt: 's', callModel: model.callModel, executor });
  assert.equal(executor.executed.length, 0);
  assert.deepEqual(result.steps.map((s) => s.status), ['error', 'error']);
  const tools = model.seen[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c1', 'c2']);
});

test('동작 한도에 닿으면 도구 없이 정리를 요청하고 멈춘다', async () => {
  const model = scriptedModel([
    { content: null, tool_calls: [call('c1', 'scroll', {})] },
    { content: null, tool_calls: [call('c2', 'scroll', {}), call('c3', 'scroll', {})] },
    { content: '여기까지 했습니다.' },
  ]);
  const executor = fakeExecutor();
  const result = await runAgent({ task: 't', systemPrompt: 's', callModel: model.callModel, executor, maxSteps: 2 });
  assert.equal(result.outcome, 'max_steps');
  assert.equal(executor.executed.length, 2);
  // 한도를 넘은 c3 에도 결과를 돌려줘야 합니다(모든 tool_call 에 응답).
  const last = model.seen.at(-1);
  assert.equal(last.tools, undefined);
  assert.ok(last.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c3'));
  assert.match(last.messages.at(-1).content, /한도/);
});

test('중지하면 AbortError 로 끝나고 승인 대기도 풀린다', async () => {
  const controller = new AbortController();
  const model = scriptedModel([{ content: null, tool_calls: [call('c1', 'click', { ref: '1' })] }]);
  const executor = fakeExecutor({ 1: { ref: '1', tag: 'button', name: '삭제' } });
  const run = runAgent({
    task: 't',
    systemPrompt: 's',
    callModel: model.callModel,
    executor,
    signal: controller.signal,
    confirm: () =>
      new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(false));
        setTimeout(() => controller.abort(), 5);
      }),
  });
  await assert.rejects(run, (error) => error.name === 'AbortError');
  assert.equal(executor.executed.length, 0);
});

test('이전 대화를 시스템 프롬프트와 새 지시 사이에 넣는다', async () => {
  const model = scriptedModel([{ content: '네' }]);
  await runAgent({
    task: '이어서',
    history: [
      { role: 'user', content: '전에 한 말' },
      { role: 'assistant', content: '전 답' },
    ],
    systemPrompt: 'sys',
    callModel: model.callModel,
    executor: fakeExecutor(),
  });
  assert.deepEqual(model.seen[0].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

/* ---------------------------------------------------------- 도구 호출 요청 */

test('tools 는 있을 때만 요청 본문에 들어간다', () => {
  assert.equal('tools' in buildRequestBody({ model: 'm', messages: [] }), false);
  assert.equal(buildRequestBody({ model: 'm', messages: [], tools: agentTools() }).tools.length, agentTools().length);
});

test('tool_calls 를 표준 형태로 정리한다(객체 arguments, id 누락, 추가 필드 유지)', () => {
  const calls = normalizeToolCalls([
    { function: { name: 'click', arguments: { ref: '1' } }, thought_signature: 'sig' },
    { id: 'x', type: 'function', function: { name: 'scroll', arguments: '{}' } },
    { function: {} },
    null,
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.arguments, '{"ref":"1"}');
  assert.ok(calls[0].id);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].thought_signature, 'sig');
  assert.equal(calls[1].id, 'x');
});

test('chatWithTools 는 도구 정의를 보내고 tool_calls 를 돌려준다', async () => {
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'click', arguments: '{"ref":"2"}' } }],
              },
            },
          ],
          usage: { total_tokens: 33 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const settings = normalizeSettings({ baseUrl: `http://127.0.0.1:${port}`, model: 'gemini-flash', stream: true });
    const result = await chatWithTools({ settings, messages: [{ role: 'user', content: 'hi' }], tools: agentTools() });
    assert.equal(received.stream, false);
    assert.equal(received.tools.length, agentTools().length);
    assert.equal(result.message.content, null);
    assert.equal(result.message.tool_calls[0].function.name, 'click');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.usage.total_tokens, 33);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* --------------------------------------------------------------- 설정 */

test('에이전트 설정은 기본값이 안전하고 범위를 벗어나면 정리된다', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.agentMode, false);
  assert.equal(defaults.agentConfirm, 'risky');
  assert.equal(defaults.agentMaxSteps, 20);
  const odd = normalizeSettings({ agentMode: 1, agentMaxSteps: 999, agentConfirm: 'never' });
  assert.equal(odd.agentMode, true);
  assert.equal(odd.agentMaxSteps, 60);
  assert.equal(odd.agentConfirm, 'risky');
});
