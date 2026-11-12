#!/usr/bin/env node
/**
 * bump-version.mjs — 版本号确定性传播（零依赖）
 *
 * 唯一权威源 = 项目根 package.json 的 version。
 * 其余位置（public/js/common.js 的 APP_VERSION、各页面 ?v= 缓存戳）
 * 由此脚本从该值确定性传播，避免「改了这边忘了那边」的版本漂移。
 *
 * 用法：
 *   node scripts/bump-version.mjs            # 把 common.js / HTML ?v= 同步到 package.json 当前值
 *   node scripts/bump-version.mjs 1.48.99    # 先改 package.json，再同步下游
 *
 * 注意：
 *   - 绝不触碰 data/ 目录（含历史备份 manifest 的 appVersion），只改交付源码。
 *   - 跳过文件名含 .bak 的暂存源。
 *   - public/sw.js 的 PWA_VERSION 是独立的缓存版本（与发版号解耦），本脚本不改它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const pkgPath = path.join(ROOT, 'package.json');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---- 1. 确定目标版本 ----
let target = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (target) {
  if (!/^\d+\.\d+\.\d+$/.test(target)) fail('版本格式应为 x.y.z，收到: ' + target);
  pkg.version = target;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('→ package.json version = ' + target);
} else {
  target = String(pkg.version);
  console.log('→ 目标版本（取自 package.json）= ' + target);
}

const oldAppVerRe = /(var\s+APP_VERSION\s*=\s*')([^']+)(')/;
const oldQueryRe = /\?v=([0-9]+\.[0-9]+\.[0-9]+)\b/g;

let changed = [];

// ---- 2. public/js/common.js 的 APP_VERSION ----
const commonPath = path.join(PUBLIC_DIR, 'js', 'common.js');
if (fs.existsSync(commonPath)) {
  let s = fs.readFileSync(commonPath, 'utf8');
  const m = s.match(oldAppVerRe);
  if (!m) fail('common.js 未找到 "var APP_VERSION = \'...\'" 声明');
  if (m[2] !== target) {
    s = s.replace(oldAppVerRe, '$1' + target + '$3');
    fs.writeFileSync(commonPath, s, 'utf8');
    changed.push('public/js/common.js  APP_VERSION ' + m[2] + ' → ' + target);
  } else {
    console.log('• public/js/common.js 已是 ' + target);
  }
}

// ---- 3. 各页面 ?v= 缓存戳（含子目录，排除 .bak） ----
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'data') continue;            // 不碰数据目录
    if (entry.name.includes('.bak')) continue;      // 跳过暂存源
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    let s = fs.readFileSync(full, 'utf8');
    let hit = false;
    s = s.replace(oldQueryRe, (whole, ver) => {
      if (ver === target) return whole;            // 已是最新，不动
      hit = true;
      return '?v=' + target;
    });
    if (hit) {
      fs.writeFileSync(full, s, 'utf8');
      const rel = path.relative(ROOT, full);
      changed.push(rel + '  ?v= → ' + target);
    }
  }
}
walk(PUBLIC_DIR);

// ---- 4. 自检：交付源码不应残留「仍未升级的旧 appVersion 字面值」 ----
// 排除项：
//   - data/（历史备份 manifest 的 appVersion，绝不改）
//   - .bak 暂存源
//   - HTML 注释 / JS 注释里的「v1.48.53 引入此块」类历史记录（属 provenance，保留）
// 真正该升级的是 ?v= 与 var APP_VERSION，上两步已处理；此处只拦「漏网之鱼」。
function stripComments(ext, s) {
  if (ext === '.html') {
    // HTML 注释 + <style> 里的 CSS 注释
    return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }
  // js / mjs / json：去 // 与 /* */
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const stray = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.name === 'data') continue;             // 绝不碰数据目录
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(full); continue; }
    if (entry.name.includes('.bak')) continue;
    if (full === path.join(ROOT, 'scripts', 'bump-version.mjs')) continue; // 工具自身会引用旧版本串
    const ext = path.extname(entry.name);
    if (!['.js', '.mjs', '.html', '.json'].includes(ext)) continue;
    const s = fs.readFileSync(full, 'utf8');
    const code = stripComments(ext, s);
    if (code.includes('1.48.53')) stray.push(path.relative(ROOT, full));
  }
})(ROOT);

console.log('\n变更文件数: ' + changed.length);
for (const c of changed) console.log('  ✓ ' + c);
if (stray.length) {
  console.error('\n⚠️ 仍残留字面 1.48.53（应手动确认是否历史记录）:');
  for (const f of stray) console.error('  - ' + f);
  process.exit(2);
}
console.log('\n✓ 版本传播完成，无残留旧字面值。');
