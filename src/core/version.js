/* ---------------- 版本号解析 ----------------
 *
 * 为什么单独一个文件：server.js 和 src/services/backup.js 都要用 APP_VERSION
 * （server.js 用于 /api/version 与启动漂移自检，backup.js 用于备份 manifest
 * 的 appVersion 字段）。放在 server.js 里，backup.js 就只得反向 require
 * server.js——那是循环依赖，而 arch:deps 会红。复制一份则会出现「改了这边
 * 忘了那边」的版本漂移，那种漂移不报错，只是备份 manifest 记错版本号。
 *
 * 版本号唯一权威源 = 项目根 package.json 的 version。
 * 其余位置（public/js/common.js 的 APP_VERSION、页面 ?v=、public/sw.js 的 PWA_VERSION）
 * 均由 node scripts/bump-version.mjs 从该值确定性传播；启动时会做漂移自检。
 *
 * 读取顺序回退：package.json → public/js/common.js 的 APP_VERSION → '0.0.0'。
 * 回退链是为「被复制到临时目录单独运行」的隔离验证场景保留的：
 * 本文件在 src/core/ 下，require('../../package.json') 随 require 链一起被
 * 复制，正常布局永远命中第一档；真被单独切出去时才逐级回退。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, PUBLIC_DIR } = require('./paths');

function resolveAppVersion() {
  try { const p = require('../../package.json'); if (p && p.version) return String(p.version); } catch (e) { /* 隔离副本可能无 package.json */ }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (p && p.version) return String(p.version);
  } catch (e) { /* 忽略 */ }
  try {
    const txt = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'common.js'), 'utf8');
    const m = txt.match(/var\s+APP_VERSION\s*=\s*'([^']+)'/);
    if (m) return m[1];
  } catch (e) { /* 忽略 */ }
  return '0.0.0';
}

const APP_VERSION = resolveAppVersion();

module.exports = { APP_VERSION, resolveAppVersion };
