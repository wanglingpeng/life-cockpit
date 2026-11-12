'use strict';
/* 声明式路由表。
 *
 * 设计要点（为什么不是 Express 那种"路径模板 + 中间件栈"）：
 *
 * 1. **顺序即语义**。原实现是 handleApi() 里一条 198 分支的 if 链，
 *    "先匹配先返回"。任何重排都可能改变行为（例如 /api/tasks/:id 与
 *    /api/tasks/batch 谁先命中）。所以本路由是**有序列表 + 首个命中**，
 *    不按 method 或路径长度重排、不做最长前缀优先。
 *
 * 2. **三种注册形式，覆盖原 if 链的全部形态**：
 *    - route(method, '/api/tasks', h)      ← pathname === X && method === M
 *    - match(/^\/api\/tasks\/(\d+)$/, h)   ← (m = pathname.match(RE))
 *    - when(fn, h)                          ← 复合条件（|| / startsWith）
 *    第三种是逃生舱：条件原文照搬，保证语义绝对一致。
 *
 * 3. **鉴权是路由的属性，不是代码的位置**。每条路由必须声明 auth：
 *      'public' — 无需登录（小程序登录、存活探针、外部 API、ICS 订阅）
 *      'user'   — 需登录
 *      'admin'  — 需登录且 role === 'admin'
 *    `scripts/arch-auth.mjs` 会枚举 routes 数组，任何未声明 auth 的路由直接
 *    让 CI 失败。这是把「新增路由忘了定安全级别」从运行时隐患变成构建期错误。
 *    对比改造前：边界是 server.js 第 1433 行那行注释的位置，新路由粘错位置
 *    就静默公开，且没有任何机制能发现。
 */

function createRouter() {
  const routes = [];
  let seq = 0;
  let sorted = null;

  function add(spec, handler, opts) {
    if (typeof handler !== 'function') throw new TypeError('路由 handler 必须是函数');
    opts = opts || {};
    const auth = opts.auth;
    if (auth !== 'public' && auth !== 'user' && auth !== 'admin') {
      throw new Error('路由必须显式声明 auth（public/user/admin），收到: ' + String(auth)
        + '  ' + (spec.path || spec.re || 'predicate'));
    }
    routes.push({
      id: ++seq,
      /* order：原始 if 链中的行号。跨模块注册时用它恢复全局顺序，
         否则"模块 A 的路由 L100/L500 + 模块 B 的路由 L300"会变成 100,500,300。 */
      order: typeof opts.order === 'number' ? opts.order : seq,
      kind: spec.kind,
      /* 正则路由也可以限定方法：原来写作 `(m = pathname.match(RE)) && method === 'X'`，
         拆出来后方法约束必须保留，否则任何方法都会命中第一个正则。
         注意不能走 route()：那样会把 RegExp 当成精确路径去比字符串，永远不命中。 */
      method: spec.method ? M(spec.method) : (opts.method ? M(opts.method) : null),
      path: spec.path || null,
      re: spec.re || null,
      predicate: spec.predicate || null,
      handler: handler,
      auth: auth,
      /* role 是 auth 之上的**收窄**，不是替代：auth:'user' + role:'admin'
         读作「需登录，且必须是管理员」。不写成 auth:'admin' 是为了让
         auth 这一维保持「登录与否」的单一语义，两个维度正交，检查器好写。 */
      role: opts.role || null,
      /* adminFields：路由对**所有登录用户**开放，但返回内容因角色而异。
         单独一个标记是因为它和 role:'admin' 是完全相反的语义——前者是
         "管理员能看到更多字段"，后者是"非管理员根本进不来"。混为一谈会让
         arch:auth 要求它必须有 403 闸门，然后正确的路由被判违规。 */
      adminFields: opts.adminFields === true,
      note: opts.note || ''
    });
    sorted = null;
  }

  function ordered() {
    if (!sorted) sorted = routes.slice().sort((a, b) => (a.order - b.order) || (a.id - b.id));
    return sorted;
  }

  const M = m => m.toUpperCase();

  const api = {
    /* 精确路径 + 方法 */
    route(method, p, handler, opts) {
      add({ kind: 'exact', method: M(method), path: p }, handler, opts);
    },
    /* 正则（保留原 match 数组，ctx.m 与改造前的 m 完全一致） */
    match(re, handler, opts) {
      add({ kind: 'regex', re: re }, handler, opts);
    },
    /* 谓词逃生舱：条件原文照搬 */
    when(predicate, handler, opts) {
      add({ kind: 'predicate', predicate: predicate }, handler, opts);
    },

    get: (p, h, o) => api.route('GET', p, h, o),
    post: (p, h, o) => api.route('POST', p, h, o),
    put: (p, h, o) => api.route('PUT', p, h, o),
    del: (p, h, o) => api.route('DELETE', p, h, o),
    patch: (p, h, o) => api.route('PATCH', p, h, o),

    get routes() { return ordered(); },

    /* 返回命中的路由条目，或 null。不执行 handler。 */
    resolve(ctx) {
      const list = ordered();
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.kind === 'exact') {
          if (ctx.pathname === r.path && ctx.method === r.method) return r;
        } else if (r.kind === 'regex') {
          const m = ctx.pathname.match(r.re);
          if (m) {
            if (r.method && ctx.method !== r.method) continue;
            ctx.m = m;
            return r;
          }
        } else {
          if (r.predicate(ctx)) return r;
        }
      }
      return null;
    },

    async dispatch(ctx) {
      const r = api.resolve(ctx);
      if (!r) return false;
      await r.handler(ctx);
      return true;
    }
  };

  return api;
}

module.exports = { createRouter };
