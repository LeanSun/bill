#!/usr/bin/env node
/**
 * 版本号自动判定
 *
 *   node tools/version.mjs            只看建议，不改文件
 *   node tools/version.mjs --apply    直接改 ASSET_V / ?v= / sw.js BUILD
 *   node tools/version.mjs --minor    强制按批次进位（新板块、交互重写时用）
 *
 * 判定规则（与 README「版本号规则」一致）：
 *   批次 +1：新增文件 / 改动 ≥6 个代码文件 / 增删 ≥400 行
 *   修正 +1：其余情况（单点修复、文案、间距、清理）
 * 只统计代码类文件，README、截图、日志不算，避免「改文档就跳版本」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE_MINOR = args.includes('--minor');
const FORCE_PATCH = args.includes('--patch');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);

const appJs = read('assets/app.js');
const m = appJs.match(/var ASSET_V = '([\d.]+)'/);
if (!m) {
  console.error('找不到 ASSET_V，先确认在轻账仓库根目录运行');
  process.exit(1);
}
const current = m[1];
const [MAJOR, MINOR, PATCH] = current.split('.').map(Number);

const CODE_EXT = /\.(js|css|html|json|md)$/;
const EXCLUDE = /^(README|CHANGELOG|VERSIONS)\.md$|^(tools|node_modules|\.git)\//;

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

const numstat = sh('git diff --numstat HEAD');
const untracked = sh('git ls-files --others --exclude-standard');

let files = 0;
let lines = 0;
const touched = [];
for (const row of numstat.split('\n').filter(Boolean)) {
  const [add, del, file] = row.split('\t');
  if (!CODE_EXT.test(file) || EXCLUDE.test(file)) continue;
  files += 1;
  lines += (Number(add) || 0) + (Number(del) || 0);
  touched.push(file);
}

const newFiles = untracked
  .split('\n')
  .filter(Boolean)
  .filter((f) => CODE_EXT.test(f) && !EXCLUDE.test(f));

const reasons = [];
if (newFiles.length) reasons.push('新增 ' + newFiles.length + ' 个文件（' + newFiles.slice(0, 3).join('、') + '）');
if (files >= 6) reasons.push('改了 ' + files + ' 个代码文件');
if (lines >= 400) reasons.push('增删 ' + lines + ' 行');

let minor = reasons.length > 0;
if (FORCE_MINOR) {
  minor = true;
  reasons.push('手工指定 --minor');
}
if (FORCE_PATCH) {
  minor = false;
  reasons.length = 0;
  reasons.push('手工指定 --patch');
}

if (!files && !newFiles.length) {
  console.log('当前没有代码改动，版本号保持 v' + current);
  process.exit(0);
}

const next = minor ? `${MAJOR}.${MINOR + 1}.0` : `${MAJOR}.${MINOR}.${PATCH + 1}`;
console.log('当前 v' + current + ' → 建议 v' + next + '（' + (minor ? '批次进位' : '修正 +1') + '）');
console.log('依据：' + (reasons.length ? reasons.join('；') : '只有版本号 / 文案级改动'));
console.log('涉及：' + (touched.slice(0, 8).join('、') || '—') + (touched.length > 8 ? ' 等' : ''));

if (!APPLY) {
  console.log('\n加 --apply 直接改号；如果这次是新板块 / 交互重写，加 --minor 强制批次进位。');
  process.exit(0);
}

const before = current;
let html = read('index.html');
html = html.split('?v=' + before).join('?v=' + next);
html = html.split('>v' + before + '<').join('>v' + next + '<');
write('index.html', html);

write('assets/app.js', appJs.replace(/var ASSET_V = '[\d.]+'/, `var ASSET_V = '${next}'`));

const sw = read('sw.js');
write('sw.js', sw.replace(/var BUILD = '[\d.]+'/, `var BUILD = '${next}'`));

const left = ['index.html', 'assets/app.js', 'sw.js']
  .map((f) => [f, read(f).split(before).length - 1])
  .filter(([, n]) => n > 0);
console.log('\n已写入 v' + next);
console.log(left.length ? '仍有旧号残留：' + JSON.stringify(left) : '三个文件已无旧号残留');
console.log('记得在 README 更新日志顶部补一条 ## v' + next + ' · 标题（日期）');
