#!/usr/bin/env node
/**
 * 브라우저에 설치하기 전에 확장 프로그램 구조를 점검합니다.
 *
 *  - manifest.json 형식과 필수 키
 *  - manifest / HTML / import / executeScript 가 가리키는 파일이 실제로 있는지
 *  - 확장 프로그램 CSP 를 위반하는 인라인 스크립트·인라인 이벤트 핸들러
 *  - 주입용 스크립트가 ES 모듈 문법을 쓰고 있지 않은지
 *
 * 실행: npm run validate
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);
const exists = (path) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};
const rel = (path) => relative(ROOT, path) || '.';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

/* ------------------------------------------------------------- manifest */

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
} catch (error) {
  console.error(`✗ manifest.json 을 읽을 수 없습니다: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version 은 3 이어야 합니다.');
for (const key of ['name', 'version', 'description', 'icons', 'action']) {
  if (!manifest[key]) fail(`manifest.${key} 가 없습니다.`);
}
if (!manifest.side_panel?.default_path) fail('manifest.side_panel.default_path 가 없습니다.');
if (!manifest.permissions?.includes('sidePanel')) fail('permissions 에 sidePanel 이 필요합니다.');
if (!manifest.permissions?.includes('scripting')) fail('permissions 에 scripting 이 필요합니다.');
if (!manifest.permissions?.includes('storage')) fail('permissions 에 storage 이 필요합니다.');
if (!manifest.host_permissions?.length) fail('host_permissions 가 비어 있습니다.');
if (manifest.default_locale && !exists(join(ROOT, '_locales'))) {
  fail('default_locale 이 있는데 _locales 디렉터리가 없습니다(브라우저가 설치를 거부합니다).');
}
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
  fail(`manifest.version 형식이 올바르지 않습니다: ${manifest.version}`);
}

const manifestPaths = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
].filter(Boolean);

for (const path of manifestPaths) {
  if (!exists(join(ROOT, path))) fail(`manifest 가 가리키는 파일이 없습니다: ${path}`);
}

for (const group of manifest.web_accessible_resources ?? []) {
  for (const pattern of group.resources ?? []) {
    if (pattern.includes('*')) {
      const dir = pattern.slice(0, pattern.lastIndexOf('/'));
      if (dir && !exists(join(ROOT, dir))) {
        fail(`web_accessible_resources 의 경로가 없습니다: ${pattern}`);
      }
      continue;
    }
    if (!exists(join(ROOT, pattern))) {
      fail(`web_accessible_resources 의 파일이 없습니다: ${pattern}`);
    }
  }
}

const sidePanelPath = manifest.side_panel?.default_path;
const warExposed = (manifest.web_accessible_resources ?? []).some((group) =>
  (group.resources ?? []).includes(sidePanelPath),
);
if (!warExposed) {
  note(
    `side_panel 페이지(${sidePanelPath})가 web_accessible_resources 에 없습니다. "페이지 내 패널" 모드를 쓰려면 필요합니다.`,
  );
}

/* --------------------------------------------------------------- 소스 */

const files = walk(ROOT).filter(
  (file) => !rel(file).startsWith('test/') && !rel(file).startsWith('tools/'),
);

const jsFiles = files.filter((file) => file.endsWith('.js'));
const htmlFiles = files.filter((file) => file.endsWith('.html'));

// 주입용(=클래식) 스크립트는 import/export 를 쓸 수 없습니다.
const CLASSIC_SCRIPTS = [
  'src/content/extract.js',
  'src/content/panel-host.js',
  'src/content/probe.js',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^\n]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

// 구문 오류는 브라우저에서 "스크립트를 실행할 수 없음"으로만 보이므로 여기서 먼저 잡습니다.
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('    at '))
      .slice(0, 4)
      .join(' | ');
    fail(`${rel(file)}: 구문 오류 — ${detail}`);
  }
}

for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  const name = rel(file);

  if (CLASSIC_SCRIPTS.includes(name)) {
    if (/(?:^|\n)\s*(?:import|export)\s/.test(source)) {
      fail(`${name} 은 주입용 클래식 스크립트이므로 import/export 를 쓸 수 없습니다.`);
    }
  }

  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const target = match[1];
      if (!target.startsWith('.')) {
        fail(`${name}: 확장 프로그램에서는 상대 경로 import 만 쓸 수 있습니다 → ${target}`);
        continue;
      }
      if (!exists(resolve(dirname(file), target))) {
        fail(`${name}: import 대상이 없습니다 → ${target}`);
      }
    }
  }

  // chrome.scripting.executeScript({ files: [...] }) 대상 확인
  for (const match of source.matchAll(/files:\s*\[([^\]]*)\]/g)) {
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (!exists(join(ROOT, quoted[1]))) {
        fail(`${name}: executeScript 가 가리키는 파일이 없습니다 → ${quoted[1]}`);
      }
    }
  }

  if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source)) {
    fail(`${name}: eval/new Function 은 확장 프로그램 CSP 에서 차단됩니다.`);
  }
}

/* ------------------------------------- 주입되는 함수의 자기완결성 검사 */

/**
 * chrome.scripting.executeScript({ func }) 로 넘기는 함수는 문자열화되어
 * 페이지에서 실행됩니다. 모듈 최상단의 상수를 참조하면 주입된 뒤 ReferenceError 가 납니다.
 * (테스트로는 잡기 어렵고 실제 페이지에서만 터지므로 여기서 정적으로 확인합니다.)
 */
const INJECTED_FUNCTIONS = {
  'src/content/highlight.js': ['highlightQuotes', 'clearHighlights'],
  'src/content/insert.js': ['runInsert'],
};

/** 중괄호 짝을 세어 함수 본문을 잘라냅니다(문자열/주석은 대략적으로 건너뜁니다). */
function sliceFunctionBody(source, name) {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  if (!match) return null;
  const open = source.indexOf('{', match.index);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

for (const [name, functionNames] of Object.entries(INJECTED_FUNCTIONS)) {
  const full = join(ROOT, name);
  if (!exists(full)) {
    fail(`주입 함수 검사 대상 파일이 없습니다: ${name}`);
    continue;
  }
  const source = readFileSync(full, 'utf8');

  // 모듈 최상단(들여쓰기 없음)에 선언된 이름들 — 주입된 함수는 이것들을 볼 수 없습니다.
  const moduleNames = new Set();
  for (const match of source.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    moduleNames.add(match[1]);
  }
  for (const match of source.matchAll(/^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    moduleNames.add(match[1]);
  }

  for (const functionName of functionNames) {
    const body = sliceFunctionBody(source, functionName);
    if (body === null) {
      fail(`${name}: 주입 대상 함수 ${functionName} 을 찾을 수 없습니다.`);
      continue;
    }
    // 함수 안에서 다시 선언한 이름은 지역 변수이므로 제외합니다.
    const localNames = new Set();
    for (const match of body.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
      localNames.add(match[1]);
    }
    for (const outer of moduleNames) {
      if (outer === functionName || localNames.has(outer)) continue;
      const used = new RegExp(`(?<![.\\w$])${outer}(?![\\w$])`).test(body);
      if (used) {
        fail(
          `${name}: ${functionName}() 이 모듈 최상단의 ${outer} 를 참조합니다. ` +
            'executeScript({func}) 로 주입되면 ReferenceError 가 납니다 — 함수 안으로 옮기세요.',
        );
      }
    }
  }
}

for (const file of htmlFiles) {
  const source = readFileSync(file, 'utf8');
  const name = rel(file);

  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match;
    if (!/\bsrc\s*=/.test(attrs) && body.trim() !== '') {
      fail(`${name}: 인라인 <script> 는 확장 프로그램 CSP 에서 실행되지 않습니다.`);
    }
  }
  if (/<[^>]+\son[a-z]+\s*=\s*["']/i.test(source)) {
    fail(`${name}: 인라인 이벤트 핸들러(onclick= 등)는 CSP 에서 차단됩니다.`);
  }

  for (const match of source.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|data:|mailto:|#|chrome:|edge:)/i.test(target)) continue;
    if (!exists(resolve(dirname(file), target))) {
      fail(`${name}: 참조 파일이 없습니다 → ${target}`);
    }
  }

  // 모듈 스크립트는 type="module" 이어야 import 가 동작합니다.
  for (const match of source.matchAll(/<script\b([^>]*)\bsrc\s*=\s*"([^"]+)"([^>]*)>/gi)) {
    const attrs = `${match[1]} ${match[3]}`;
    const target = resolve(dirname(file), match[2]);
    if (!exists(target)) continue;
    const referenced = readFileSync(target, 'utf8');
    if (/(?:^|\n)\s*import\s/.test(referenced) && !/type\s*=\s*"module"/.test(attrs)) {
      fail(`${name}: ${match[2]} 는 import 를 쓰므로 <script type="module"> 이어야 합니다.`);
    }
  }
}

/* -------------------------------------------------------------- 결과 */

for (const message of notes) console.log(`• ${message}`);

if (problems.length > 0) {
  console.error(`\n✗ 문제 ${problems.length}건`);
  for (const message of problems) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `✓ 검사 통과 — 파일 ${files.length}개 (JS ${jsFiles.length}, HTML ${htmlFiles.length}), manifest v${manifest.manifest_version} ${manifest.version}`,
);
