'use strict';
/* expiries —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L3441] if (pathname === '/api/expiry-categories' && method === 'GET') */
    router.get('/api/expiry-categories', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
return ok(res, db.expiryCategories);
    }, { auth: 'user', order: 3441 });

    /* [L3442] if (pathname === '/api/expiry-categories' && method === 'POST') */
    router.post('/api/expiry-categories', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '分类名不能为空');
    const c = { id: newId(db), name: body.name, color: body.color || '#4CAF50' };
    db.expiryCategories.push(c); saveDb(); return ok(res, c, '创建成功');
    }, { auth: 'user', order: 3442 });

    /* [L3455] if (pathname === '/api/expiry-items/summary' && method === 'GET') */
    router.get('/api/expiry-items/summary', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, todayStr } = app;
    const today = todayStr();
    const days = it => Math.floor((new Date(it.expiryDate) - new Date(today)) / 86400000);
    const items = db.expiryItems;
    // 「保修临期」仅统计未过保且 30 天内（0-30）；已过保的保修不属「临期」，不计入
    const warrantyLeft = i => i.warrantyUntil ? Math.floor((new Date(i.warrantyUntil) - new Date(today)) / 86400000) : null;
    const warrantySoon = items.filter(i => { const l = warrantyLeft(i); return l !== null && l >= 0 && l <= 30; }).length;
    return ok(res, {
      total: items.length,
      expired: items.filter(i => days(i) < 0).length,
      critical: items.filter(i => days(i) >= 0 && days(i) <= 7).length,
      warning: items.filter(i => days(i) > 7 && days(i) <= 30).length,
      normal: items.filter(i => days(i) > 30).length,
      warrantySoon,
      members: new Set(items.map(i => i.memberId).filter(Boolean)).size
    });
    }, { auth: 'user', order: 3455 });

    /* [L3472] if (pathname === '/api/expiry-items' && method === 'GET') */
    router.get('/api/expiry-items', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    let list = db.expiryItems.slice();
    const categoryId = q.get('categoryId');
    const memberId = q.get('memberId');
    const keyword = (q.get('keyword') || '').trim();
    if (categoryId) list = list.filter(i => String(i.categoryId) === categoryId);
    if (memberId) list = list.filter(i => String(i.memberId) === memberId);
    if (keyword) list = list.filter(i => (i.name || '').includes(keyword) || (i.location || '').includes(keyword)
      || (i.serialNo || '').includes(keyword) || (i.remark || '').includes(keyword));
    list.sort((a, b) => (a.expiryDate || '').localeCompare(b.expiryDate || ''));
    return ok(res, list);
    }, { auth: 'user', order: 3472 });

    /* [L3484] if (pathname === '/api/expiry-items' && method === 'POST') */
    router.post('/api/expiry-items', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { expiryItemFields, fail, newId, ok, readBody, saveDb, validDateStr } = app;
    const body = await readBody(req);
    if (!body.name || !body.expiryDate) return fail(res, '名称和到期日不能为空');
    if (!validDateStr(String(body.expiryDate))) return fail(res, '到期日格式不正确（需 YYYY-MM-DD 且为真实日期）');
    if (body.warrantyUntil !== undefined && body.warrantyUntil !== '' && !validDateStr(String(body.warrantyUntil))) return fail(res, '保修到期日格式不正确（需 YYYY-MM-DD 且为真实日期）');
    const it = Object.assign({ id: newId(db) }, expiryItemFields(body));
    db.expiryItems.push(it); saveDb(); return ok(res, it, '创建成功');
    }, { auth: 'user', order: 3484 });

    /* [L3509] if (pathname === '/api/expiry-items/overview' && method === 'GET') */
    router.get('/api/expiry-items/overview', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, todayStr } = app;
    const today = todayStr();
    const daysLeft = d => d ? Math.floor((new Date(d) - new Date(today)) / 86400000) : null;
    const byCategory = db.expiryCategories.map(c => ({
      id: c.id, name: c.name, color: c.color,
      count: db.expiryItems.filter(i => i.categoryId === c.id).length
    }));
    const byMember = db.familyMembers.map(fm => ({
      id: fm.id, name: fm.name,
      count: db.expiryItems.filter(i => i.memberId === fm.id).length
    })).filter(x => x.count > 0);
    const soon = db.expiryItems
      .map(i => ({ id: i.id, name: i.name, location: i.location || '', expiryDate: i.expiryDate, warrantyUntil: i.warrantyUntil || '', left: daysLeft(i.expiryDate), wLeft: daysLeft(i.warrantyUntil) }))
      .filter(i => i.left !== null && i.left <= 30)
      .sort((a, b) => a.left - b.left);
    return ok(res, { byCategory, byMember, soon, total: db.expiryItems.length });
    }, { auth: 'user', order: 3509 });

    /* [L3448] if ((m = pathname.match(/^\/api\/expiry-categories\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/expiry-categories\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { ok, saveDb } = app;
    const cid = +m[1];
    db.expiryCategories = db.expiryCategories.filter(c => c.id !== cid);
    // 归属该分类的档案一并置为「未分类」，避免留下悬空 categoryId（前端确认语即此语义）
    db.expiryItems.forEach(i => { if (i.categoryId === cid) i.categoryId = null; });
    saveDb(); return ok(res, null, '删除成功');
    }, { auth: 'user', order: 3448, method: 'DELETE' });

    /* [L3492] if ((m = pathname.match(/^\/api\/expiry-items\/(\d+)$/))) */
    router.match(/^\/api\/expiry-items\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { expiryItemFields, fail, ok, readBody, saveDb, validDateStr } = app;
    const it = db.expiryItems.find(x => x.id === +m[1]);
    if (!it) return fail(res, '物品不存在', 404);
    if (method === 'GET') return ok(res, it);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.expiryDate !== undefined && body.expiryDate !== '' && !validDateStr(String(body.expiryDate))) return fail(res, '到期日格式不正确（需 YYYY-MM-DD 且为真实日期）');
      if (body.warrantyUntil !== undefined && body.warrantyUntil !== '' && !validDateStr(String(body.warrantyUntil))) return fail(res, '保修到期日格式不正确（需 YYYY-MM-DD 且为真实日期）');
      Object.assign(it, expiryItemFields(body, it));
      saveDb(); return ok(res, it, '更新成功');
    }
    if (method === 'DELETE') {
      db.expiryItems = db.expiryItems.filter(x => x.id !== it.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 3492 });
};
