/**
 * OpenAI 호환(LiteLLM 프록시) 채팅 완성 클라이언트.
 *
 * 확장 프로그램 페이지(사이드 패널/옵션)는 host_permissions 에 있는 주소로
 * CORS 제약 없이 fetch 할 수 있으므로, 서비스 워커를 거치지 않고 직접 호출합니다.
 */

import { createEventStreamParser, readChunk } from './sse.js';

/* ------------------------------------------------------------------ URL */

/**
 * 사용자가 입력할 수 있는 여러 형태를 하나로 정리합니다.
 *   "localhost:4000"                        -> "http://localhost:4000"
 *   "http://localhost:4000/"                -> "http://localhost:4000"
 *   "http://localhost:4000/v1/"             -> "http://localhost:4000/v1"
 *   "http://localhost:4000/chat/completions"-> "http://localhost:4000"
 */
export function normalizeBaseUrl(raw) {
  let base = String(raw ?? '').trim();
  if (!base) return '';
  base = base.replace(/[?#].*$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/+$/, '');
  return base;
}

export function validateBaseUrl(raw) {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) return { ok: false, url: '', reason: '서버 주소가 비어 있습니다.' };
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, url: normalized, reason: '주소 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: normalized, reason: 'http 또는 https 주소만 사용할 수 있습니다.' };
  }
  return { ok: true, url: normalized, reason: '' };
}

export function apiUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

export const chatCompletionsUrl = (baseUrl) => apiUrl(baseUrl, 'chat/completions');
export const modelsUrl = (baseUrl) => apiUrl(baseUrl, 'models');

/* ---------------------------------------------------------------- 오류 */

export class LlmError extends Error {
  constructor(message, { kind = 'unknown', status = 0, detail = '', cause } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

const kindForStatus = (status) => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 408) return 'timeout';
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'server';
  return 'badrequest';
};

/** 스트림 중간에 들어온 error 프레임의 종류를 payload 에서 추정합니다. */
function errorFrameKind(payload) {
  const error = payload?.error;
  const status = Number(error?.status ?? error?.status_code ?? error?.code);
  if (Number.isFinite(status) && status >= 400) return kindForStatus(status);
  const type = String(error?.type ?? error?.code ?? '').toLowerCase();
  if (type.includes('rate') || type.includes('quota')) return 'ratelimit';
  if (type.includes('auth') || type.includes('permission')) return 'auth';
  if (type.includes('not_found') || type.includes('notfound')) return 'notfound';
  return 'badrequest';
}

/** 사용자에게 보여줄 제목 + 해결 힌트. */
export function describeError(error, { baseUrl = '', model = '' } = {}) {
  const host = (() => {
    try {
      return new URL(normalizeBaseUrl(baseUrl)).host;
    } catch {
      return baseUrl || '서버';
    }
  })();

  if (!(error instanceof LlmError)) {
    return {
      title: error?.message || '알 수 없는 오류가 발생했습니다.',
      hint: '',
      kind: 'unknown',
    };
  }

  const hints = {
    aborted: '',
    timeout: `${host} 응답이 제한 시간 안에 도착하지 않았습니다. 설정에서 제한 시간을 늘리거나 모델을 확인해 보세요.`,
    network: `${host} 에 연결할 수 없습니다. LiteLLM 서버가 실행 중인지, 주소와 포트가 맞는지 확인하세요. (예: litellm --config config.yaml --port 4000)`,
    auth: 'API 키가 거부되었습니다. 설정에서 키를 다시 확인하세요.',
    notfound: `엔드포인트 또는 모델을 찾을 수 없습니다. 서버 주소(${host})와 모델 이름(${model || '미지정'})이 LiteLLM 설정에 등록된 값인지 확인하세요.`,
    ratelimit: '요청이 너무 많거나 상위 모델의 쿼터를 초과했습니다. 잠시 후 다시 시도하세요.',
    server: '서버 내부 오류입니다. LiteLLM 로그를 확인하세요.',
    badrequest: '요청이 거부되었습니다. 모델 이름과 파라미터(temperature, max_tokens)를 확인하세요.',
    badresponse: '서버가 예상과 다른 형식으로 응답했습니다. 서버 주소가 OpenAI 호환 엔드포인트인지 확인하세요.',
    config: '',
  };

  return {
    title: error.message,
    hint: hints[error.kind] ?? '',
    kind: error.kind,
    detail: error.detail,
  };
}

/* ------------------------------------------------------- 요청 기본 동작 */

/**
 * 외부 취소 신호와 "무응답 제한 시간"을 합친 신호를 만듭니다.
 * touch() 를 부르면 제한 시간이 처음부터 다시 흘러가므로,
 * 스트리밍 중에는 데이터가 오는 동안 타임아웃이 발생하지 않습니다.
 */
function createDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let reason = null;
  let timer = null;

  const fire = () => {
    reason = 'timeout';
    controller.abort();
  };
  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, timeoutMs);
  };
  const onExternalAbort = () => {
    reason = 'aborted';
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  arm();

  return {
    signal: controller.signal,
    touch: arm,
    reason: () => reason,
    cleanup() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

const truncateDetail = (text, max = 600) =>
  typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text || '';

async function readErrorBody(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch (error) {
    // 본문을 읽는 중에 중지/타임아웃이 걸리면 그 사실을 감추지 않고 그대로 올립니다.
    if (error?.name === 'AbortError') throw error;
    return { message: '', detail: '' };
  }
  try {
    const json = JSON.parse(raw);
    const err = json?.error ?? json;
    const message =
      (typeof err === 'string' ? err : err?.message || err?.detail || err?.msg) ?? '';
    return {
      message: typeof message === 'string' ? message : JSON.stringify(message),
      detail: truncateDetail(raw),
    };
  } catch {
    return { message: truncateDetail(raw, 200), detail: truncateDetail(raw) };
  }
}

function abortToError(deadline, error) {
  if (deadline.reason() === 'timeout') {
    return new LlmError('요청 제한 시간을 초과했습니다.', { kind: 'timeout', cause: error });
  }
  return new LlmError('요청이 취소되었습니다.', { kind: 'aborted', cause: error });
}

async function apiFetch(url, { apiKey, body, method = 'POST', deadline, accept }) {
  const headers = { Accept: accept || 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline.signal,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw abortToError(deadline, error);
    throw new LlmError(`${new URL(url).host} 에 연결하지 못했습니다.`, {
      kind: 'network',
      detail: String(error?.message ?? error),
      cause: error,
    });
  }

  if (!response.ok) {
    let errorBody;
    try {
      errorBody = await readErrorBody(response);
    } catch (error) {
      if (error?.name === 'AbortError') throw abortToError(deadline, error);
      throw error;
    }
    const { message, detail } = errorBody;
    throw new LlmError(
      message ? `서버 오류 ${response.status}: ${message}` : `서버 오류 ${response.status}`,
      { kind: kindForStatus(response.status), status: response.status, detail },
    );
  }
  return response;
}

/* --------------------------------------------------------------- 요청 본문 */

export function buildRequestBody({ model, messages, temperature, maxTokens, stream }) {
  const body = { model, messages, stream: Boolean(stream) };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  return body;
}

/* --------------------------------------------------------------- 모델 목록 */

/** GET {base}/models. 실패하면 LlmError 를 던집니다. */
export async function listModels({ baseUrl, apiKey, signal, timeoutMs = 15000 }) {
  const check = validateBaseUrl(baseUrl);
  if (!check.ok) throw new LlmError(check.reason, { kind: 'config' });

  const deadline = createDeadline(signal, timeoutMs);
  try {
    const response = await apiFetch(modelsUrl(check.url), {
      apiKey,
      method: 'GET',
      deadline,
    });
    let json;
    try {
      json = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw abortToError(deadline, error);
      throw new LlmError('모델 목록 응답을 JSON 으로 해석할 수 없습니다.', {
        kind: 'badresponse',
        cause: error,
      });
    }
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const ids = list
      .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.model_name))
      .filter((id) => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } finally {
    deadline.cleanup();
  }
}

/* ------------------------------------------------------------------- 채팅 */

/**
 * 채팅 완성을 실행합니다. settings.stream 이 true 면 SSE 로 받아
 * onDelta(text) 를 조각마다 호출합니다.
 *
 * @returns {Promise<{text:string, usage:object|null, finishReason:string|null, streamed:boolean}>}
 */
export async function chat({ settings, messages, signal, onDelta }) {
  const check = validateBaseUrl(settings.baseUrl);
  if (!check.ok) throw new LlmError(check.reason, { kind: 'config' });
  if (!settings.model) throw new LlmError('모델 이름이 비어 있습니다.', { kind: 'config' });

  const body = buildRequestBody({
    model: settings.model,
    messages,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    stream: settings.stream,
  });

  const deadline = createDeadline(signal, settings.timeoutMs);
  try {
    const response = await apiFetch(chatCompletionsUrl(check.url), {
      apiKey: settings.apiKey,
      body,
      deadline,
      accept: settings.stream ? 'text/event-stream' : 'application/json',
    });

    const contentType = response.headers.get('content-type') ?? '';
    const isEventStream = contentType.includes('text/event-stream');

    // stream:true 로 요청했지만 서버가 통째로 JSON 을 준 경우도 처리합니다.
    if (!settings.stream || !isEventStream || !response.body) {
      const json = await response.json().catch((error) => {
        if (error?.name === 'AbortError') throw abortToError(deadline, error);
        throw new LlmError('응답을 JSON 으로 해석할 수 없습니다.', {
          kind: 'badresponse',
          cause: error,
        });
      });
      const parsed = readChunk(json);
      if (parsed.error) throw new LlmError(parsed.error, { kind: 'badrequest' });
      if (parsed.text && onDelta) onDelta(parsed.text);
      return {
        text: parsed.text,
        usage: parsed.usage,
        finishReason: parsed.finishReason,
        streamed: false,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createEventStreamParser();
    let text = '';
    let usage = null;
    let finishReason = null;

    // 반환값: { done, progressed }
    //  progressed 가 true 일 때만 무응답 타이머를 되살립니다. keep-alive 주석처럼
    //  내용 없는 바이트가 계속 와도 제한 시간이 무한히 늘어나지 않게 하기 위함입니다.
    const consume = (events) => {
      let done = false;
      let progressed = false;
      for (const event of events) {
        const data = event.data.trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          progressed = true;
          break;
        }

        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue; // 해석할 수 없는 조각은 건너뜁니다.
        }

        const parsed = readChunk(payload);
        if (parsed.error) {
          throw new LlmError(parsed.error, { kind: errorFrameKind(payload) });
        }
        if (parsed.usage) {
          usage = parsed.usage;
          progressed = true;
        }
        if (parsed.finishReason) {
          finishReason = parsed.finishReason;
          progressed = true;
        }
        if (parsed.text) {
          text += parsed.text;
          onDelta?.(parsed.text);
          progressed = true;
        }
      }
      return { done, progressed };
    };

    try {
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        const result = consume(parser.push(decoder.decode(value, { stream: true })));
        // 실제 내용이 온 경우에만 무응답 타이머를 처음부터 다시 셉니다.
        if (result.progressed) deadline.touch();
        if (result.done) done = true;
      }
      if (!done) {
        const tail = decoder.decode();
        if (tail) consume(parser.push(tail));
        consume(parser.flush());
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw abortToError(deadline, error);
      // consume() 이 던진 서버 오류(LlmError)는 그대로 유지합니다.
      if (error instanceof LlmError) throw error;
      throw new LlmError('응답을 받는 중 연결이 끊겼습니다.', {
        kind: 'network',
        detail: String(error?.message ?? error),
        cause: error,
      });
    } finally {
      reader.cancel().catch(() => {});
    }

    return { text, usage, finishReason, streamed: true };
  } finally {
    deadline.cleanup();
  }
}
