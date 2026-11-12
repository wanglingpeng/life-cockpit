'use strict';
/* misc —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L1315] if (pathname.startsWith('/api/external/')) */
    router.when(function (ctx) { const { pathname, method } = ctx; return pathname.startsWith('/api/external/'); }, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, readBody, safeSlice, saveDb } = app;
    if (!db.settings.externalEnabled) return fail(res, '外部系统未开启', 403);
    // 凭证只接受 Header，不再回退到 URL query（避免 appKey/appSecret 进访问日志/浏览器历史）
    const ak = req.headers['x-app-key'] || '';
    const as = req.headers['x-app-secret'] || '';
    if (!db.settings.appKey || ak !== db.settings.appKey || as !== db.settings.appSecret) {
      return fail(res, 'AppKey 或 AppSecret 错误', 401);
    }
    const tasksRoute = pathname.match(/^\/api\/external\/tasks(\/(\d+))?$/);
    if (!tasksRoute) return fail(res, '接口不存在: ' + pathname, 404);
    if (method === 'POST' && !tasksRoute[2]) {
      const body = await readBody(req);
      if (!body.title || !body.date) return fail(res, '标题和日期不能为空', 400);
      const task = {
        id: newId(db), title: safeSlice(String(body.title), 80), date: body.date,
        remindTime: body.remindTime || '', statusId: body.statusId || 1,
        color: body.color || '', pinned: !!body.pinned, remark: body.remark || '',
        createdAt: nowStr(), source: 'external'
      };
      db.tasks.push(task); saveDb();
      return ok(res, task, '创建成功');
    }
    if (method === 'GET' && !tasksRoute[2]) {
      let list = db.tasks.slice();
      const keyword = q.get('keyword');
      if (keyword) list = list.filter(t => (t.title || '').includes(keyword) || (t.remark || '').includes(keyword));
      list.sort((a, b) => (a.date + (a.remindTime || '')).localeCompare(b.date + (b.remindTime || '')));
      const page = Math.max(1, +(q.get('page') || 1)), size = Math.min(100, Math.max(1, +(q.get('size') || 20)));
      return ok(res, { list: list.slice((page - 1) * size, page * size), total: list.length, page, size });
    }
    const extTask = db.tasks.find(t => t.id === +tasksRoute[2]);
    if (!extTask) return fail(res, '事务不存在', 404);
    if (method === 'GET') return ok(res, extTask);
    if (method === 'PUT') {
      const body = await readBody(req);
      ['title', 'date', 'remindTime', 'statusId', 'color', 'pinned', 'remark'].forEach(k => { if (body[k] !== undefined) extTask[k] = body[k]; });
      if (extTask.title !== undefined) extTask.title = safeSlice(String(extTask.title), 80);
      saveDb(); return ok(res, extTask, '更新成功');
    }
    if (method === 'DELETE') {
      db.tasks = db.tasks.filter(t => t.id !== extTask.id); saveDb();
      return ok(res, null, '删除成功');
    }
    return fail(res, '不支持的方法', 405);
    }, { auth: 'public', order: 1315, note: '外部系统接口：不走会话，用 X-App-Key/X-App-Secret 头校验（server.js 内自带 401 闸门）' });
};
