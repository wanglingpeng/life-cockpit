'use strict';
/* health —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2655] if (pathname === '/api/health' && method === 'GET') */
    router.get('/api/health', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, db.healthProfiles.map(h => {
      const fm = db.familyMembers.find(x => x.id === h.memberId);
      return { memberId: h.memberId, memberName: fm ? fm.name : '', relation: fm ? fm.relation : '', emoji: fm ? fm.emoji : '👤', chronic: h.chronic || [], allergies: h.allergies || [], medications: h.medications || [], checkups: h.checkups || [], vitals: h.vitals || [], notes: h.notes || '' };
    }));
    }, { auth: 'user', order: 2655 });

    /* [L2682] if (pathname === '/api/health/vitals' && method === 'POST') */
    router.post('/api/health/vitals', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, safeSlice, saveDb, todayStr } = app;
    const body = await readBody(req);
    const fm = db.familyMembers.find(x => x.id === +body.memberId);
    if (!fm) return fail(res, '家人不存在', 404);
    let h = db.healthProfiles.find(x => x.memberId === fm.id);
    if (!h) { h = { memberId: fm.id, chronic: [], allergies: [], medications: [], checkups: [], vitals: [], notes: '' }; db.healthProfiles.push(h); }
    const num = v => { const n = Math.round(+v); return Number.isFinite(n) && n > 0 ? n : null; };
    const wtNum = v => { const n = Math.round((+v) * 10) / 10; return Number.isFinite(n) && n > 0 ? n : null; };
    const sys = num(body.systolic), dia = num(body.diastolic), wt = wtNum(body.weight);
    // 自定义体征指标：[{name,value}]，名称≤20字、数值≤30字符、最多 6 项
    const customs = (Array.isArray(body.customs) ? body.customs : [])
      .map(c => ({ name: safeSlice(String((c && c.name) || '').trim(), 20), value: safeSlice(String((c && c.value) || '').trim(), 30) }))
      .filter(c => c.name && c.value).slice(0, 6);
    if (sys === null && dia === null && wt === null && !customs.length) return fail(res, '请至少填写一项体征（血压/体重/自定义指标）');
    const rec = { id: newId(db), date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : todayStr(), systolic: sys, diastolic: dia, weight: wt, customs, note: safeSlice(String(body.note || '').trim(), 100) };
    (h.vitals = h.vitals || []).push(rec);
    saveDb();
    return ok(res, rec, '体征已记录');
    }, { auth: 'user', order: 2682 });

    /* [L2713] if (pathname === '/api/health/reminders' && method === 'GET') */
    router.get('/api/health/reminders', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { daysUntil, dueState, ok } = app;
    const out = [];
    db.healthProfiles.forEach(h => {
      const fm = db.familyMembers.find(x => x.id === h.memberId);
      const mname = fm ? fm.name : '';
      (h.checkups || []).forEach(c => {
        if (!c.nextDate) return;
        const d = daysUntil(c.nextDate);
        out.push({ type: '复诊', member: mname, title: c.name, date: c.nextDate, daysLeft: d, state: dueState(d).state, link: '/health?member=' + h.memberId });
      });
      // 用药提醒：带日期型字段(nextDate/refillDate/nextRefill)的药按到期口径提醒
      (h.medications || []).forEach(med => {
        const medDate = med.nextDate || med.refillDate || med.nextRefill || '';
        if (!medDate) return;
        const d = daysUntil(medDate);
        if (d === null) return;
        out.push({ type: '用药', member: mname, title: med.name, date: medDate, daysLeft: d, state: dueState(d).state, link: '/health?member=' + h.memberId });
      });
    });
    return ok(res, out.sort((a, b) => a.daysLeft - b.daysLeft));
    }, { auth: 'user', order: 2713 });

    /* [L2661] if ((m = pathname.match(/^\/api\/health\/(\d+)$/)) && method === 'GET') */
    router.match(/^\/api\/health\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok } = app;
    const fm = db.familyMembers.find(x => x.id === +m[1]);
    if (!fm) return fail(res, '家人不存在', 404);
    const h = db.healthProfiles.find(x => x.memberId === fm.id);
    return ok(res, h ? Object.assign({}, h, { memberName: fm.name, relation: fm.relation, emoji: fm.emoji, vitals: h.vitals || [] }) : { memberId: fm.id, memberName: fm.name, relation: fm.relation, emoji: fm.emoji, chronic: [], allergies: [], medications: [], checkups: [], vitals: [], notes: '' });
    }, { auth: 'user', order: 2661, method: 'GET' });

    /* [L2667] if ((m = pathname.match(/^\/api\/health\/(\d+)$/)) && method === 'PUT') */
    router.match(/^\/api\/health\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb, validDateStr } = app;
    const fm = db.familyMembers.find(x => x.id === +m[1]);
    if (!fm) return fail(res, '家人不存在', 404);
    const body = await readBody(req);
    let h = db.healthProfiles.find(x => x.memberId === fm.id);
    if (!h) { h = { memberId: fm.id, chronic: [], allergies: [], medications: [], checkups: [], vitals: [], notes: '' }; db.healthProfiles.push(h); }
    if (Array.isArray(body.chronic)) h.chronic = body.chronic.map(x => ({ name: safeSlice(String(x.name || x || '').trim(), 60), note: safeSlice(String(x.note || '').trim(), 120) })).slice(0, 60);
    if (Array.isArray(body.allergies)) h.allergies = body.allergies.map(x => safeSlice(String(x.name || x || '').trim(), 60)).filter(Boolean).slice(0, 60);
    if (Array.isArray(body.medications)) h.medications = body.medications.map(x => ({ name: safeSlice(String(x.name || x || '').trim(), 60), dose: safeSlice(String(x.dose || '').trim(), 40), freq: safeSlice(String(x.freq || '').trim(), 20), remind: !!x.remind, nextDate: validDateStr(String(x.nextDate || '')) ? x.nextDate : '' })).slice(0, 60);
    if (Array.isArray(body.checkups)) h.checkups = body.checkups.map(x => ({ name: safeSlice(String(x.name || '').trim(), 60), nextDate: /^\d{4}-\d{2}-\d{2}$/.test(String(x.nextDate || '')) ? x.nextDate : '', freqMonths: Math.max(1, parseInt(x.freqMonths, 10) || 6) })).slice(0, 60);
    if (typeof body.notes === 'string') h.notes = safeSlice(String(body.notes), 300);
    saveDb();
    return ok(res, h, '健康记录已保存');
    }, { auth: 'user', order: 2667, method: 'PUT' });

    /* [L2701] if ((m = pathname.match(/^\/api\/health\/vitals\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/health\/vitals\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, saveDb } = app;
    const fm = db.familyMembers.find(x => x.id === +(q.get('memberId') || 0));
    if (!fm) return fail(res, '家人不存在', 404);
    const h = db.healthProfiles.find(x => x.memberId === fm.id);
    if (!h) return fail(res, '未找到体征记录', 404);
    const before = (h.vitals || []).length;
    h.vitals = (h.vitals || []).filter(v => v.id !== +m[1]);
    if (h.vitals.length === before) return fail(res, '体征记录不存在', 404);
    saveDb();
    return ok(res, null, '已删除');
    }, { auth: 'user', order: 2701, method: 'DELETE' });
};
