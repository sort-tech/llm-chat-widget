/**
 * 기본 설정값과 저장소 키.
 *
 * 기본값은 사용자가 제공한 LiteLLM 프록시 예제(http://localhost:4000, gemini-flash)에
 * 맞춰져 있습니다. 설정 화면에서 언제든 변경할 수 있습니다.
 */

import { allTranslations, t } from './i18n.js';

export const SETTINGS_KEY = 'settings';

/** 대화 기록은 브라우저를 닫으면 사라지는 session 저장소에 탭별로 보관합니다. */
export const conversationKey = (tabId) => `conversation:${tabId}`;

/** 컨텍스트 메뉴 등에서 패널에 넘길 "대기 중인 요청"을 담는 키. */
export const pendingKey = (tabId) => `pending:${tabId}`;

/**
 * 기본 시스템 프롬프트(한국어). 언어별 기본값은 defaultSystemPrompt(lang) 로 얻습니다.
 * 저장된 프롬프트가 어느 언어의 기본값과 같으면 "기본값" 으로 보고, 화면 언어의 기본값을 씁니다.
 */
export const DEFAULT_SYSTEM_PROMPT = t('prompt.system', undefined, 'ko');

export const defaultSystemPrompt = (lang) => t('prompt.system', undefined, lang);

/**
 * 어느 언어든 기본 프롬프트 그대로인지(= 사용자가 고치지 않았는지).
 * 빈 값은 "시스템 프롬프트를 보내지 않음" 이라는 사용자의 선택이므로 기본값으로 보지 않습니다.
 */
export function isDefaultSystemPrompt(stored) {
  const value = String(stored ?? '').trim();
  return Boolean(value) && allTranslations('prompt.system').some((text) => text.trim() === value);
}

/** 사용자가 고치지 않은 기본 프롬프트면 현재 언어의 기본값으로 바꿔 줍니다. */
export const resolveSystemPrompt = (stored) =>
  isDefaultSystemPrompt(stored) ? t('prompt.system') : String(stored);

export const DEFAULTS = Object.freeze({
  /** LiteLLM(또는 OpenAI 호환) 서버 주소. */
  baseUrl: 'http://localhost:4000',
  /**
   * 프록시에서 발급받은 키. 기본값은 비어 있고 설정 화면에서 직접 입력합니다.
   * (소스에 키를 넣으면 배포 패키지에 그대로 실려 나갑니다.)
   */
  apiKey: '',
  /** LiteLLM config.yaml 에 등록된 모델 이름. */
  model: 'gemini-flash',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.3,
  /** 0 이면 max_tokens 를 보내지 않고 서버 기본값을 사용합니다. */
  maxTokens: 0,
  /** 스트리밍(SSE) 응답 사용 여부. */
  stream: true,
  /** 'page' = 본문 전체, 'selection' = 선택 영역 우선, 'off' = 페이지 참조 안 함 */
  contextMode: 'page',
  /** 프롬프트에 넣을 본문 최대 글자 수. */
  maxContextChars: 12000,
  /** 모델에 함께 보낼 최근 대화 메시지 수(user+assistant 합계). */
  historyTurns: 12,
  /** 요청 제한 시간(ms). */
  timeoutMs: 120000,
  /** 페이지 URL/제목을 프롬프트에 포함할지 여부. */
  sendPageUrl: true,
  /** 'sidepanel' = 브라우저 사이드 패널, 'inpage' = 페이지 오른쪽에 떠 있는 패널 */
  panelMode: 'sidepanel',
  /** 에이전트 모드: 대답 대신 브라우저를 직접 조작해 지시를 수행합니다. */
  agentMode: false,
  /** 에이전트가 한 번의 지시에 쓸 수 있는 최대 동작 수. */
  agentMaxSteps: 20,
  /** 'risky' = 결제·삭제·제출처럼 되돌리기 어려운 동작만 승인, 'always' = 화면을 바꾸는 모든 동작 승인 */
  agentConfirm: 'risky',
  /** 'system' = 운영체제 설정 따름, 'light' / 'dark' = 상단 테마 버튼으로 고정 */
  theme: 'system',
  /** 'auto' = 브라우저 언어(한국어면 한국어, 그 밖에는 영어), 'ko' / 'en' = 고정 */
  language: 'auto',
});

export const THEMES = Object.freeze({ system: '시스템 설정', light: '라이트', dark: '다크' });

export const AGENT_CONFIRM_MODES = Object.freeze({
  risky: '위험한 동작만 묻기',
  always: '모든 동작마다 묻기',
});

export const CONTEXT_MODES = Object.freeze({
  page: '전체 페이지',
  selection: '선택 영역',
  off: '참조 안 함',
});

export const LIMITS = Object.freeze({
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 0, max: 200000 },
  maxContextChars: { min: 500, max: 200000 },
  historyTurns: { min: 0, max: 100 },
  timeoutMs: { min: 5000, max: 600000 },
  agentMaxSteps: { min: 3, max: 60 },
});
