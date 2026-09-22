/** 설정 화면 동작. */

import { loadSettings, normalizeSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { DEFAULTS } from '../lib/defaults.js';
import { chat, describeError, listModels, normalizeBaseUrl, validateBaseUrl } from '../lib/llm.js';
import { isLocalHost } from '../lib/pages.js';

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
};

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

const panelModeInputs = () => Array.from(document.querySelectorAll('input[name="panelMode"]'));

/* ------------------------------------------------------------ 폼 <-> 값 */

function fillForm(settings) {
  fields.baseUrl.value = settings.baseUrl;
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  fields.systemPrompt.value = settings.systemPrompt;
  fields.temperature.value = String(settings.temperature);
  fields.maxTokens.value = String(settings.maxTokens);
  fields.timeoutSec.value = String(Math.round(settings.timeoutMs / 1000));
  fields.historyTurns.value = String(settings.historyTurns);
  fields.stream.checked = settings.stream;
  fields.contextMode.value = settings.contextMode;
  fields.maxContextChars.value = String(settings.maxContextChars);
  fields.sendPageUrl.checked = settings.sendPageUrl;
  for (const input of panelModeInputs()) input.checked = input.value === settings.panelMode;
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
    `${parsed.host} 는 암호화되지 않은 http 주소입니다.\n` +
      'API 키가 평문으로 전송되어 같은 네트워크에서 볼 수 있습니다.\n\n' +
      '그래도 저장할까요? (https 주소를 쓰는 것을 권합니다)',
  );
}

async function save() {
  const check = validateBaseUrl(fields.baseUrl.value);
  if (!check.ok) {
    showResult(`서버 주소를 확인하세요: ${check.reason}`, 'error');
    fields.baseUrl.focus();
    return;
  }
  if (!fields.model.value.trim()) {
    showResult('모델 이름을 입력하세요.', 'error');
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
      'API 키를 비워 두었습니다. 서버가 키를 요구하면 401 오류가 납니다(인증을 쓰지 않는 서버라면 괜찮습니다).',
      'busy',
    );
  }
  fillForm(settings);
  setSaveState('저장했습니다.', 'saved');
  setTimeout(() => setSaveState(''), 2500);
}

async function reset() {
  if (!window.confirm('모든 설정을 기본값으로 되돌릴까요?')) return;
  const settings = await resetSettings();
  fillForm(settings);
  setSaveState('기본값으로 되돌렸습니다.', 'saved');
}

async function fetchModels({ quiet = false } = {}) {
  const settings = readForm();
  ui.loadModels.disabled = true;
  if (!quiet) showResult('모델 목록을 불러오는 중…', 'busy');
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
          ? `사용할 수 있는 모델 ${ids.length}개: ${ids.slice(0, 12).join(', ')}${
              ids.length > 12 ? ' …' : ''
            }`
          : '서버가 모델 목록을 비어 있게 응답했습니다. LiteLLM config.yaml 을 확인하세요.',
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
    showResult(`서버 주소를 확인하세요: ${check.reason}`, 'error');
    return;
  }

  ui.test.disabled = true;
  showResult('연결을 확인하는 중…', 'busy');
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
        { role: 'system', content: '당신은 친절한 AI 어시스턴트입니다.' },
        { role: 'user', content: '안녕! 한 문장으로 인사해 줘.' },
      ],
    });

    const reply = (result.text || '').trim() || '(빈 응답)';
    const lines = [
      `✓ ${settings.model} 응답 확인`,
      `모델 응답: ${reply.slice(0, 200)}`,
      ids.length ? `서버에 등록된 모델 ${ids.length}개` : '모델 목록 조회는 지원되지 않습니다.',
    ];
    if (result.usage?.total_tokens) lines.push(`사용 토큰: ${result.usage.total_tokens}`);
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
    ui.toggleKey.textContent = shown ? '표시' : '숨기기';
  });

  ui.copyShortcut.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ui.shortcutUrl.textContent.trim());
      ui.copyShortcut.textContent = '복사됨';
      setTimeout(() => {
        ui.copyShortcut.textContent = '주소 복사';
      }, 1500);
    } catch {
      ui.copyShortcut.textContent = '복사 실패';
    }
  });

  for (const element of [...Object.values(fields), ...panelModeInputs()]) {
    element.addEventListener('input', () => setSaveState('저장하지 않은 변경이 있습니다.', 'dirty'));
    element.addEventListener('change', () => setSaveState('저장하지 않은 변경이 있습니다.', 'dirty'));
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
}

(async () => {
  fillForm(await loadSettings());
  wire();
  fetchModels({ quiet: true });
})();
