/** chrome.storage.local 에 저장된 설정을 읽고 쓰는 얇은 래퍼. */

import { DEFAULTS, LIMITS, SETTINGS_KEY, CONTEXT_MODES } from './defaults.js';

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

const toNumber = (value, fallback) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 저장된(또는 화면에서 입력된) 값을 안전한 범위로 정리합니다.
 * 손상된 값이 있어도 기본값으로 되돌려 항상 사용 가능한 설정을 돌려줍니다.
 */
export function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULTS, ...raw };

  const baseUrl = String(merged.baseUrl ?? '').trim() || DEFAULTS.baseUrl;
  const model = String(merged.model ?? '').trim() || DEFAULTS.model;

  return {
    baseUrl,
    apiKey: String(merged.apiKey ?? '').trim(),
    model,
    systemPrompt: String(merged.systemPrompt ?? DEFAULTS.systemPrompt),
    temperature: clamp(toNumber(merged.temperature, DEFAULTS.temperature), LIMITS.temperature),
    maxTokens: Math.round(clamp(toNumber(merged.maxTokens, DEFAULTS.maxTokens), LIMITS.maxTokens)),
    stream: Boolean(merged.stream),
    contextMode: Object.hasOwn(CONTEXT_MODES, merged.contextMode)
      ? merged.contextMode
      : DEFAULTS.contextMode,
    maxContextChars: Math.round(
      clamp(toNumber(merged.maxContextChars, DEFAULTS.maxContextChars), LIMITS.maxContextChars),
    ),
    historyTurns: Math.round(
      clamp(toNumber(merged.historyTurns, DEFAULTS.historyTurns), LIMITS.historyTurns),
    ),
    timeoutMs: Math.round(clamp(toNumber(merged.timeoutMs, DEFAULTS.timeoutMs), LIMITS.timeoutMs)),
    sendPageUrl: Boolean(merged.sendPageUrl),
    panelMode: merged.panelMode === 'inpage' ? 'inpage' : 'sidepanel',
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored?.[SETTINGS_KEY] ?? {});
}

/** 부분 업데이트. 저장된 값 전체를 정규화해서 다시 씁니다. */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings({}) });
  return normalizeSettings({});
}

/** 다른 화면에서 설정이 바뀌면 콜백으로 알려줍니다. 해제 함수를 돌려줍니다. */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    callback(normalizeSettings(changes[SETTINGS_KEY].newValue ?? {}));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
