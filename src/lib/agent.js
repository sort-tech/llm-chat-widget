/**
 * 에이전트 실행 루프: 모델 호출 → 도구 실행 → 결과 전달을 반복합니다.
 *
 * 브라우저에 의존하지 않도록 모델 호출(callModel)과 도구 실행(executor)을 주입받습니다.
 * 그래서 Node 테스트에서 가짜 모델·가짜 브라우저로 그대로 검증할 수 있습니다.
 *
 * executor 인터페이스:
 *   snapshot()                  → Promise<string>   현재 화면 정보(formatSnapshot 결과)
 *   target(name, args)          → object|null       ref 가 가리키는 요소 정보(위험 판단용)
 *   execute(name, args, signal) → Promise<{ok:boolean, text:string}>
 */

import {
  agentTools,
  assessRisk,
  compactMessages,
  describeAction,
  parseToolArgs,
  TOOL_NAMES,
} from './agent-tools.js';
import { t } from './i18n.js';

class AbortedError extends Error {
  constructor() {
    super(t('err.aborted'));
    this.name = 'AbortError';
    this.kind = 'aborted';
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new AbortedError();
};

/** 모델 응답의 tool_calls 를 다시 보낼 수 있는 형태로 정리합니다. */
function assistantMessage(message) {
  const out = { role: 'assistant', content: message?.content ?? null };
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls;
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.task           사용자의 지시
 * @param {Array}  [options.history]      이전 대화 [{role, content}]
 * @param {string} options.systemPrompt
 * @param {(messages:Array, {tools, signal}) => Promise<{message, usage}>} options.callModel
 * @param {object} options.executor
 * @param {(request:{label, reason, name, args}) => Promise<boolean>} [options.confirm]
 * @param {(step:object, steps:Array) => void} [options.onStep]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxSteps]
 * @param {'risky'|'always'} [options.confirmMode]
 * @returns {Promise<{text:string, steps:Array, outcome:'done'|'max_steps', usage:object}>}
 */
export async function runAgent({
  task,
  history = [],
  systemPrompt,
  callModel,
  executor,
  confirm = async () => false,
  onStep = () => {},
  signal,
  maxSteps = 20,
  confirmMode = 'risky',
}) {
  const steps = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    for (const key of Object.keys(usage)) usage[key] += Number(u[key]) || 0;
  };

  throwIfAborted(signal);
  // 첫 질문에 현재 화면을 함께 넣어 "일단 화면부터 읽기" 단계를 아낍니다.
  let first = '';
  try {
    first = await executor.snapshot();
  } catch (error) {
    first = t('loop.firstFailed', { error: String(error?.message ?? error) });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: `${task}\n\n${first}` },
  ];

  const emit = (step) => onStep(step, steps);

  for (let round = 0; ; round += 1) {
    throwIfAborted(signal);
    const used = steps.length;
    const exhausted = used >= maxSteps;

    if (exhausted) {
      // 도구 없이 한 번 더 불러 지금까지의 결과를 정리하게 합니다.
      messages.push({
        role: 'user',
        content: t('loop.limitReached'),
      });
    }

    const response = await callModel(compactMessages(messages), {
      tools: exhausted ? undefined : agentTools(),
      signal,
    });
    addUsage(response?.usage);
    const message = response?.message ?? {};
    const calls = exhausted ? [] : (message.tool_calls ?? []);

    if (calls.length === 0) {
      return {
        text: String(message.content ?? '').trim(),
        steps,
        outcome: exhausted ? 'max_steps' : 'done',
        usage,
      };
    }

    messages.push(assistantMessage(message));

    // 한 응답에 여러 도구 호출이 오면 순서대로 실행합니다. 모든 호출에 결과를
    // 돌려줘야 하므로(OpenAI 규칙), 한도를 넘는 호출에도 "실행 안 함"으로 답합니다.
    for (const call of calls) {
      const name = call?.function?.name ?? '';
      const callId = call?.id ?? `call_${round}_${steps.length}`;
      const reply = (content) => messages.push({ role: 'tool', tool_call_id: callId, content });

      if (steps.length >= maxSteps) {
        reply(t('loop.skipped'));
        continue;
      }
      throwIfAborted(signal);

      const { args, error: argError } = parseToolArgs(call?.function?.arguments);
      const target = executor.target?.(name, args) ?? null;
      const step = {
        id: callId,
        name,
        args,
        label: describeAction(name, args, target),
        status: 'running',
        result: '',
      };
      steps.push(step);

      if (!TOOL_NAMES.has(name)) {
        step.status = 'error';
        step.result = t('loop.unknownStep', { name });
        emit(step);
        reply(t('loop.unknownReply', { name }));
        continue;
      }
      if (argError) {
        step.status = 'error';
        step.result = argError;
        emit(step);
        reply(t('loop.error', { error: argError }));
        continue;
      }

      const risk = assessRisk(name, args, target, confirmMode);
      if (risk.confirm) {
        step.status = 'confirm';
        step.reason = risk.reason;
        emit(step);
        const allowed = await confirm({ label: step.label, reason: risk.reason, name, args, step });
        throwIfAborted(signal);
        if (!allowed) {
          step.status = 'denied';
          step.result = t('loop.deniedStep');
          emit(step);
          reply(t('loop.deniedReply'));
          continue;
        }
        step.status = 'running';
      }
      emit(step);

      let result;
      try {
        result = await executor.execute(name, args, signal);
      } catch (error) {
        if (signal?.aborted) throw new AbortedError();
        result = { ok: false, text: t('loop.error', { error: String(error?.message ?? error) }) };
      }
      step.status = result?.ok === false ? 'error' : 'done';
      step.result = String(result?.summary ?? '').trim() || firstLine(result?.text);
      emit(step);
      reply(String(result?.text ?? ''));
    }
  }
}

const firstLine = (text) => String(text ?? '').split('\n')[0].slice(0, 160);
