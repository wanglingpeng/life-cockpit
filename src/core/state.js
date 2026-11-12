'use strict';
/* 运行时可变状态。
 *
 * 为什么需要这个文件：路由体里有几个变量是**活绑定**——它们在 handler 内部被
 * 重新赋值，读和写必须看到同一个位置。JS 的解构 `const { x } = app` 是快照，
 * 对这类变量会在赋值时抛 TypeError（const）或读到旧值（let 快照）。
 *
 * 所以凡是被 handler 写入的跨请求状态，一律放这里，handler 通过 ctx.state
 * 访问。目前只有 vaultEncKey（保险库解锁密钥），后续阶段 2 的存储句柄也放这里。
 */

const state = {
  /* 保险库条目加密密钥：仅解锁后驻留内存，服务重启即清空，不落盘。 */
  vaultEncKey: null
};

module.exports = state;
