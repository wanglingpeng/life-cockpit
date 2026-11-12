'use strict';
/* insights —— 埋点与使用洞察。
 *
 * 两条路由一个方向：POST /api/activity 是各页面批量上报的使用事件
 * （telemetryEnabled 关闭时静默 200、不写库），GET /api/insights/usage
 * 是管理员只读视图（buildUsageInsights）。写入与读取同文件，是因为
 * 「埋点什么、洞察读什么」必须一起改——拆开就会出现「前端在报一个
 * 洞察永远不看的动作」。
 *
 * 与 server.js 时代的关系：由 handleApi() 机械切出，路由体逐字保留，
 * [Lxxxx] 是原 if 链中的行号。每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {

    /* [L4955] if (pathname === '/api/activity' && method === 'POST') */
    router.post('/api/activity', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { ok, readBody, recordActivity, saveDb, telemetryEnabled } = app;
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const platform = (body.platform === 'mobile' || body.platform === 'tablet' || body.platform === 'desktop') ? body.platform : 'desktop';
    let recorded = 0;
    if (telemetryEnabled()) {
      for (const it of items) {
        const action = it && typeof it.action === 'string' ? it.action.trim() : '';
        if (!action) continue;                      // 空 action 过滤
        if (action.length > 80) continue;
        if (recordActivity(action, it.count, platform)) recorded++;
      }
      if (recorded > 0) saveDb();
    }
    /* 关闭时不写库，但仍返回 200 让前端静默通过 */
    return ok(res, { recorded, enabled: telemetryEnabled() }, '已记录 ' + recorded + ' 条');
    }, { auth: 'user', order: 4955 });

    /* [L4974] if (pathname === '/api/insights/usage' && method === 'GET') */
    router.get('/api/insights/usage', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { buildUsageInsights, fail, isAdmin, ok } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可查看使用洞察', 403);
    const days = parseInt(q.get('days'), 10) || 30;
    const data = buildUsageInsights(days);
    return ok(res, data);
    }, { auth: 'user', order: 4974, role: 'admin' });
};
