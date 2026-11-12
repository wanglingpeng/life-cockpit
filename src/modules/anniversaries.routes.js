'use strict';
/* anniversaries —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2395] if (pathname === '/api/anniversaries' && method === 'GET') */
    router.get('/api/anniversaries', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { anniversaryLeft, ok } = app;
    return ok(res, db.anniversaries.slice().sort((a, b) => a.date.localeCompare(b.date)).map(a => Object.assign({}, a, { left: anniversaryLeft(a) })));
    }, { auth: 'user', order: 2395 });

    /* [L2398] if (pathname === '/api/anniversaries' && method === 'POST') */
    router.post('/api/anniversaries', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb, validDateStr } = app;
    const body = await readBody(req);
    if (!body.title || !body.date) return fail(res, '名称和日期不能为空');
    if (!validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
    const item = {
      id: newId(db), title: body.title, date: body.date,
      type: body.type || 'count-down', repeat: body.repeat || 'once',
      lunar: !!body.lunar,
      color: body.color || '', remark: body.remark || '',
      showHome: body.showHome !== false, notify: !!body.notify,
      memberId: body.memberId ? +body.memberId : null
    };
    db.anniversaries.push(item); saveDb();
    return ok(res, item, '创建成功');
    }, { auth: 'user', order: 2398 });

    /* [L2413] if ((m = pathname.match(/^\/api\/anniversaries\/(\d+)$/))) */
    router.match(/^\/api\/anniversaries\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb, validDateStr } = app;
    const item = db.anniversaries.find(a => a.id === +m[1]);
    if (!item) return fail(res, '纪念日不存在', 404);
    if (method === 'GET') return ok(res, item);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.date !== undefined && !validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
      ['title', 'date', 'type', 'repeat', 'color', 'remark', 'showHome', 'notify'].forEach(k => { if (body[k] !== undefined) item[k] = body[k]; });
      if (body.lunar !== undefined) item.lunar = !!body.lunar;
      if (body.memberId !== undefined) item.memberId = body.memberId ? +body.memberId : null;
      saveDb(); return ok(res, item, '更新成功');
    }
    if (method === 'DELETE') {
      db.anniversaries = db.anniversaries.filter(a => a.id !== item.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2413 });
};
