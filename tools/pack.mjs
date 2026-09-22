#!/usr/bin/env node
/**
 * 스토어 업로드용 zip 을 만듭니다(개발용 "압축해제된 확장 프로그램" 설치에는 필요 없습니다).
 * 실행: npm run zip  →  dist/page-chatbot-<version>.zip
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const outDir = join(ROOT, 'dist');
const outFile = join(outDir, `page-chatbot-${manifest.version}.zip`);

mkdirSync(outDir, { recursive: true });
rmSync(outFile, { force: true });

// 확장 프로그램 실행에 필요한 것만 담습니다.
const include = ['manifest.json', 'icons', 'src'];

execFileSync('zip', ['-r', '-q', outFile, ...include, '-x', '*.DS_Store'], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log(`✓ ${outFile}`);
