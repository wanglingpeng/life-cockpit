'use strict';
/* gifts —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2516] if (pathname === '/api/gift-configs' && method === 'GET') */
    router.get('/api/gift-configs', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const type = q.get('type');
    let list = db.giftConfigs;
    if (type) list = list.filter(c => c.type === type);
    return ok(res, list);
    }, { auth: 'user', order: 2516 });

    /* [L2522] if (pathname === '/api/gift-configs' && method === 'POST') */
    router.post('/api/gift-configs', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    if (!body.label || !body.type) return fail(res, '参数不完整');
    const c = { id: newId(db), type: body.type, label: body.label };
    db.giftConfigs.push(c); saveDb(); return ok(res, c, '创建成功');
    }, { auth: 'user', order: 2522 });

    /* [L2540] if (pathname === '/api/gift-groups' && method === 'GET') */
    router.get('/api/gift-groups', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
return ok(res, db.giftGroups);
    }, { auth: 'user', order: 2540 });

    /* [L2541] if (pathname === '/api/gift-groups' && method === 'POST') */
    router.post('/api/gift-groups', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '分组名不能为空');
    const g = { id: newId(db), name: body.name };
    db.giftGroups.push(g); saveDb(); return ok(res, g, '创建成功');
    }, { auth: 'user', order: 2541 });

    /* [L2551] if (pathname === '/api/gift-persons' && method === 'GET') */
    router.get('/api/gift-persons', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
return ok(res, db.giftPersons);
    }, { auth: 'user', order: 2551 });

    /* [L2552] if (pathname === '/api/gift-persons' && method === 'POST') */
    router.post('/api/gift-persons', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb, validDateStr } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '姓名不能为空');
    if (body.birthday !== undefined && body.birthday !== '' && !validDateStr(String(body.birthday))) return fail(res, '生日格式不正确（需 YYYY-MM-DD）');
    const p = { id: newId(db), name: body.name, groupId: body.groupId || null, remark: body.remark || '', memberId: body.memberId ? +body.memberId : null, birthday: body.birthday || '' };
    db.giftPersons.push(p); saveDb(); return ok(res, p, '创建成功');
    }, { auth: 'user', order: 2552 });

    /* [L2578] if (pathname === '/api/gift-records' && method === 'GET') */
    router.get('/api/gift-records', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    let list = db.giftRecords.slice();
    const year = q.get('year'), personId = q.get('personId'), direction = q.get('direction');
    if (year) list = list.filter(r => r.date.startsWith(year));
    if (personId) list = list.filter(r => String(r.personId) === personId);
    if (direction) list = list.filter(r => r.direction === direction);
    list.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    return ok(res, list);
    }, { auth: 'user', order: 2578 });

    /* [L2587] if (pathname === '/api/gift-records/statistics' && method === 'GET') */
    router.get('/api/gift-records/statistics', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const year = q.get('year') || String(new Date().getFullYear());
    const list = db.giftRecords.filter(r => r.date.startsWith(year));
    const income = list.filter(r => r.direction === 'in').reduce((s, r) => s + (+r.amount || 0), 0);
    const outcome = list.filter(r => r.direction === 'out').reduce((s, r) => s + (+r.amount || 0), 0);
    const monthly = {};
    for (let i = 1; i <= 12; i++) monthly[String(i).padStart(2, '0')] = { income: 0, outcome: 0 };
    list.forEach(r => {
      const mm = r.date.slice(5, 7);
      monthly[mm][r.direction === 'in' ? 'income' : 'outcome'] += +r.amount || 0;
    });
    return ok(res, { year, income, outcome, net: income - outcome, count: list.length, monthly });
    }, { auth: 'user', order: 2587 });

    /* [L2600] if (pathname === '/api/gift-records' && method === 'POST') */
    router.post('/api/gift-records', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb, validAmount, validDateStr } = app;
    const body = await readBody(req);
    if (!body.personId || body.amount === undefined || body.amount === null || body.amount === '' || !body.date) return fail(res, '对象、金额、日期不能为空');
    if (!validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
    if (!validAmount(body.amount)) return fail(res, '金额必须是大于 0 的数字');
    if (!db.giftPersons.find(x => x.id === +body.personId)) return fail(res, '往来对象不存在', 400);
    const r = {
      id: newId(db), personId: +body.personId, relation: body.relation || '',
      eventType: body.eventType || '', direction: body.direction === 'out' ? 'out' : 'in',
      amount: +body.amount, date: body.date, remark: body.remark || '',
      memberId: body.memberId ? +body.memberId : (() => {
        const p = db.giftPersons.find(x => x.id === +body.personId);
        return p && p.memberId ? p.memberId : null;
      })()
    };
    db.giftRecords.push(r); saveDb(); return ok(res, r, '创建成功');
    }, { auth: 'user', order: 2600 });

    /* [L2635] if (pathname === '/api/gift-records/batch-delete' && method === 'POST') */
    router.post('/api/gift-records/batch-delete', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const ids = body.ids || [];
    db.giftRecords = db.giftRecords.filter(x => !ids.includes(x.id)); saveDb();
    return ok(res, null, '删除成功');
    }, { auth: 'user', order: 2635 });

    /* [L2528] if ((m = pathname.match(/^\/api\/gift-configs\/(\d+)$/))) */
    router.match(/^\/api\/gift-configs\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb } = app;
    const idx = db.giftConfigs.findIndex(c => c.id === +m[1]);
    if (idx < 0) return fail(res, '配置不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.label !== undefined) db.giftConfigs[idx].label = body.label;
      saveDb(); return ok(res, db.giftConfigs[idx], '更新成功');
    }
    if (method === 'DELETE') {
      db.giftConfigs.splice(idx, 1); saveDb(); return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2528 });

    /* [L2547] if ((m = pathname.match(/^\/api\/gift-groups\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/gift-groups\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { ok, saveDb } = app;
    db.giftGroups = db.giftGroups.filter(g => g.id !== +m[1]); saveDb();
    return ok(res, null, '删除成功');
    }, { auth: 'user', order: 2547, method: 'DELETE' });

    /* [L2559] if ((m = pathname.match(/^\/api\/gift-persons\/(\d+)$/))) */
    router.match(/^\/api\/gift-persons\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb, validDateStr } = app;
    const p = db.giftPersons.find(x => x.id === +m[1]);
    if (!p) return fail(res, '往来对象不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.birthday !== undefined && body.birthday !== '' && !validDateStr(String(body.birthday))) return fail(res, '生日格式不正确（需 YYYY-MM-DD）');
      ['name', 'groupId', 'remark', 'birthday'].forEach(k => { if (body[k] !== undefined) p[k] = body[k]; });
      if (body.memberId !== undefined) {
        p.memberId = body.memberId ? +body.memberId : null;
        // 同步该往来对象的历史记录归属，保持「家人视角」一致
        db.giftRecords.forEach(r => { if (r.personId === p.id) r.memberId = p.memberId; });
      }
      saveDb(); return ok(res, p, '更新成功');
    }
    if (method === 'DELETE') {
      db.giftPersons = db.giftPersons.filter(x => x.id !== p.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2559 });

    /* [L2617] if ((m = pathname.match(/^\/api\/gift-records\/(\d+)$/))) */
    router.match(/^\/api\/gift-records\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb, validAmount, validDateStr } = app;
    const r = db.giftRecords.find(x => x.id === +m[1]);
    if (!r) return fail(res, '记录不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.date !== undefined && !validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
      if (body.amount !== undefined && body.amount !== null && body.amount !== '' && !validAmount(body.amount)) return fail(res, '金额必须是大于 0 的数字');
      ['personId', 'relation', 'eventType', 'direction', 'amount', 'date', 'remark'].forEach(k => {
        if (body[k] !== undefined) r[k] = (k === 'amount' || k === 'personId') ? +body[k] : body[k];
      });
      if (body.memberId !== undefined) r.memberId = body.memberId ? +body.memberId : null;
      saveDb(); return ok(res, r, '更新成功');
    }
    if (method === 'DELETE') {
      db.giftRecords = db.giftRecords.filter(x => x.id !== r.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2617 });
};
