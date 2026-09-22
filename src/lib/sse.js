/**
 * OpenAI 호환 스트리밍 응답(text/event-stream)을 위한 순수 파서.
 *
 * 네트워크 청크는 줄 중간에서도 끊기므로, 상태를 들고 있는 파서가 필요합니다.
 * 이 파일은 chrome API 를 쓰지 않아 Node 에서 단위 테스트할 수 있습니다.
 */

/**
 * @returns {{push:(chunk:string)=>Array<{event:string,data:string,id:string}>,
 *            flush:()=>Array<{event:string,data:string,id:string}>}}
 */
export function createEventStreamParser() {
  let buffer = '';
  let dataLines = [];
  let eventName = '';
  let lastId = '';
  let out = [];

  const handleLine = (line) => {
    if (line === '') {
      // 빈 줄 = 프레임 끝. data 가 하나도 없으면 하트비트로 보고 무시합니다.
      if (dataLines.length > 0) {
        out.push({ event: eventName || 'message', data: dataLines.join('\n'), id: lastId });
      }
      dataLines = [];
      eventName = '';
      return;
    }
    if (line.startsWith(':')) return; // 주석(keep-alive)

    const sep = line.indexOf(':');
    let field = line;
    let value = '';
    if (sep !== -1) {
      field = line.slice(0, sep);
      value = line.slice(sep + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    else if (field === 'id') lastId = value;
    // retry 등 나머지 필드는 이 클라이언트에서 쓰지 않습니다.
  };

  return {
    push(chunk) {
      out = [];
      if (!chunk) return out;
      buffer += chunk;

      // 버퍼가 '\r' 로 끝나면 다음 청크에서 '\n' 이 붙을 수 있으므로 판단을 보류합니다.
      let held = '';
      let searchable = buffer;
      if (searchable.endsWith('\r')) {
        held = '\r';
        searchable = searchable.slice(0, -1);
      }

      const parts = searchable.split(/\r\n|\n|\r/);
      buffer = parts.pop() + held;
      for (const line of parts) handleLine(line);
      return out;
    },

    /** 스트림이 끝났을 때 남은 버퍼를 마지막 프레임으로 처리합니다. */
    flush() {
      out = [];
      if (buffer) {
        const rest = buffer;
        buffer = '';
        for (const line of rest.split(/\r\n|\n|\r/)) handleLine(line);
      }
      handleLine('');
      return out;
    },
  };
}

/** 문자열/배열 형태가 섞여 오는 content 필드를 문자열로 정규화합니다. */
export function coerceContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text ?? part.content ?? '';
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * chat.completion.chunk 한 조각에서 필요한 정보만 뽑아냅니다.
 * 스트리밍이 아닌 응답 객체에도 그대로 쓸 수 있도록 message/delta 를 모두 봅니다.
 */
export function readChunk(payload) {
  const result = { text: '', reasoning: '', finishReason: null, usage: null, error: null };
  if (!payload || typeof payload !== 'object') return result;

  if (payload.error) {
    const err = payload.error;
    result.error = typeof err === 'string' ? err : err.message || JSON.stringify(err);
    return result;
  }

  if (payload.usage) result.usage = payload.usage;

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) return result;

  const source = choice.delta ?? choice.message ?? null;
  if (source) {
    result.text = coerceContent(source.content);
    if (typeof source.reasoning_content === 'string') result.reasoning = source.reasoning_content;
  } else if (typeof choice.text === 'string') {
    result.text = choice.text;
  }

  if (choice.finish_reason) result.finishReason = choice.finish_reason;
  return result;
}
