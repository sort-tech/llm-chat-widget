#!/usr/bin/env node
/**
 * 개발 검증용 로컬 서버.
 *
 *  - 프로젝트 파일을 그대로 서빙합니다(CORS 허용).
 *  - LiteLLM 의 /models, /chat/completions 를 흉내 내어
 *    확장 프로그램을 설치하지 않고도 test/harness 의 패널을 실제로 돌려 볼 수 있습니다.
 *
 * 실행: npm run dev        →  http://127.0.0.1:8731
 *   패널:   /test/harness/panel-harness.html
 *   설정:   /test/harness/options-harness.html
 *   페이지 내 패널: /test/harness/inpage-harness.html
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8731);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

/** 마크다운 요소와 근거 인용이 모두 들어간 가짜 답변. */
const ANSWER = `## 이 페이지 요약

이 문서는 **추출 테스트용 기사**입니다. 핵심은 다음과 같습니다.

1. 본문은 \`article.article-body\` 안에 있습니다.
2. 광고·사이드바·댓글은 제외됩니다.
3. 표와 코드 블록도 그대로 보존됩니다.

| 항목 | 값 |
| :--- | ---: |
| 단락 수 | 3 |
| 목록 항목 | 2 |

\`\`\`js
const result = extract(document);
console.log(result.charCount);
\`\`\`

> 인용문도 이렇게 표시됩니다.

근거는 "탭 1 본문입니다." 라는 문장과 "없는 문장 인용입니다" 입니다.

자세한 내용은 [문서 링크](https://example.com/docs) 를 보세요. 그리고 https://example.com/plain 도 자동 링크가 됩니다.

- [x] 스트리밍 확인
- [ ] 남은 항목

XSS 시험: <script>alert(1)</script> 과 [나쁜링크](javascript:alert(1)) 는 그대로 글자로 보여야 합니다.`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url === '/models' || url === '/v1/models') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gemini-flash' }, { id: 'gpt-4o-mini' }] }));
    return;
  }

  if (url === '/chat/completions' || url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = (() => {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    })();
    console.log(
      `[fake-litellm] model=${parsed.model} stream=${parsed.stream} messages=${parsed.messages?.length} chars=${body.length}`,
    );

    if (!parsed.stream) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
          usage: { total_tokens: 321 },
        }),
      );
      return;
    }

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    for (const piece of ANSWER.match(/[\s\S]{1,17}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(18);
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { total_tokens: 321 },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const path = join(ROOT, normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!path.startsWith(ROOT) || statSync(path).isDirectory()) throw new Error('not a file');
    res.writeHead(200, {
      ...CORS,
      'Content-Type': TYPES[extname(path)] ?? 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, CORS);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
  console.log(`  패널 하네스: http://127.0.0.1:${PORT}/test/harness/panel-harness.html`);
});
