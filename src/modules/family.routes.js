'use strict';
/* family —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2643] if (pathname === '/api/family' && method === 'GET') */
    router.get('/api/family', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { memberWithStats, ok } = app;
    return ok(res, db.familyMembers.slice().sort((a, b) => a.id - b.id).map(memberWithStats));
    }, { auth: 'user', order: 2643 });

    /* [L2646] if (pathname === '/api/family' && method === 'POST') */
    router.post('/api/family', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, familyFields, memberWithStats, newId, nowStr, ok, readBody, saveDb, validDateStr } = app;
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) return fail(res, '姓名不能为空');
    if (body.birthday !== undefined && body.birthday !== '' && !validDateStr(String(body.birthday))) return fail(res, '生日格式不正确（需 YYYY-MM-DD 且为真实日期）');
    const m = Object.assign({ id: newId(db), createdAt: nowStr() }, familyFields(body));
    db.familyMembers.push(m); saveDb();
    return ok(res, memberWithStats(m), '创建成功');
    }, { auth: 'user', order: 2646 });

    /* [L2735] if ((m = pathname.match(/^\/api\/family\/(\d+)\/summary$/)) && method === 'GET') */
    router.match(/^\/api\/family\/(\d+)\/summary$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { daysUntil, decorateSchedule, dueState, fail, memberWithStats, ok } = app;
    const fm = db.familyMembers.find(x => x.id === +m[1]);
    if (!fm) return fail(res, '家人不存在', 404);
    // 临期证件/保单数：效期项(到期日或保修日) + 保险库证件/保单，落在 leadDays 窗口内且非 ok
    const sdLead = +(db.settings.push && db.settings.push.leadDays) || 3;
    let expiringCount = 0;
    db.expiryItems.filter(i => i.memberId === fm.id).forEach(i => {
      [i.expiryDate, i.warrantyUntil].forEach(d => {
        const st = dueState(daysUntil(d), sdLead);
        if (st && st.state !== 'ok') expiringCount++;
      });
    });
    db.vaultEntries.filter(v => v.memberId === fm.id).forEach(v => {
      const st = dueState(daysUntil(v.expireDate), sdLead);
      if (st && st.state !== 'ok') expiringCount++;
    });
    return ok(res, {
      expiringCount,
      member: memberWithStats(fm),
      anniversaries: db.anniversaries.filter(a => a.memberId === fm.id),
      items: db.expiryItems.filter(i => i.memberId === fm.id),
      vaults: db.vaultEntries.filter(v => v.memberId === fm.id).map(v => ({ id: v.id, title: v.title, kind: v.kind, expireDate: v.expireDate })),
      gifts: db.giftRecords.filter(r => r.memberId === fm.id).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      schedules: db.scheduledTasks.filter(t => t.memberId === fm.id).map(decorateSchedule)
    });
    }, { auth: 'user', order: 2735, method: 'GET' });

    /* [L2761] if ((m = pathname.match(/^\/api\/family\/(\d+)$/))) */
    router.match(/^\/api\/family\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, familyFields, memberWithStats, ok, readBody, saveDb, validDateStr } = app;
    const fm = db.familyMembers.find(x => x.id === +m[1]);
    if (!fm) return fail(res, '家人不存在', 404);
    if (method === 'GET') return ok(res, memberWithStats(fm));
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.birthday !== undefined && body.birthday !== '' && !validDateStr(String(body.birthday))) return fail(res, '生日格式不正确（需 YYYY-MM-DD 且为真实日期）');
      Object.assign(fm, familyFields(body, fm));
      saveDb(); return ok(res, memberWithStats(fm), '更新成功');
    }
    if (method === 'DELETE') {
      // 解除关联，不删除其下的纪念日/档案/往来记录
      db.anniversaries.forEach(a => { if (a.memberId === fm.id) a.memberId = null; });
      db.expiryItems.forEach(i => { if (i.memberId === fm.id) i.memberId = null; });
      db.vaultEntries.forEach(v => { if (v.memberId === fm.id) v.memberId = null; });
      db.giftRecords.forEach(r => { if (r.memberId === fm.id) r.memberId = null; });
      db.giftPersons.forEach(p => { if (p.memberId === fm.id) p.memberId = null; });
      db.scheduledTasks.forEach(t => { if (t.memberId === fm.id) t.memberId = null; });
      db.ledgerRecords.forEach(r => { if (r.memberId === fm.id) r.memberId = null; });
      db.tasks.forEach(t => { if (t.memberId === fm.id) t.memberId = null; });   // P1-1：事务关联同样解除
      // 健康档案按 memberId 整份删除（每位家人一份，无法「解除关联」保留）
      db.healthProfiles = db.healthProfiles.filter(x => x.memberId !== fm.id);
      db.familyMembers = db.familyMembers.filter(x => x.id !== fm.id);
      saveDb(); return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2761 });
};
