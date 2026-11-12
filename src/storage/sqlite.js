'use strict';
/* SQLite 后端（LC_STORAGE=sqlite 时启用）。
 *
 * 为什么用 node:sqlite：它是 **Node 标准库**，不是 npm 包。所以换 SQLite 不破坏
 * 「零运行时依赖、拷贝即运行」这个核心资产——这是这个项目能上 SQLite 的唯一前提。
 * （Node 22.5+ 起提供，22.x 会打印一条 ExperimentalWarning，功能可用。）
 *
 * 表结构刻意做得极简，只做两件事：
 *   meta        顶层非数组键（settings / modules / nextId / schemaVersion …）存整段 JSON
 *   collections 顶层数组键（tasks / notes / ledgerRecords …）一行一条，ord 保序
 *
 * 为什么不给每个业务集合建强类型表：schema 仍在演进（migrateDb 每次启动都在补字段），
 * 强类型表会让「加一个字段」变成一次 DDL 迁移。当前阶段的收益在**原子性、WAL、
 * 不再全量重写**，不在关系建模。等 schema 稳定、确有查询需求时再拆表。
 *
 * 相比 JSON 后端的实质改进：
 *   1. 只重写**变化了的**集合（内容 hash 比对），不再每次全量序列化整个库；
 *   2. 单事务提交，崩溃不会留下半份数据（不需要 tmp+rename 那套）；
 *   3. WAL 模式，读不阻塞写；
 *   4. 体积与内存不再随「历史流水条数」线性膨胀到每次写入。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { register } = require('./index');

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS collections (name TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, ord))',
  'CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
];

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

register('sqlite', function createSqliteStore(opts) {
  const file = opts.file;
  if (!file) throw new Error('sqlite 存储需要 file 参数');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error('当前 Node 不支持 node:sqlite（需要 22.5 及以上，22.x 需 --experimental-sqlite）。'
      + '当前版本 ' + process.version + '。可继续使用默认的 JSON 后端（去掉 --sqlite / LC_STORAGE 即可）。');
  }
  const db = new DatabaseSync(file);
  for (const sql of SCHEMA) db.exec(sql);

  const qMetaAll = db.prepare('SELECT key, value FROM meta');
  const qMetaPut = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const qMetaDel = db.prepare('DELETE FROM meta WHERE key = ?');
  const qCollAll = db.prepare('SELECT name, ord, data FROM collections ORDER BY name, ord');
  const qCollDel = db.prepare('DELETE FROM collections WHERE name = ?');
  const qCollPut = db.prepare('INSERT INTO collections (name, ord, data) VALUES (?, ?, ?)');
  const qOrderGet = db.prepare("SELECT value FROM storage_meta WHERE key = 'keyOrder'");
  const qOrderPut = db.prepare("INSERT INTO storage_meta (key, value) VALUES ('keyOrder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  /* 顶层键的类型表。必须显式记录：空数组在 collections 里一行都没有，
     光看表内容无法区分「这个集合是空数组」和「根本没有这个键」——
     前者必须还原成 []，后者必须不存在，否则会静默丢 25 个集合。 */
  const qKindsGet = db.prepare("SELECT value FROM storage_meta WHERE key = 'keyKinds'");
  const qKindsPut = db.prepare("INSERT INTO storage_meta (key, value) VALUES ('keyKinds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

  /* 上次写入的内容指纹：用于「只写变化了的集合」 */
  let savedHash = new Map();
  let savedKeyOrder = null;

  function txn(fn) {
    db.exec('BEGIN');
    try { fn(); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ } throw e; }
  }

  return {
    exists() { return fs.existsSync(file) && db.prepare('SELECT COUNT(*) AS n FROM meta').get().n > 0; },

    load() {
      const out = {};
      const meta = new Map();
      for (const row of qMetaAll.all()) meta.set(row.key, JSON.parse(row.value));

      const colls = new Map();
      for (const row of qCollAll.all()) {
        if (!colls.has(row.name)) colls.set(row.name, []);
        colls.get(row.name).push(JSON.parse(row.data));
      }

      /* 按上次记录的键序还原，保证 db 对象的键顺序稳定（下游 JSON.stringify 结果可比） */
      let order = null, kinds = null;
      try { const r = qOrderGet.get(); if (r) order = JSON.parse(r.value); } catch (e) { order = null; }
      try { const r = qKindsGet.get(); if (r) kinds = JSON.parse(r.value); } catch (e) { kinds = null; }
      const keys = Array.isArray(order) ? order.slice() : [];
      for (const k of meta.keys()) if (!keys.includes(k)) keys.push(k);
      for (const k of colls.keys()) if (!keys.includes(k)) keys.push(k);

      for (const k of keys) {
        const isArray = kinds ? kinds[k] === 'a' : colls.has(k);
        if (isArray) out[k] = colls.get(k) || [];      // 空集合还原成 []
        else if (meta.has(k)) out[k] = meta.get(k);
        /* kinds 说不是数组、meta 里也没有 → 该键已不存在，跳过 */
      }

      /* 建立指纹基线，避免首次 save 把没变的数据整份重写 */
      savedHash = new Map();
      for (const [k, v] of Object.entries(out)) savedHash.set(k, sha1(JSON.stringify(v)));
      savedKeyOrder = keys;
      return out;
    },

    save(doc) {
      const keys = Object.keys(doc);
      const nextHash = new Map();
      const changed = [];
      for (const k of keys) {
        const h = sha1(JSON.stringify(doc[k]));
        nextHash.set(k, h);
        if (savedHash.get(k) !== h) changed.push(k);
      }
      const removed = [...savedHash.keys()].filter(k => !keys.includes(k));
      const orderChanged = !savedKeyOrder || savedKeyOrder.join('\u0000') !== keys.join('\u0000');
      if (!changed.length && !removed.length && !orderChanged) return;

      txn(() => {
        for (const k of changed) {
          const v = doc[k];
          if (Array.isArray(v)) {
            qCollDel.run(k);
            for (let i = 0; i < v.length; i++) qCollPut.run(k, i, JSON.stringify(v[i]));
            qMetaDel.run(k);          // 同一键在 meta 里不应有残留
          } else {
            qMetaPut.run(k, JSON.stringify(v));
            qCollDel.run(k);
          }
        }
        for (const k of removed) { qMetaDel.run(k); qCollDel.run(k); }
        if (orderChanged) {
          qOrderPut.run(JSON.stringify(keys));
          const kinds = {};
          for (const k of keys) kinds[k] = Array.isArray(doc[k]) ? 'a' : 'm';
          qKindsPut.run(JSON.stringify(kinds));
        }
      });

      savedHash = nextHash;
      savedKeyOrder = keys;
    },

    /* WAL checkpoint：把 -wal 合并回主库，便于备份/拷贝。 */
    flush() { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ } },
    close() { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {} try { db.close(); } catch (e) {} },

    describe() {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      return { kind: 'sqlite', location: file, sizeBytes: size };
    },

    /* 给迁移脚本用：直接暴露底层句柄 */
    _raw: db
  };
});

module.exports = {};
