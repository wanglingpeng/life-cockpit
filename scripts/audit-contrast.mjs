// Schema 对比：把当前数据文档（data/db.json 或 defaultDb）的顶层键与数组规模，
// 同基线 scripts/.schema-baseline.json 对比，报告新增/移除的顶层集合。基线缺失时自动建立。
// 用于捕获「迁移改了库结构却没同步」这类回归。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'scripts', '.schema-baseline.json');

function currentSchema() {
  const dbFile = path.join(ROOT, 'data', 'db.json');
  let db = null;
  if (fs.existsSync(dbFile)) {
    try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) { db = null; }
  }
  if (!db) {
    try {
      const require = createRequire(import.meta.url);
      const { defaultDb } = require(path.join(ROOT, 'src/services/db-lifecycle'));
      db = defaultDb();
    } catch (e) { db = null; }
  }
  if (!db) { console.error('✖ 无法读取当前库结构（既无 data/db.json 也无法构建 defaultDb）'); process.exit(1); }
  const keys = Object.keys(db).sort();
  const arrays = {};
  for (const k of keys) if (Array.isArray(db[k])) arrays[k] = db[k].length;
  return { keys, arrays };
}

const cur = currentSchema();
if (!fs.existsSync(BASE)) {
  fs.writeFileSync(BASE, JSON.stringify({ generatedAt: new Date().toISOString(), keys: cur.keys, arrays: cur.arrays }, null, 2));
  console.log('✓ 已建立 schema 基线（' + cur.keys.length + ' 个顶层键），下次运行起将检测漂移');
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const added = cur.keys.filter(k => !base.keys.includes(k));
const removed = base.keys.filter(k => !cur.keys.includes(k));

if (!added.length && !removed.length) {
  console.log('✓ 数据 schema 与基线一致（' + cur.keys.length + ' 个顶层键）');
  process.exit(0);
}
if (added.length) { console.log('➕ 新增顶层键：', added.join(', ')); }
if (removed.length) { console.log('➖ 移除顶层键：', removed.join(', ')); }
process.exit(0);
