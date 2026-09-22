/**
 * 가짜 LiteLLM 서버를 실제로 띄워 chat()/listModels() 전체 경로를 확인합니다.
 * (fetch·AbortController·ReadableStream 은 Node 18+ 에 내장되어 있습니다.)
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { chat, listModels } from '../src/lib/llm.js';
import { normalizeSettings } from '../src/lib/settings.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 시나리오별 응답을 흉내내는 서버. */
function startServer(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const sseChunk = (text) =>
  `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text } }],
  })}\n\n`;

const settingsFor = (baseUrl, extra = {}) =>
  normalizeSettings({ baseUrl, apiKey: 'sk-test', model: 'gemini-flash', ...extra });

test('스트리밍 응답을 조각으로 받아 이어 붙인다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 일부러 프레임 중간에서 끊어서 보냅니다.
    const payload = sseChunk('안녕') + sseChunk('하세요') + sseChunk('!');
    res.write(payload.slice(0, 40));
    res.write(payload.slice(40));
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { total_tokens: 21 },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const deltas = [];
    const result = await chat({
      settings: settingsFor(server.baseUrl),
      messages: [{ role: 'user', content: '안녕' }],
      onDelta: (text) => deltas.push(text),
    });

    assert.equal(result.text, '안녕하세요!');
    assert.equal(result.streamed, true);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.total_tokens, 21);
    assert.deepEqual(deltas, ['안녕', '하세요', '!']);

    const request = server.seen.at(-1);
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-test');
    const sent = JSON.parse(request.body);
    assert.equal(sent.model, 'gemini-flash');
    assert.equal(sent.stream, true);
  } finally {
    await server.close();
  }
});

test('스트리밍이 아닌 응답도 같은 방식으로 돌려준다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '완성 응답' }, finish_reason: 'stop' }],
        usage: { total_tokens: 7 },
      }),
    );
  });
  try {
    const result = await chat({
      settings: settingsFor(server.baseUrl, { stream: false }),
      messages: [{ role: 'user', content: '안녕' }],
    });
    assert.equal(result.text, '완성 응답');
    assert.equal(result.streamed, false);
    assert.equal(JSON.parse(server.seen.at(-1).body).stream, false);
  } finally {
    await server.close();
  }
});

test('stream 을 요청했는데 서버가 통째로 JSON 을 주면 그대로 처리한다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '한 번에 왔다' } }] }));
  });
  try {
    const deltas = [];
    const result = await chat({
      settings: settingsFor(server.baseUrl),
      messages: [{ role: 'user', content: 'x' }],
      onDelta: (text) => deltas.push(text),
    });
    assert.equal(result.text, '한 번에 왔다');
    assert.equal(result.streamed, false);
    assert.deepEqual(deltas, ['한 번에 왔다']);
  } finally {
    await server.close();
  }
});

test('401 과 404 를 종류별 오류로 구분한다', async () => {
  for (const [status, kind] of [
    [401, 'auth'],
    [404, 'notfound'],
    [429, 'ratelimit'],
    [500, 'server'],
  ]) {
    const server = await startServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `테스트 ${status}` } }));
    });
    try {
      await assert.rejects(
        chat({ settings: settingsFor(server.baseUrl), messages: [{ role: 'user', content: 'x' }] }),
        (error) => {
          assert.equal(error.name, 'LlmError');
          assert.equal(error.kind, kind);
          assert.equal(error.status, status);
          assert.ok(error.message.includes(`테스트 ${status}`));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test('200 응답 안에 error 필드가 있으면 오류로 처리한다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: { message: '모델을 찾을 수 없음' } })}\n\n`);
    res.end();
  });
  try {
    await assert.rejects(
      chat({ settings: settingsFor(server.baseUrl), messages: [{ role: 'user', content: 'x' }] }),
      /모델을 찾을 수 없음/,
    );
  } finally {
    await server.close();
  }
});

test('중지하면 aborted 오류가 되고 그때까지 받은 조각은 콜백에 남는다', async () => {
  const server = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('첫'));
    await sleep(1000); // 중지될 때까지 열어 둡니다.
    res.end();
  });
  try {
    const deltas = [];
    const controller = new AbortController();
    const promise = chat({
      settings: settingsFor(server.baseUrl),
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
      onDelta: (text) => {
        deltas.push(text);
        controller.abort();
      },
    });
    await assert.rejects(promise, (error) => {
      assert.equal(error.kind, 'aborted');
      return true;
    });
    assert.deepEqual(deltas, ['첫']);
  } finally {
    await server.close();
  }
});

test('응답이 아예 오지 않으면 timeout 오류가 된다', async () => {
  const sockets = [];
  const server = await startServer((req, res) => {
    sockets.push(res); // 응답을 열어 둔 채로 아무것도 보내지 않습니다.
  });
  try {
    await assert.rejects(
      chat({
        // 테스트를 빠르게 하려고 정규화(최소 5초)를 거치지 않고 직접 넣습니다.
        settings: { ...settingsFor(server.baseUrl), timeoutMs: 300 },
        messages: [{ role: 'user', content: 'x' }],
      }),
      (error) => {
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );
  } finally {
    for (const res of sockets) res.destroy();
    await server.close();
  }
});

test('빈 본문의 200 응답은 badresponse 로 알려 준다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('');
  });
  try {
    await assert.rejects(
      chat({ settings: settingsFor(server.baseUrl), messages: [{ role: 'user', content: 'x' }] }),
      (error) => {
        assert.equal(error.kind, 'badresponse');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('조각이 계속 도착하는 동안에는 제한 시간이 늘어난다', async () => {
  // 제한 시간은 300ms 인데 총 전송 시간은 그보다 길다.
  // deadline.touch() 가 동작하지 않으면 중간에 timeout 으로 실패한다.
  const server = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 8; i += 1) {
      res.write(sseChunk(`${i}`));
      await sleep(120);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const result = await chat({
      settings: { ...settingsFor(server.baseUrl), timeoutMs: 300 },
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(result.text, '01234567');
  } finally {
    await server.close();
  }
});

test('listModels 는 모델 id 만 정렬해서 돌려준다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [{ id: 'gpt-4o' }, { id: 'gemini-flash' }, { id: 'gemini-flash' }, { nope: 1 }],
      }),
    );
  });
  try {
    const ids = await listModels({ baseUrl: server.baseUrl, apiKey: 'sk-test' });
    assert.deepEqual(ids, ['gemini-flash', 'gpt-4o']);
    assert.equal(server.seen.at(-1).url, '/models');
    assert.equal(server.seen.at(-1).method, 'GET');
  } finally {
    await server.close();
  }
});

test('서버가 꺼져 있으면 network 오류가 된다', async () => {
  const server = await startServer((req, res) => res.end());
  const { baseUrl } = server;
  await server.close();
  await assert.rejects(
    chat({ settings: settingsFor(baseUrl), messages: [{ role: 'user', content: 'x' }] }),
    (error) => {
      assert.equal(error.kind, 'network');
      return true;
    },
  );
});

test('내용 없는 keep-alive 주석만 오면 제한 시간이 늘어나지 않는다 (회귀)', async () => {
  const server = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 20; i += 1) {
      res.write(': keep-alive\n\n'); // 내용 없는 프레임
      await sleep(100);
    }
    res.end();
  });
  try {
    await assert.rejects(
      chat({
        settings: { ...settingsFor(server.baseUrl), timeoutMs: 400 },
        messages: [{ role: 'user', content: 'x' }],
      }),
      (error) => {
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('스트리밍 중 서버가 연결을 끊으면 network 오류로 알려 준다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sseChunk('시작'));
    res.socket.destroy(); // 프레임 중간에 소켓을 끊는다
  });
  try {
    const deltas = [];
    await assert.rejects(
      chat({
        settings: settingsFor(server.baseUrl),
        messages: [{ role: 'user', content: 'x' }],
        onDelta: (t) => deltas.push(t),
      }),
      (error) => {
        assert.equal(error.name, 'LlmError');
        assert.equal(error.kind, 'network');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('스트림 중간 error 프레임의 상태 코드로 오류 종류를 정한다', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: { message: '키 거부', code: 401 } })}\n\n`);
    res.end();
  });
  try {
    await assert.rejects(
      chat({ settings: settingsFor(server.baseUrl), messages: [{ role: 'user', content: 'x' }] }),
      (error) => {
        assert.equal(error.kind, 'auth');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('모델 목록이 JSON 이 아니면 빈 목록이 아니라 오류를 낸다 (회귀)', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('<html>login page</html>');
  });
  try {
    await assert.rejects(listModels({ baseUrl: server.baseUrl, apiKey: 'k' }), (error) => {
      assert.equal(error.kind, 'badresponse');
      return true;
    });
  } finally {
    await server.close();
  }
});
