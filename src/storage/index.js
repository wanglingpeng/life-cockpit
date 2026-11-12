'use strict';
/* 存储接口（契约）。
 *
 * 为什么要有这一层：现在数据是一个内存大对象 + 全量 JSON 落盘。换存储不该改业务代码，
 * 所以把"怎么存"收敛成四个方法，业务侧只认这四个：
 *
 *   exists()        是否已有数据（决定首次启动建空库）
 *   load()          读出完整文档对象（失败时抛错，由调用方决定自愈策略）
 *   save(doc)       写入完整文档（同步；调用方负责防抖）
 *   flush()         把缓冲落盘（SQLite 下是 checkpoint；JSON 下无缓冲，空实现）
 *   close()         释放句柄（进程退出用）
 *   describe()      返回 { kind, location, sizeBytes } 供 /api/ping 与运维排查
 *
 * 关键约束：**load() 返回的对象必须是业务直接使用的那一个**。所有后端都要保证
 * 数组元素的 id 与顺序不变——顺序是业务语义的一部分（最近添加在前/后都有依赖）。
 */

const IMPLS = {};

function register(kind, factory) {
  IMPLS[kind] = factory;
}

function createStore(opts) {
  const kind = String((opts && opts.kind) || 'json').toLowerCase();
  const factory = IMPLS[kind];
  if (!factory) {
    throw new Error('未知的存储后端: ' + kind + '（可用: ' + Object.keys(IMPLS).join(', ') + '）');
  }
  const store = factory(opts || {});
  store.kind = kind;
  return store;
}

function available() {
  return Object.keys(IMPLS);
}

module.exports = { register, createStore, available };
