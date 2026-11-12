'use strict';
/* JSON 单文件后端（默认）。
 *
 * 与改造前完全一致：读整份 db.json 进内存，写时全量序列化 + 原子写。
 * 之所以保留为默认：它是现有用户的既成数据格式，零迁移成本；
 * SQLite 后端是可选项（LC_STORAGE=sqlite），不是强制升级。
 */

const fs = require('node:fs');
const { atomicWriteSync } = require('../core/atomic');
const { register } = require('./index');

register('json', function createJsonStore(opts) {
  const file = opts.file;
  if (!file) throw new Error('json 存储需要 file 参数');
  const mode = opts.mode === undefined ? 0o600 : opts.mode;

  return {
    exists() { return fs.existsSync(file); },

    /* 解析失败会抛错——调用方（loadDb）据此走自愈流程，绝不静默清库。 */
    load() {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    },

    save(doc) {
      atomicWriteSync(file, JSON.stringify(doc, null, 2), mode);
    },

    flush() { /* 同步写，无缓冲 */ },
    close() { /* 无句柄 */ },

    describe() {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      return { kind: 'json', location: file, sizeBytes: size };
    }
  };
});

module.exports = {};
