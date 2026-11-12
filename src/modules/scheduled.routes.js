'use strict';
/* scheduled —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2432] if (pathname === '/api/scheduled-tasks' && method === 'GET') */
    router.get('/api/scheduled-tasks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { decorateSchedule, ok } = app;
    const category = q.get('category');
    let list = db.scheduledTasks.slice();
    if (category) list = list.filter(t => (t.category || '其他') === category);
    list.sort((a, b) => a.id - b.id);
    return ok(res, list.map(decorateSchedule));
    }, { auth: 'user', order: 2432 });

    /* [L2439] if (pathname === '/api/scheduled-tasks/counts' && method === 'GET') */
    router.get('/api/scheduled-tasks/counts', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { decorateSchedule, ok } = app;
    const list = db.scheduledTasks.map(decorateSchedule);
    return ok(res, {
      total: list.length,
      enabled: list.filter(t => t.enabled).length,
      disabled: list.filter(t => !t.enabled).length,
      overdue: list.filter(t => t.enabled && t.state === 'overdue').length,
      dueToday: list.filter(t => t.enabled && t.state === 'due').length,
      dueSoon: list.filter(t => t.enabled && t.state === 'soon').length
    });
    }, { auth: 'user', order: 2439 });

    /* [L2451] if (pathname === '/api/scheduled-tasks/due' && method === 'GET') */
    router.get('/api/scheduled-tasks/due', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { decorateSchedule, ok } = app;
    const days = Math.max(1, +(q.get('days') || 7));
    const list = db.scheduledTasks.map(decorateSchedule)
      .filter(t => t.enabled && t.daysLeft !== null && t.daysLeft <= days)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return ok(res, list);
    }, { auth: 'user', order: 2451 });

    /* [L2458] if (pathname === '/api/scheduled-tasks' && method === 'POST') */
    router.post('/api/scheduled-tasks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { calcNextRun, decorateSchedule, fail, newId, nowStr, ok, readBody, saveDb, scheduledFields } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '任务名称不能为空');
    const item = Object.assign({ id: newId(db), lastRun: '', doneCount: 0, createdAt: nowStr() }, scheduledFields(body));
    item.nextRun = calcNextRun(item);
    db.scheduledTasks.push(item); saveDb();
    return ok(res, decorateSchedule(item), '创建成功');
    }, { auth: 'user', order: 2458 });

    /* [L2467] if ((m = pathname.match(/^\/api\/scheduled-tasks\/(\d+)\/done$/)) && method === 'POST') */
    router.match(/^\/api\/scheduled-tasks\/(\d+)\/done$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { calcNextRun, decorateSchedule, fail, nowStr, ok, readBody, saveDb, todayStr } = app;
    const item = db.scheduledTasks.find(t => t.id === +m[1]);
    if (!item) return fail(res, '定时任务不存在', 404);
    const body = await readBody(req);
    item.lastDoneAt = body.date || todayStr();
    item.lastRun = nowStr();
    item.doneCount = (+item.doneCount || 0) + 1;
    item.nextRun = calcNextRun(item);
    saveDb();
    return ok(res, decorateSchedule(item), '已完成，下次：' + item.nextRun.slice(0, 10));
    }, { auth: 'user', order: 2467, method: 'POST' });

    /* [L2479] if ((m = pathname.match(/^\/api\/scheduled-tasks\/(\d+)\/skip$/)) && method === 'POST') */
    router.match(/^\/api\/scheduled-tasks\/(\d+)\/skip$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { decorateSchedule, fail, nextRunDate, nowStr, ok, saveDb, todayStr, validDateStr } = app;
    const item = db.scheduledTasks.find(t => t.id === +m[1]);
    if (!item) return fail(res, '定时任务不存在', 404);
    const today = todayStr();
    const curNext = (item.nextRun && validDateStr(String(item.nextRun).slice(0, 10))) ? item.nextRun.slice(0, 10) : today;
    let nextDate;
    if (item.ruleType === 'interval' || item.ruleType === 'daily') {
      // 按上次完成顺延的规则：把「本次应办日」当作上次完成日推一个周期
      nextDate = nextRunDate(Object.assign({}, item, { lastDoneAt: curNext }));
    } else {
      // 固定规则（weekly/monthly/yearly）：以「本次应办日次日」为参考找下一个匹配日
      const d = new Date(curNext + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      nextDate = nextRunDate(item, todayStr(d));
    }
    item.nextRun = nextDate + ' ' + (item.remindTime || '09:00');
    item.lastRun = nowStr();
    saveDb();
    return ok(res, decorateSchedule(item), '已跳过一次，下次：' + nextDate);
    }, { auth: 'user', order: 2479, method: 'POST' });

    /* [L2499] if ((m = pathname.match(/^\/api\/scheduled-tasks\/(\d+)$/))) */
    router.match(/^\/api\/scheduled-tasks\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { calcNextRun, decorateSchedule, fail, ok, readBody, saveDb, scheduledFields } = app;
    const item = db.scheduledTasks.find(t => t.id === +m[1]);
    if (!item) return fail(res, '定时任务不存在', 404);
    if (method === 'GET') return ok(res, decorateSchedule(item));
    if (method === 'PUT') {
      const body = await readBody(req);
      Object.assign(item, scheduledFields(body, item));
      item.nextRun = calcNextRun(item);
      saveDb(); return ok(res, decorateSchedule(item), '更新成功');
    }
    if (method === 'DELETE') {
      db.scheduledTasks = db.scheduledTasks.filter(t => t.id !== item.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2499 });
};
