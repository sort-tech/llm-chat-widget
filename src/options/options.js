/** 설정 화면 동작. */

import { loadSettings, normalizeSettings, onSettingsChanged, resetSettings, saveSettings } from '../lib/settings.js';
import { DEFAULTS } from '../lib/defaults.js';
import { chat, describeError, listModels, normalizeBaseUrl, validateBaseUrl } from '../lib/llm.js';
import { isLocalHost } from '../lib/pages.js';
import { applyTheme } from '../lib/theme.js';
import { localizeDocument, resolveLanguage, setLanguage, t } from '../lib/i18n.js';
import { isDefaultSystemPrompt, resolveSystemPrompt } from '../lib/defaults.js';

const $ = (id) => document.getElementById(id);

const fields = {
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  systemPrompt: $('systemPrompt'),
  temperature: $('temperature'),
  maxTokens: $('maxTokens'),
  timeoutSec: $('timeoutSec'),
  historyTurns: $('historyTurns'),
  stream: $('stream'),
  contextMode: $('contextMode'),
  maxContextChars: $('maxContextChars'),
  sendPageUrl: $('sendPageUrl'),
  agentMaxSteps: $('agentMaxSteps'),
  agentConfirm: $('agentConfirm'),
  theme: $('theme'),
  language: $('language'),
};

/** 에이전트 모드 켜짐 여부는 패널에서만 바꿉니다. 저장할 때 덮어쓰지 않도록 기억해 둡니다. */
let agentModeOnLoad = DEFAULTS.agentMode;

const ui = {
  toggleKey: $('toggleKey'),
  loadModels: $('loadModels'),
  modelList: $('modelList'),
  test: $('testConnection'),
  testResult: $('testResult'),
  save: $('save'),
  reset: $('reset'),
  saveState: $('saveState'),
  copyShortcut: $('copyShortcut'),
  shortcutUrl: $('shortcutUrl'),
};

/** 설정 화면의 고정 문구를 언어에 맞춥니다. */
function applyLanguage(setting) {
  setLanguage(resolveLanguage(setting));
  localizeDocument(document);
}

const panelModeInputs = () => Array.from(document.querySelectorAll('input[name="panelMode"]'));

/* ------------------------------------------------------------ 폼 <-> 값 */

function fillForm(settings) {
  fields.baseUrl.value = settings.baseUrl;
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  // 고치지 않은 기본 프롬프트는 화면 언어의 기본값으로 보여 줍니다.
  fields.systemPrompt.value = resolveSystemPrompt(settings.systemPrompt);
  fields.temperature.value = String(settings.temperature);
  fields.maxTokens.value = String(settings.maxTokens);
  fields.timeoutSec.value = String(Math.round(settings.timeoutMs / 1000));
  fields.historyTurns.value = String(settings.historyTurns);
  fields.stream.checked = settings.stream;
  fields.contextMode.value = settings.contextMode;
  fields.maxContextChars.value = String(settings.maxContextChars);
  fields.sendPageUrl.checked = settings.sendPageUrl;
  for (const input of panelModeInputs()) input.checked = input.value === settings.panelMode;
  fields.agentMaxSteps.value = String(settings.agentMaxSteps);
  fields.agentConfirm.value = settings.agentConfirm;
  agentModeOnLoad = settings.agentMode;
  fields.theme.value = settings.theme;
  applyTheme(settings.theme);
  fields.language.value = settings.language;
}

function readForm() {
  return normalizeSettings({
    baseUrl: fields.baseUrl.value,
    apiKey: fields.apiKey.value,
    model: fields.model.value,
    systemPrompt: fields.systemPrompt.value,
    temperature: fields.temperature.value,
    maxTokens: fields.maxTokens.value,
    timeoutMs: Number(fields.timeoutSec.value) * 1000,
    historyTurns: fields.historyTurns.value,
    stream: fields.stream.checked,
    contextMode: fields.contextMode.value,
    maxContextChars: fields.maxContextChars.value,
    sendPageUrl: fields.sendPageUrl.checked,
    panelMode: panelModeInputs().find((input) => input.checked)?.value ?? DEFAULTS.panelMode,
    agentMode: agentModeOnLoad,
    agentMaxSteps: fields.agentMaxSteps.value,
    agentConfirm: fields.agentConfirm.value,
    theme: fields.theme.value,
    language: fields.language.value,
  });
}

const setSaveState = (text, kind = '') => {
  ui.saveState.textContent = text;
  ui.saveState.dataset.kind = kind;
};

const showResult = (text, kind) => {
  ui.testResult.hidden = false;
  ui.testResult.textContent = text;
  ui.testResult.dataset.kind = kind;
};

/* -------------------------------------------------------------- 동작 */

/**
 * 평문 http 로 외부 호스트에 API 키를 보내려는 경우 한 번 확인합니다.
 * (localhost 는 네트워크를 타지 않으므로 묻지 않습니다.)
 */
function confirmInsecureKey(baseUrl, apiKey) {
  if (!apiKey) return true;
  let parsed;
  try {
    parsed = new URL(normalizeBaseUrl(baseUrl));
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' || isLocalHost(parsed.hostname)) return true;
  return window.confirm(
    t('opt.insecure', { host: parsed.host }),
  );
}

async function save() {
  const check = validateBaseUrl(fields.baseUrl.value);
  if (!check.ok) {
    showResult(t('opt.checkUrl', { reason: check.reason }), 'error');
    fields.baseUrl.focus();
    return;
  }
  if (!fields.model.value.trim()) {
    showResult(t('opt.needModel'), 'error');
    fields.model.focus();
    return;
  }
  if (!confirmInsecureKey(fields.baseUrl.value, fields.apiKey.value.trim())) {
    fields.baseUrl.focus();
    return;
  }

  const settings = await saveSettings(readForm());
  if (!settings.apiKey) {
    showResult(
      t('opt.noKey'),
      'busy',
    );
  }
  fillForm(settings);
  setSaveState(t('opt.saved'), 'saved');
  setTimeout(() => setSaveState(''), 2500);
}

async function reset() {
  if (!window.confirm(t('opt.confirmReset'))) return;
  const settings = await resetSettings();
  fillForm(settings);
  setSaveState(t('opt.resetDone'), 'saved');
}

async function fetchModels({ quiet = false } = {}) {
  const settings = readForm();
  ui.loadModels.disabled = true;
  if (!quiet) showResult(t('opt.loadingModels'), 'busy');
  try {
    const ids = await listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
    ui.modelList.replaceChildren();
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = id;
      ui.modelList.append(option);
    }
    if (!quiet) {
      showResult(
        ids.length
          ? t('opt.modelsFound', {
              n: ids.length,
              list: `${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''}`,
            })
          : t('opt.modelsEmpty'),
        ids.length ? 'ok' : 'error',
      );
    }
    return ids;
  } catch (error) {
    const described = describeError(error, { baseUrl: settings.baseUrl });
    if (!quiet) showResult([described.title, described.hint].filter(Boolean).join('\n'), 'error');
    return [];
  } finally {
    ui.loadModels.disabled = false;
  }
}

async function testConnection() {
  const settings = readForm();
  const check = validateBaseUrl(settings.baseUrl);
  if (!check.ok) {
    showResult(t('opt.checkUrl', { reason: check.reason }), 'error');
    return;
  }

  ui.test.disabled = true;
  showResult(t('opt.testing'), 'busy');
  try {
    const ids = await fetchModels({ quiet: true });

    const probe = normalizeSettings({
      ...settings,
      stream: false,
      maxTokens: 64,
      timeoutMs: Math.min(settings.timeoutMs, 30000),
    });
    const result = await chat({
      settings: probe,
      messages: [
        { role: 'system', content: t('opt.testSystem') },
        { role: 'user', content: t('opt.testUser') },
      ],
    });

    const reply = (result.text || '').trim() || t('opt.emptyReply');
    const lines = [
      t('opt.replyOk', { model: settings.model }),
      t('opt.reply', { text: reply.slice(0, 200) }),
      ids.length ? t('opt.serverModels', { n: ids.length }) : t('opt.noModelList'),
    ];
    if (result.usage?.total_tokens) lines.push(t('opt.tokens', { n: result.usage.total_tokens }));
    showResult(lines.join('\n'), 'ok');
  } catch (error) {
    const described = describeError(error, { baseUrl: settings.baseUrl, model: settings.model });
    showResult([described.title, described.hint, described.detail].filter(Boolean).join('\n'), 'error');
  } finally {
    ui.test.disabled = false;
  }
}

/* ------------------------------------------------------------ 초기화 */

function wire() {
  ui.save.addEventListener('click', save);
  ui.reset.addEventListener('click', reset);
  ui.test.addEventListener('click', testConnection);
  ui.loadModels.addEventListener('click', () => fetchModels());

  ui.toggleKey.addEventListener('click', () => {
    const shown = fields.apiKey.type === 'text';
    fields.apiKey.type = shown ? 'password' : 'text';
    ui.toggleKey.textContent = t(shown ? 'opt.show' : 'opt.hide');
  });

  ui.copyShortcut.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ui.shortcutUrl.textContent.trim());
      ui.copyShortcut.textContent = t('opt.copied');
      setTimeout(() => {
        ui.copyShortcut.textContent = t('opt.copyUrl');
      }, 1500);
    } catch {
      ui.copyShortcut.textContent = t('opt.copyFailed');
    }
  });

  for (const element of [...Object.values(fields), ...panelModeInputs()]) {
    element.addEventListener('input', () => setSaveState(t('opt.dirty'), 'dirty'));
    element.addEventListener('change', () => setSaveState(t('opt.dirty'), 'dirty'));
  }

  // 언어는 고르는 즉시 이 화면에 반영합니다(저장은 다른 항목과 함께).
  fields.language.addEventListener('change', () => {
    const wasDefault = isDefaultSystemPrompt(fields.systemPrompt.value);
    applyLanguage(fields.language.value);
    if (wasDefault) fields.systemPrompt.value = t('prompt.system');
  });

  // 테마는 고르는 즉시 미리 보여 줍니다(저장은 다른 항목과 함께).
  fields.theme.addEventListener('change', () => applyTheme(fields.theme.value));
  // 패널의 해·달 버튼으로 바꾸면 이 화면도 따라가고, 저장할 때 덮어쓰지 않도록 값도 맞춥니다.
  onSettingsChanged((settings) => {
    if (settings.theme === fields.theme.value) return;
    fields.theme.value = settings.theme;
    applyTheme(settings.theme);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
}

(async () => {
  const settings = await loadSettings();
  applyLanguage(settings.language);
  fillForm(settings);
  wire();
  fetchModels({ quiet: true });
})();
