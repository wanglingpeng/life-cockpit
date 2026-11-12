'use strict';
/* tasks —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2124] if (pathname === '/api/tasks' && method === 'GET') */
    router.get('/api/tasks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { isTodayTask, isUpcomingTask, ok, todayStr } = app;
    let list = db.tasks.slice();
    /* 小程序「今天 / 近期」页签：此前 tab 从未被识别，两个页签都返回全量待办——
       一个从上线起就没生效过的假页。口径直接复用 today.js 的唯一判定，
       保证页签清单与首页行动流逐条相同；显式 date/month/statusId 等过滤仍可叠加。 */
    const tab = q.get('tab');
    if (tab === 'today' || tab === 'upcoming') {
      const today = todayStr();
      list = list.filter(t => tab === 'today' ? isTodayTask(t, today) : isUpcomingTask(t, today));
    }
    const date = q.get('date');
    const month = q.get('month');
    const statusId = q.get('statusId');
    const pinned = q.get('pinned');
    const startDate = q.get('startDate');
    const endDate = q.get('endDate');
    if (date) list = list.filter(t => t.date === date);
    if (month) list = list.filter(t => (t.date || '').startsWith(month));
    if (startDate) list = list.filter(t => (t.date || '') >= startDate);
    if (endDate) list = list.filter(t => (t.date || '') <= endDate);
    if (statusId) list = list.filter(t => String(t.statusId) === statusId);
    if (pinned === '1' || pinned === 'true') list = list.filter(t => !!t.pinned);
    // 排序：置顶优先 → 日期时间 → id
    list.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      || (a.date + (a.remindTime || '')).localeCompare(b.date + (b.remindTime || ''))
      || a.id - b.id);
    // 分页（带 page 参数时返回 {list,total,page,size,hasMore}；兼容旧 pageSize）
    const page = q.get('page');
    if (page) {
      const p = Math.max(1, parseInt(page, 10) || 1);
      const sizeRaw = q.get('size') !== null ? q.get('size') : q.get('pageSize');
      const size = Math.max(1, parseInt(sizeRaw || '50', 10) || 50);
      const total = list.length;
      return ok(res, { list: list.slice((p - 1) * size, p * size), total, page: p, size, pageSize: size, hasMore: p * size < total });
    }
    return ok(res, list);
    }, { auth: 'user', order: 2124 });

    /* [L2153] if (pathname === '/api/tasks/calendar-month-data' && method === 'GET') */
    router.get('/api/tasks/calendar-month-data', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const year = parseInt(q.get('year') || String(new Date().getFullYear()), 10);
    const monthNum = parseInt(q.get('month') || String(new Date().getMonth() + 1), 10);
    const month = year + '-' + String(monthNum).padStart(2, '0');
    const dates = [];
    const statusCounts = {};
    const colors = {};
    db.tasks.filter(t => (t.date || '').startsWith(month)).forEach(t => {
      const d = t.date;
      if (!statusCounts[d]) {
        statusCounts[d] = {};
        colors[d] = [];
        dates.push(d);
      }
      const sid = t.statusId || 1;
      statusCounts[d][sid] = (statusCounts[d][sid] || 0) + 1;
      if (t.color) colors[d].push(t.color);
    });
    return ok(res, { dates, statusCounts, colors });
    }, { auth: 'user', order: 2153 });

    /* [L2231] if (pathname === '/api/tasks/statistics' && method === 'GET') */
    router.get('/api/tasks/statistics', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const start = q.get('startDate'), end = q.get('endDate');
    let list = db.tasks;
    if (start) list = list.filter(t => t.date >= start);
    if (end) list = list.filter(t => t.date <= end);
    return ok(res, {
      total: list.length,
      pending: list.filter(t => t.statusId === 1).length,
      progress: list.filter(t => t.statusId === 2).length,
      done: list.filter(t => t.statusId === 3).length,
      pinned: list.filter(t => t.pinned).length
    });
    }, { auth: 'user', order: 2231 });

    /* [L2244] if (pathname === '/api/tasks' && method === 'POST') */
    router.post('/api/tasks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, readBody, recordActivity, safeSlice, saveDb, toText, validDateStr } = app;
    const body = await readBody(req);
    if (!body.title || !body.date) return fail(res, '标题和日期不能为空');
    if (!validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
    const task = {
      id: newId(db), title: safeSlice(String(body.title), 80), date: body.date,
      remindTime: body.remindTime || '', statusId: body.statusId || 1,
      color: body.color || '', pinned: !!body.pinned, remark: body.remark || '',
      client: safeSlice(toText(body.client).trim(), 40),
      nextAction: safeSlice(toText(body.nextAction).trim(), 80),
      memberId: body.memberId ? +body.memberId : null,
      createdAt: nowStr()
    };
    db.tasks.push(task); saveDb();
    recordActivity('task.create', 1);
    if (body.source === 'quickadd') recordActivity('ai.quickadd', 1);
    saveDb();
    return ok(res, task, '创建成功');
    }, { auth: 'user', order: 2244 });

    /* [L2290] if (pathname === '/api/statuses' && method === 'GET') */
    router.get('/api/statuses', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, saveDb } = app;
    // 兼容旧数据：补齐 类型/排序/发送提醒/创建时间
    let migrated = false;
    db.statuses.forEach((s, i) => {
      if (s.builtin === undefined) { s.builtin = s.id <= 3; migrated = true; }
      if (s.sort === undefined) { s.sort = i + 1; migrated = true; }
      if (s.remind === undefined) { s.remind = s.id === 1; migrated = true; }
      if (!s.createdAt) { s.createdAt = '2026-09-22 00:15:27'; migrated = true; }
    });
    if (migrated) saveDb();
    return ok(res, db.statuses.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)));
    }, { auth: 'user', order: 2290 });

    /* [L2302] if (pathname === '/api/statuses' && method === 'POST') */
    router.post('/api/statuses', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '状态名称不能为空');
    const st = {
      id: newId(db), name: body.name, color: body.color || '#f59e0b',
      builtin: false, sort: db.statuses.length + 1,
      remind: !!body.remind, createdAt: nowStr()
    };
    db.statuses.push(st); saveDb();
    return ok(res, st, '创建成功');
    }, { auth: 'user', order: 2302 });

    /* [L2264] if ((m = pathname.match(/^\/api\/tasks\/(\d+)$/))) */
    router.match(/^\/api\/tasks\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb, toText, validDateStr } = app;
    const task = db.tasks.find(t => t.id === +m[1]);
    if (!task) return fail(res, '事务不存在', 404);
    if (method === 'GET') return ok(res, task);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.date !== undefined && !validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
      ['title', 'date', 'remindTime', 'statusId', 'color', 'pinned', 'remark'].forEach(k => {
        if (body[k] !== undefined) task[k] = body[k];
      });
      if (task.title !== undefined) task.title = safeSlice(String(task.title), 80);
      // v43：轻字段白名单 + 同样的 trim/截断（与 POST 保持一致，缺省回退空串）
      if (body.client !== undefined) task.client = safeSlice(toText(body.client).trim(), 40);
      if (body.nextAction !== undefined) task.nextAction = safeSlice(toText(body.nextAction).trim(), 80);
      // P1-1：事务可关联家人（与周期事项/纪念日一致，null = 全家人共用）
      if (body.memberId !== undefined) task.memberId = body.memberId ? +body.memberId : null;
      saveDb();
      return ok(res, task, '更新成功');
    }
    if (method === 'DELETE') {
      db.tasks = db.tasks.filter(t => t.id !== task.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2264 });

    /* [L2313] if ((m = pathname.match(/^\/api\/statuses\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/statuses\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, saveDb } = app;
    const sid = +m[1];
    const st = db.statuses.find(s => s.id === sid);
    if (st && st.builtin) return fail(res, '系统内置状态不可删除');
    if (db.tasks.some(t => t.statusId === sid)) return fail(res, '该状态下仍有事务，无法删除');
    db.statuses = db.statuses.filter(s => s.id !== sid);
    saveDb(); return ok(res, null, '删除成功');
    }, { auth: 'user', order: 2313, method: 'DELETE' });

    /* [L2321] if ((m = pathname.match(/^\/api\/statuses\/(\d+)$/)) && method === 'PUT') */
    router.match(/^\/api\/statuses\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb } = app;
    const st = db.statuses.find(s => s.id === +m[1]);
    if (!st) return fail(res, '状态不存在', 404);
    const body = await readBody(req);
    ['name', 'color', 'sort', 'remind'].forEach(k => { if (body[k] !== undefined) st[k] = body[k]; });
    saveDb(); return ok(res, st, '更新成功');
    }, { auth: 'user', order: 2321, method: 'PUT' });
};
