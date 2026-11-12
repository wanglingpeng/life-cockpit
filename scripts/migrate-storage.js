/* 存储迁移 CLI：在 JSON <-> SQLite 之间搬运整个库。
 * 用法：node scripts/migrate-storage.js --to=sqlite | --to=json
 * 复用 src/storage 的统一接口（load/save），不碰任何业务逻辑。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require(path.join(__dirname, '..', 'src', 'storage'));
const { DB_FILE } = require(path.join(__dirname, '..', 'src', 'core', 'paths'));
require(path.join(__dirname, '..', 'src', 'storage', 'json'));
require(path.join(__dirname, '..', 'src', 'storage', 'sqlite'));

const ROOT = path.resolve(__dirname, '..');
const arg = process.argv.find(a => a.startsWith('--to='));
const target = arg ? arg.slice(5) : '';
if (target !== 'sqlite' && target !== 'json') {
  console.error('用法: node scripts/migrate-storage.js --to=sqlite | --to=json');
  process.exit(2);
}
// 显式计算两类后端的文件路径（不依赖 STORAGE_KIND 环境变量，避免默认 json 下
// STORAGE_FILE 退化为 db.json 导致目标写错位置）。
const SQLITE_FILE = path.join(path.dirname(DB_FILE), 'db.sqlite');
// 源 = 另一侧后端；目标 = 指定后端
const srcFile = target === 'sqlite' ? DB_FILE : SQLITE_FILE;
const targetFile = target === 'sqlite' ? SQLITE_FILE : DB_FILE;

const src = createStore({ kind: target === 'sqlite' ? 'json' : 'sqlite', file: srcFile });
if (!src.exists()) { console.error('✖ 源存储不存在（' + srcFile + '），无法迁移（先启动一次服务以生成库）'); process.exit(1); }
const doc = src.load();
console.log('已读取源文档（' + srcFile + '）；顶层键:', Object.keys(doc).length);

const dst = createStore({ kind: target, file: targetFile });
dst.save(doc);
try { dst.flush(); } catch (e) {}
try { dst.close(); } catch (e) {}
try { src.close(); } catch (e) {}

console.log('✓ 已迁移至 ' + target + '：' + targetFile);
console.log('（如需切换默认后端，设置环境变量 LC_STORAGE=' + target + ' 或启动参数 --sqlite）');
process.exit(0);
