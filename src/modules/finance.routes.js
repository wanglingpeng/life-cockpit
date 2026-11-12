'use strict';
/* finance —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L3641] if (pathname === '/api/mortgage' && method === 'GET') */
    router.get('/api/mortgage', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, db.mortgages.slice().sort((a, b) => b.id - a.id));
    }, { auth: 'user', order: 3641 });

    /* [L3644] if (pathname === '/api/mortgage' && method === 'POST') */
    router.post('/api/mortgage', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, safeSlice, saveDb, todayStr } = app;
    const body = await readBody(req);
    if (!body.name || body.principal === undefined || body.annualRate === undefined || body.years === undefined) return fail(res, '请填写完整贷款信息');
    const principal = +body.principal, rate = +body.annualRate, years = +body.years;
    if (!Number.isFinite(principal) || principal <= 0) return fail(res, '贷款本金必须为正数（单位：万元）');
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return fail(res, '年利率无效（0-100%）');
    if (!Number.isFinite(years) || years <= 0 || years > 100) return fail(res, '贷款年限无效（1-100 年）');
    const item = {
      id: newId(db), name: safeSlice(String(body.name).trim(), 60), principal, annualRate: rate, years,
      method: body.method === 'equal-principal' ? 'equal-principal' : 'equal-payment',
      startDate: body.startDate || todayStr(), createdAt: todayStr()
    };
    db.mortgages.push(item); saveDb(); return ok(res, item, '创建成功');
    }, { auth: 'user', order: 3644 });

    /* [L3689] if (pathname === '/api/assets' && method === 'GET') */
    router.get('/api/assets', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, db.assets.slice().sort((a, b) => b.id - a.id));
    }, { auth: 'user', order: 3689 });

    /* [L3692] if (pathname === '/api/assets' && method === 'POST') */
    router.post('/api/assets', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ASSET_TYPES, fail, newId, ok, readBody, saveDb, todayStr } = app;
    const body = await readBody(req);
    if (!body.name || body.amount === undefined) return fail(res, '请填写资产名称和金额');
    const amount = Math.round(+body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, '金额必须为大于 0 的整数元');
    const item = { id: newId(db), name: String(body.name).trim().slice(0, 60), type: ASSET_TYPES.includes(body.type) ? body.type : 'other', amount, note: body.note || '', createdAt: todayStr() };
    db.assets.push(item); saveDb(); return ok(res, item, '已添加资产');
    }, { auth: 'user', order: 3692 });

    /* [L3714] if (pathname === '/api/debts' && method === 'GET') */
    router.get('/api/debts', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, db.otherDebts.slice().sort((a, b) => b.id - a.id));
    }, { auth: 'user', order: 3714 });

    /* [L3717] if (pathname === '/api/debts' && method === 'POST') */
    router.post('/api/debts', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, safeSlice, saveDb, todayStr } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '负债名称不能为空');
    const amount = +body.amount;
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, '负债金额必须为正数（元）');
    const d = { id: newId(db), name: safeSlice(String(body.name).trim(), 40), amount, note: safeSlice(String(body.note || ''), 100), createdAt: todayStr() };
    db.otherDebts.push(d); saveDb(); return ok(res, d, '已添加负债');
    }, { auth: 'user', order: 3717 });

    /* [L3737] if (pathname === '/api/networth' && method === 'GET') */
    router.get('/api/networth', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { computeNetWorth, newId, ok, round2, todayStr } = app;
    /* 口径唯一权威源：computeNetWorth()（含账本账户余额），全站所有页面读同一个数 */
    const w = computeNetWorth();
    const assetTotal = w.assetTotal;
    const loanTotal = w.mortgageDebt;                          // 贷款 principal 单位万元 → 已统一为元
    const otherDebtTotal = round2(w.otherDebts + w.ledgerDebts); // 其他负债 + 账本账户负余额（信用卡/钱包欠款）
    const net = w.net;
    const typeCN = { deposit: '存款', fund: '理财', stock: '股票/证券', gold: '贵金属/黄金', cash: '现金', house: '房产', vehicle: '车辆', invest: '投资', receivable: '应收', other: '其他' };
    const byType = {};
    db.assets.forEach(a => { const k = a.type || 'other'; byType[k] = Math.round((byType[k] || 0) + (+a.amount || 0)); });
    /* 账本账户正余额作为一个「资产构成」分组展示，保证构成图合计 = assetTotal */
    if (w.ledgerAssets > 0) byType.__ledger = round2(w.ledgerAssets);
    const policies = db.vaultEntries.filter(v => (v.kind || '') === 'policy');
    /* 净资产快照：按日 upsert（同日覆盖），供趋势图（有任一资产负债数据才记录） */
    if (db.assets.length || db.mortgages.length || db.otherDebts.length || w.accountTotal) {
      db.networthSnapshots = db.networthSnapshots || [];
      const d = todayStr();
      const ex = db.networthSnapshots.find(s => s.date === d);
      if (ex) { ex.totalAssets = assetTotal; ex.totalDebts = w.debtTotal; ex.netWorth = net; }
      else db.networthSnapshots.push({ id: newId(db), date: d, totalAssets: assetTotal, totalDebts: w.debtTotal, netWorth: net });
      if (db.networthSnapshots.length > 800) db.networthSnapshots = db.networthSnapshots.slice(-800);
    }
    return ok(res, {
      today: todayStr(), assetTotal, loanTotal, otherDebtTotal, debtTotal: w.debtTotal, net,
      /* 口径分量：供「家底总览」把账本账户并排展示，避免用户以为少算了钱 */
      manualAssets: w.manualAssets, ledgerAssets: w.ledgerAssets, ledgerDebts: w.ledgerDebts,
      ledgerNetWorth: w.ledgerNetWorth, mortgageDebt: w.mortgageDebt,
      /* 手工录入的其他负债单独给出：otherDebtTotal 已含账本账户欠款，口径说明要能拆开显示 */
      otherDebtsManual: w.otherDebts, accountCount: w.accountCount,
      assetCount: db.assets.length, loanCount: db.mortgages.length,
      byType: Object.keys(byType).map(k => ({ type: k, label: k === '__ledger' ? '账本账户' : (typeCN[k] || '其他'), amount: byType[k] })),
      debts: db.otherDebts.slice().sort((a, b) => b.amount - a.amount),
      assets: db.assets.slice().sort((a, b) => b.amount - a.amount),
      loans: db.mortgages.map(m => ({ id: m.id, name: m.name, principal: m.principal, annualRate: m.annualRate, years: m.years, startDate: m.startDate })),
      policyCount: policies.length,
      health: (assetTotal + w.debtTotal) > 0 ? (net >= 0 ? '净资产为正' : '负债超过资产') : '尚未录入'
    });
    }, { auth: 'user', order: 3737 });

    /* [L3777] if (pathname === '/api/networth/snapshots' && method === 'GET') */
    router.get('/api/networth/snapshots', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const list = (db.networthSnapshots || []).slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-365);
    return ok(res, list);
    }, { auth: 'user', order: 3777 });

    /* [L3658] if ((m = pathname.match(/^\/api\/mortgage\/(\d+)$/)) && method === 'PUT') */
    router.match(/^\/api\/mortgage\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb, todayStr } = app;
    const item = db.mortgages.find(x => x.id === +m[1]);
    if (!item) return fail(res, '贷款方案不存在', 404);
    const body = await readBody(req);
    if (body.name !== undefined) item.name = safeSlice(String(body.name).trim(), 60);
    if (body.principal !== undefined) {
      const n = +body.principal;
      if (!Number.isFinite(n) || n <= 0) return fail(res, '贷款本金必须为正数（单位：万元）');
      item.principal = n;
    }
    if (body.annualRate !== undefined) {
      const r = +body.annualRate;
      if (!Number.isFinite(r) || r < 0 || r > 100) return fail(res, '年利率无效（0-100%）');
      item.annualRate = r;
    }
    if (body.years !== undefined) {
      const y = +body.years;
      if (!Number.isFinite(y) || y <= 0 || y > 100) return fail(res, '贷款年限无效（1-100 年）');
      item.years = y;
    }
    if (body.method !== undefined) item.method = body.method === 'equal-principal' ? 'equal-principal' : 'equal-payment';
    if (body.startDate !== undefined) item.startDate = body.startDate || todayStr();
    saveDb(); return ok(res, item, '更新成功');
    }, { auth: 'user', order: 3658, method: 'PUT' });

    /* [L3682] if ((m = pathname.match(/^\/api\/mortgage\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/mortgage\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { ok, saveDb } = app;
    db.mortgages = db.mortgages.filter(x => x.id !== +m[1]); saveDb();
    return ok(res, null, '删除成功');
    }, { auth: 'user', order: 3682, method: 'DELETE' });

    /* [L3700] if ((m = pathname.match(/^\/api\/assets\/(\d+)$/)) && method === 'PUT') */
    router.match(/^\/api\/assets\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { ASSET_TYPES, fail, ok, readBody, safeSlice, saveDb } = app;
    const a = db.assets.find(x => x.id === +m[1]); if (!a) return fail(res, '未找到资产', 404);
    const body = await readBody(req);
    if (body.name !== undefined) a.name = safeSlice(String(body.name).trim(), 60);
    if (body.type !== undefined) a.type = ASSET_TYPES.includes(body.type) ? body.type : a.type;
    if (body.amount !== undefined) { const n = Math.round(+body.amount); if (!Number.isFinite(n) || n <= 0) return fail(res, '金额必须为大于 0 的整数元'); a.amount = n; }
    if (body.note !== undefined) a.note = body.note;
    saveDb(); return ok(res, a, '已更新');
    }, { auth: 'user', order: 3700, method: 'PUT' });

    /* [L3709] if ((m = pathname.match(/^\/api\/assets\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/assets\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { ok, saveDb } = app;
    db.assets = db.assets.filter(x => x.id !== +m[1]); saveDb(); return ok(res, null, '已删除');
    }, { auth: 'user', order: 3709, method: 'DELETE' });

    /* [L3725] if ((m = pathname.match(/^\/api\/debts\/(\d+)$/))) */
    router.match(/^\/api\/debts\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb } = app;
    const d = db.otherDebts.find(x => x.id === +m[1]);
    if (!d) return fail(res, '负债不存在', 404);
    if (method === 'DELETE') { db.otherDebts = db.otherDebts.filter(x => x.id !== +m[1]); saveDb(); return ok(res, null, '已删除'); }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) d.name = safeSlice(String(body.name).trim(), 40);
      if (body.amount !== undefined) { const n = +body.amount; if (!Number.isFinite(n) || n <= 0) return fail(res, '负债金额必须为正数'); d.amount = n; }
      if (body.note !== undefined) d.note = safeSlice(String(body.note || ''), 100);
      saveDb(); return ok(res, d, '已更新');
    }
    }, { auth: 'user', order: 3725 });
};
