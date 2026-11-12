'use strict';
/* 驾驶舱简报：GET /api/insights/daily-brief —— AI 组织的今日家庭提醒。
 * 数据全部来自 buildTodayPayload（与首页同口径），AI 不可用时降级为规则模板。 */
module.exports = function register(router, app) {
  router.get('/api/insights/daily-brief', async function (ctx) {
    const { res } = ctx;
    const { buildDailyBrief, fail, ok } = app;
    try {
      const data = await buildDailyBrief();
      return ok(res, data);
    } catch (e) {
      return fail(res, '简报生成失败：' + ((e && e.message) || e), 500);
    }
  }, { auth: 'user', order: 4976 });

  /* [P0②] 跨模块联动：临期项转入统一待办（POST /api/insights/convert-todo） */
  router.post('/api/insights/convert-todo', async function (ctx) {
    const { req, res } = ctx;
    const { convertExpiryToTodo, fail, ok, readBody } = app;
    const body = await readBody(req);
    const kind = String(body.kind || '').trim();
    const id = body.id == null ? '' : String(body.id);
    if (!kind || id === '') return fail(res, '缺少事项类型或编号');
    try {
      const r = convertExpiryToTodo(kind, id);
      if (r.dup) return fail(res, '该事项已转入待办', 409);
      return ok(res, r.task, '已转入统一待办');
    } catch (e) {
      return fail(res, '转入待办失败：' + ((e && e.message) || e), 400);
    }
  }, { auth: 'user', order: 4977 });
};
