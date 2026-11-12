'use strict';
/* ledger —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2789] if (pathname === '/api/ledger/categories' && method === 'GET') */
    router.get('/api/ledger/categories', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const kind = q.get('kind');
    const withStat = q.get('stat') === '1';
    const amountOf = cid => db.ledgerRecords.filter(r => r.categoryId === cid && r.kind !== 'transfer')
      .reduce((s, r) => s + (+r.amount || 0), 0);
    /* 默认只返回一级分类（parentId 为 null）——保持旧调用方「15 个分类」的形状不变，
       二级分类按需取（?parentId=N）或整棵树（?tree=1 / ?all=1）。 */
    let list = db.ledgerCategories.slice();
    if (kind) list = list.filter(c => c.kind === kind);
    const decorate = c => {
      const o = { id: c.id, name: c.name, icon: c.icon, kind: c.kind, builtin: !!c.builtin, parentId: c.parentId === undefined ? null : c.parentId, sort: c.sort || 0, archived: !!c.archived };
      if (withStat) { o.amount = amountOf(c.id); o.count = db.ledgerRecords.filter(r => r.categoryId === c.id).length; }
      return o;
    };
    if (q.get('tree') === '1' || q.get('all') === '1') {
      const all = list.map(decorate);
      const parents = all.filter(c => !c.parentId).sort((a, b) => a.sort - b.sort || a.id - b.id);
      if (q.get('tree') === '1') {
        return ok(res, parents.map(p => Object.assign({}, p, {
          children: all.filter(c => c.parentId === p.id).sort((a, b) => a.sort - b.sort || a.id - b.id)
        })));
      }
      return ok(res, all);
    }
    const pid = q.get('parentId');
    if (pid !== null && pid !== undefined && pid !== '') {
      const np = +pid;
      return ok(res, list.filter(c => c.parentId === np).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id).map(decorate));
    }
    return ok(res, list.filter(c => !c.parentId).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id).map(decorate));
    }, { auth: 'user', order: 2789 });

    /* [L2820] if (pathname === '/api/ledger/categories' && method === 'POST') */
    router.post('/api/ledger/categories', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    if (!body.name) return fail(res, '分类名不能为空');
    const kind = body.kind === 'income' ? 'income' : 'expense';
    const pid = body.parentId ? +body.parentId : null;
    if (pid) {
      const p = db.ledgerCategories.find(c => c.id === pid);
      if (!p) return fail(res, '上级分类不存在', 404);
      if (p.parentId) return fail(res, '只支持两级分类，不能在二级分类下再建子类');
      if (p.kind !== kind) return fail(res, '二级分类的收支类型必须与上级一致');
    }
    if (db.ledgerCategories.some(c => c.name === body.name && (c.parentId || null) === pid && c.kind === kind)) {
      return fail(res, '同级下已存在同名分类');
    }
    const c = {
      id: newId(db), name: safeSlice(String(body.name), 12), icon: safeSlice(String(body.icon || '📦'), 4),
      kind, builtin: false, parentId: pid, archived: false,
      sort: db.ledgerCategories.filter(x => (x.parentId || null) === pid).length
    };
    db.ledgerCategories.push(c); saveDb(); return ok(res, c, '创建成功');
    }, { auth: 'user', order: 2820 });

    /* [L2871] if (pathname === '/api/ledger/books' && method === 'GET') */
    router.get('/api/ledger/books', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { defaultLedgerBookId, ok, round2 } = app;
    const withStat = q.get('stat') === '1';
    const month = (q.get('month') || '').slice(0, 7);
    let list = db.ledgerBooks.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id);
    if (q.get('archived') !== '1') list = list.filter(b => !b.archived);
    const stat = b => {
      const rs = db.ledgerRecords.filter(r => r.bookId === b.id && r.kind !== 'transfer' && (!month || (r.date || '').startsWith(month)));
      return {
        month, count: rs.length,
        expense: round2(rs.filter(r => r.kind === 'expense').reduce((s, r) => s + (+r.amount || 0), 0)),
        income: round2(rs.filter(r => r.kind === 'income').reduce((s, r) => s + (+r.amount || 0), 0))
      };
    };
    const out = list.map(b => (withStat ? Object.assign({}, b, { stat: stat(b) }) : b));
    if (withStat) {
      /* 未归属任何账本的流水（历史数据或手工改库）也要能被发现 */
      const orphan = db.ledgerRecords.filter(r => !db.ledgerBooks.some(b => b.id === r.bookId)).length;
      return ok(res, { books: out, orphanCount: orphan, defaultBookId: defaultLedgerBookId() });
    }
    return ok(res, out);
    }, { auth: 'user', order: 2871 });

    /* [L2892] if (pathname === '/api/ledger/books' && method === 'POST') */
    router.post('/api/ledger/books', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { LEDGER_BOOK_KINDS, fail, newId, ok, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return fail(res, '账本名称不能为空');
    if (name.length > 20) return fail(res, '账本名称不超过 20 字');
    if (db.ledgerBooks.some(b => b.name === name)) return fail(res, '已存在同名账本');
    const b = {
      id: newId(db), name, icon: safeSlice(String(body.icon || '📒'), 4),
      color: String(body.color || '#0ea5e9').slice(0, 20),
      kind: LEDGER_BOOK_KINDS.includes(body.kind) ? body.kind : 'other',
      memberIds: Array.isArray(body.memberIds) ? body.memberIds.map(Number).filter(Boolean) : [],
      archived: false, sort: db.ledgerBooks.length, builtin: false
    };
    db.ledgerBooks.push(b); saveDb(); return ok(res, b, '创建成功');
    }, { auth: 'user', order: 2892 });

    /* [L2950] if (pathname === '/api/ledger/budgets' && method === 'GET') */
    router.get('/api/ledger/budgets', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ledgerBudgetStatus, ok, todayStr } = app;
    const month = (q.get('month') || todayStr().slice(0, 7)).slice(0, 7);
    return ok(res, ledgerBudgetStatus(month));
    }, { auth: 'user', order: 2950 });

    /* [L2954] if (pathname === '/api/ledger/budgets' && method === 'POST') */
    router.post('/api/ledger/budgets', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, round2, saveDb } = app;
    const body = await readBody(req);
    const month = String(body.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, '月份格式应为 YYYY-MM');
    const amount = +body.amount;
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, '预算金额必须大于 0');
    if (amount > 99999999) return fail(res, '预算金额过大');
    const categoryId = body.categoryId ? +body.categoryId : null;
    if (categoryId) {
      const c = db.ledgerCategories.find(x => x.id === categoryId);
      if (!c) return fail(res, '分类不存在', 404);
      if (c.kind !== 'expense') return fail(res, '只能给支出分类设预算');
      if (c.parentId) return fail(res, '预算按一级分类设置，请选择一级分类');
    }
    if (db.ledgerBudgets.some(b => b.month === month && (b.categoryId || null) === categoryId))
      return fail(res, categoryId ? '该分类本月已有预算，可直接修改金额' : '本月已设总预算，可直接修改金额');
    const b = { id: newId(db), month, categoryId, amount: round2(amount), createdAt: new Date().toISOString() };
    db.ledgerBudgets.push(b); saveDb();
    return ok(res, b, '预算已保存');
    }, { auth: 'user', order: 2954 });

    /* [L2974] if (pathname === '/api/ledger/budgets/copy' && method === 'POST') */
    router.post('/api/ledger/budgets/copy', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const from = String(body.from || '').slice(0, 7), to = String(body.to || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return fail(res, '月份格式应为 YYYY-MM');
    if (from === to) return fail(res, '源月份与目标月份相同');
    const src = db.ledgerBudgets.filter(b => b.month === from);
    if (!src.length) return fail(res, from + ' 没有可复制的预算');
    let n = 0;
    src.forEach(b => {
      if (db.ledgerBudgets.some(x => x.month === to && (x.categoryId || null) === (b.categoryId || null))) return;
      db.ledgerBudgets.push({ id: newId(db), month: to, categoryId: b.categoryId || null, amount: b.amount, createdAt: new Date().toISOString() });
      n++;
    });
    saveDb(); return ok(res, { copied: n }, `已复制 ${n} 条预算到 ${to}`);
    }, { auth: 'user', order: 2974 });

    /* [L3009] if (pathname === '/api/ledger/accounts' && method === 'GET') */
    router.get('/api/ledger/accounts', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const list = db.ledgerAccounts.slice().sort((a, b) => a.id - b.id);
    return ok(res, list);
    }, { auth: 'user', order: 3009 });

    /* [L3014] if (pathname === '/api/ledger/accounts/balances' && method === 'GET') */
    router.get('/api/ledger/accounts/balances', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { computeNetWorth, ledgerAccountBalances, ok } = app;
    const month = (q.get('month') || '').slice(0, 7);
    const r = ledgerAccountBalances(month);
    /* 家庭总口径一律走 computeNetWorth()，与 /api/networth、/api/monthly-report 同源，
       消除「账本页净资产 ≠ 家底总览净资产」的两套算法。账本口径（ledgerNetWorth）仍单独返回。 */
    const w = computeNetWorth();
    return ok(res, Object.assign(r, {
      otherAssets: w.manualAssets,
      mortgageDebt: w.mortgageDebt,
      otherDebts: w.otherDebts,
      totalAssets: w.assetTotal,
      totalDebts: w.debtTotal,
      netWorth: w.net,
      unassignedRecords: db.ledgerRecords.filter(x => x.kind !== 'transfer' && !x.accountId).length
    }));
    }, { auth: 'user', order: 3014 });

    /* [L3030] if (pathname === '/api/ledger/accounts' && method === 'POST') */
    router.post('/api/ledger/accounts', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { LEDGER_ACCOUNT_TYPES, fail, newId, ok, readBody, round2, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return fail(res, '账户名称不能为空');
    if (name.length > 30) return fail(res, '账户名称不超过 30 字');
    if (db.ledgerAccounts.some(a => a.name === name)) return fail(res, '已存在同名账户');
    const bal = Number(body.initialBalance || 0);
    if (!Number.isFinite(bal)) return fail(res, '期初余额必须是数字');
    const a = {
      id: newId(db), name,
      type: LEDGER_ACCOUNT_TYPES.includes(body.type) ? body.type : 'other',
      icon: safeSlice(String(body.icon || '💳'), 4),
      color: String(body.color || '').slice(0, 20),
      initialBalance: round2(bal),
      includeInNetWorth: body.includeInNetWorth !== false,
      remark: safeSlice(String(body.remark || ''), 100),
      builtin: false
    };
    db.ledgerAccounts.push(a); saveDb(); return ok(res, a, '创建成功');
    }, { auth: 'user', order: 3030 });

    /* [L3086] if (pathname === '/api/ledger/last-account' && method === 'GET') */
    router.get('/api/ledger/last-account', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ok } = app;
    const cid = +q.get('categoryId');
    if (!cid || !Number.isInteger(cid)) return fail(res, 'categoryId 必须是分类 id', 400);
    const cat = (db.ledgerCategories || []).find(c => c.id === cid);
    if (!cat) return fail(res, '分类不存在', 404);
    const hit = db.ledgerRecords
      .filter(r => r.kind !== 'transfer' && String(r.categoryId) === String(cid) && r.accountId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id)[0];
    return ok(res, hit ? { accountId: hit.accountId, bookId: hit.bookId || null, date: hit.date || '' } : null);
    }, { auth: 'user', order: 3086 });

    /* [L3156] if (pathname === '/api/ledger/records' && method === 'GET') */
    router.get('/api/ledger/records', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    let list = db.ledgerRecords.slice();
    const month = q.get('month'), kind = q.get('kind'), categoryId = q.get('categoryId');
    const memberId = q.get('memberId'), keyword = (q.get('keyword') || '').trim();
    const start = q.get('startDate'), end = q.get('endDate');
    const accountId = q.get('accountId');
    const bookId = q.get('bookId');
    if (month) list = list.filter(r => (r.date || '').startsWith(month));
    if (kind) list = list.filter(r => r.kind === kind);
    if (bookId) list = list.filter(r => String(r.bookId) === bookId);
    if (categoryId) list = list.filter(r => String(r.categoryId) === categoryId);
    if (memberId) list = list.filter(r => String(r.memberId) === memberId);
    /* 按账户筛选：转账在转出方和转入方两侧都应能查到 */
    if (accountId) list = list.filter(r => String(r.accountId) === accountId || String(r.toAccountId) === accountId);
    if (start) list = list.filter(r => (r.date || '') >= start);
    if (end) list = list.filter(r => (r.date || '') <= end);
    if (keyword) list = list.filter(r => (r.remark || '').includes(keyword));
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
    return ok(res, list);
    }, { auth: 'user', order: 3156 });

    /* [L3176] if (pathname === '/api/ledger/records' && method === 'POST') */
    router.post('/api/ledger/records', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ledgerFields, newId, nowStr, ok, readBody, recordActivity, safeSlice, saveDb, validAmount, validDateStr } = app;
    const body = await readBody(req);
    if (!body.date) return fail(res, '日期不能为空');
    if (!validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
    if (body.amount === undefined || body.amount === null || body.amount === '') return fail(res, '金额不能为空');
    if (!validAmount(body.amount)) return fail(res, '金额必须是大于 0 的数字');
    if (+body.amount > 1e9) return fail(res, '金额超出上限（10 亿）');
    const kind = body.kind === 'income' ? 'income' : (body.kind === 'transfer' ? 'transfer' : 'expense');
    if (kind === 'transfer') {
      /* 转账必须有转出与转入两个账户，且不能是同一个 */
      const from = db.ledgerAccounts.find(a => a.id === +body.accountId);
      const to = db.ledgerAccounts.find(a => a.id === +body.toAccountId);
      if (!from) return fail(res, '转出账户不存在');
      if (!to) return fail(res, '转入账户不存在');
      if (from.id === to.id) return fail(res, '转出与转入账户不能是同一个');
    } else {
      if (body.categoryId === undefined || body.categoryId === null || body.categoryId === '' || !db.ledgerCategories.find(c => c.id === +body.categoryId)) return fail(res, '账本分类不存在');
      if (body.accountId !== undefined && body.accountId !== null && body.accountId !== '' && !db.ledgerAccounts.find(a => a.id === +body.accountId)) return fail(res, '账户不存在');
    }
    const r = Object.assign({ id: newId(db), createdAt: nowStr(), source: 'manual' }, ledgerFields(body));
    /* 允许 body.source 覆盖默认 'manual'（白名单化，仅接受字符串；未知来源降级为 manual） */
    if (typeof body.source === 'string' && body.source.trim()) r.source = safeSlice(body.source.trim(), 32);
    db.ledgerRecords.push(r);
    recordActivity('ledger.create', 1);
    saveDb(); return ok(res, r, '创建成功');
    }, { auth: 'user', order: 3176 });

    /* [L3204] 账本 CSV 导入——按域内主题切到 ledger-import.routes.js（路由体逐字保留） */
    require('./ledger-import.routes.js')(router, app);

    /* [L3319] if (pathname === '/api/ledger/summary' && method === 'GET') */
    router.get('/api/ledger/summary', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ledgerSummaryOf, ok } = app;
    /* bookId 为可选作用域：不传 = 全账本（口径与旧版完全一致） */
    return ok(res, ledgerSummaryOf(q.get('month') || '', { bookId: q.get('bookId') }));
    }, { auth: 'user', order: 3319 });

    /* [L3323] if (pathname === '/api/ledger/trend' && method === 'GET') */
    router.get('/api/ledger/trend', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ledgerSummaryOf, ok } = app;
    const n = Math.min(24, Math.max(1, +(q.get('months') || 6)));
    const out = [];
    const base = new Date();
    base.setDate(1);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const s = ledgerSummaryOf(key);
      out.push({ month: key, expense: s.expense, income: s.income, net: s.net });
    }
    return ok(res, out);
    }, { auth: 'user', order: 3323 });

    /* [L3337] if (pathname === '/api/ledger/duplicates' && method === 'GET') */
    router.get('/api/ledger/duplicates', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const month = (q.get('month') || '').slice(0, 7);
    let list = db.ledgerRecords.slice();
    if (month) list = list.filter(r => (r.date || '').startsWith(month));
    const kindLabel = { expense: '支出', income: '收入', transfer: '转账' };
    const catNameOf = r => {
      if (r.kind === 'transfer') return '转账';
      const c = db.ledgerCategories.find(x => x.id === r.categoryId);
      return c ? c.name : '未分类';
    };
    const map = new Map();
    list.forEach(r => {
      const k = [r.date, r.kind, (+r.amount || 0).toFixed(2)].join('|');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    const groups = [];
    map.forEach(arr => {
      if (arr.length < 2) return;
      arr.sort((a, b) => a.id - b.id);
      const f = arr[0];
      groups.push({
        key: [f.date, kindLabel[f.kind] || f.kind, (+f.amount || 0).toFixed(2)].join('|'),
        total: arr.length,
        records: arr.map(r => ({ id: r.id, date: r.date, categoryName: catNameOf(r), amount: r.amount, remark: r.remark || '' }))
      });
    });
    groups.sort((a, b) => String(b.records[0].date).localeCompare(String(a.records[0].date)));
    return ok(res, groups);
    }, { auth: 'user', order: 3337 });

    /* [L3367] if (pathname === '/api/ledger/duplicates/cleanup' && method === 'POST') */
    router.post('/api/ledger/duplicates/cleanup', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ok, readBody, recordActivity, saveDb } = app;
    const body = await readBody(req);
    const keepId = +body.keepId;
    const removeIds = (Array.isArray(body.removeIds) ? body.removeIds : []).map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (!removeIds.length) return fail(res, '没有要删除的记录');
    if (removeIds.includes(keepId)) return fail(res, '保留记录不能出现在待删列表中');
    const before = db.ledgerRecords.length;
    db.ledgerRecords = db.ledgerRecords.filter(r => !removeIds.includes(r.id));
    const removed = before - db.ledgerRecords.length;
    if (removed) { recordActivity('ledger.dedup', removed); saveDb(); }
    return ok(res, { removed }, '已删除 ' + removed + ' 条');
    }, { auth: 'user', order: 3367 });

    /* [L2841] if ((m = pathname.match(/^\/api\/ledger\/categories\/(\d+)$/))) */
    router.match(/^\/api\/ledger\/categories\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb } = app;
    const cid = +m[1];
    const c = db.ledgerCategories.find(x => x.id === cid);
    if (!c) return fail(res, '分类不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return fail(res, '分类名不能为空');
        if (db.ledgerCategories.some(x => x.id !== cid && x.name === name && (x.parentId || null) === (c.parentId || null) && x.kind === c.kind)) {
          return fail(res, '同级下已存在同名分类');
        }
        c.name = safeSlice(name, 12);
      }
      if (body.icon !== undefined) c.icon = safeSlice(String(body.icon), 4);
      if (body.sort !== undefined) c.sort = +body.sort || 0;
      if (body.archived !== undefined) c.archived = !!body.archived;
      saveDb(); return ok(res, c, '更新成功');
    }
    if (method === 'DELETE') {
      /* 一级分类若仍有二级子类，需先处理子类，避免留下孤儿分类 */
      const kids = db.ledgerCategories.filter(x => x.parentId === cid);
      if (kids.length) return fail(res, `该分类下还有 ${kids.length} 个二级分类，请先删除或移出这些子分类`);
      if (db.ledgerRecords.some(r => r.categoryId === cid)) return fail(res, '该分类下仍有账目，无法删除');
      db.ledgerCategories = db.ledgerCategories.filter(x => x.id !== cid); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2841 });

    /* [L2907] if ((m = pathname.match(/^\/api\/ledger\/books\/(\d+)$/))) */
    router.match(/^\/api\/ledger\/books\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { LEDGER_BOOK_KINDS, fail, ok, readBody, safeSlice, saveDb } = app;
    const bid = +m[1];
    const b = db.ledgerBooks.find(x => x.id === bid);
    if (!b) return fail(res, '账本不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return fail(res, '账本名称不能为空');
        if (db.ledgerBooks.some(x => x.id !== bid && x.name === name)) return fail(res, '已存在同名账本');
        b.name = safeSlice(name, 20);
      }
      if (body.icon !== undefined) b.icon = safeSlice(String(body.icon), 4);
      if (body.color !== undefined) b.color = String(body.color).slice(0, 20);
      if (body.kind !== undefined && LEDGER_BOOK_KINDS.includes(body.kind)) b.kind = body.kind;
      if (body.archived !== undefined) b.archived = !!body.archived;
      if (body.sort !== undefined) b.sort = +body.sort || 0;
      if (Array.isArray(body.memberIds)) b.memberIds = body.memberIds.map(Number).filter(Boolean);
      saveDb(); return ok(res, b, '更新成功');
    }
    if (method === 'DELETE') {
      /* 有流水的账本不物理删除：把流水退回默认账本会篡改历史归属，风险高于便利，
         因此要求用户先转移流水（前端提供「转到其他账本」）。 */
      const n = db.ledgerRecords.filter(r => r.bookId === bid).length;
      if (n > 0) return fail(res, `该账本下仍有 ${n} 笔流水，请先转移或删除这些流水`);
      db.ledgerBooks = db.ledgerBooks.filter(x => x.id !== bid); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2907 });

    /* [L2937] if ((m = pathname.match(/^\/api\/ledger\/books\/(\d+)\/move$/)) && method === 'POST') */
    router.match(/^\/api\/ledger\/books\/(\d+)\/move$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, saveDb } = app;
    const from = +m[1];
    const body = await readBody(req);
    const to = body.toBookId ? +body.toBookId : null;
    if (!db.ledgerBooks.some(x => x.id === from)) return fail(res, '源账本不存在', 404);
    if (!to || !db.ledgerBooks.some(x => x.id === to)) return fail(res, '目标账本不存在', 404);
    if (from === to) return fail(res, '源账本与目标账本相同');
    let n = 0;
    db.ledgerRecords.forEach(r => { if (r.bookId === from) { r.bookId = to; n++; } });
    saveDb(); return ok(res, { moved: n }, `已转移 ${n} 笔流水`);
    }, { auth: 'user', order: 2937, method: 'POST' });

    /* [L2989] if ((m = pathname.match(/^\/api\/ledger\/budgets\/(\d+)$/))) */
    router.match(/^\/api\/ledger\/budgets\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, round2, saveDb } = app;
    const bid = +m[1];
    const b = db.ledgerBudgets.find(x => x.id === bid);
    if (!b) return fail(res, '预算不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.amount !== undefined) {
        const amount = +body.amount;
        if (!Number.isFinite(amount) || amount <= 0) return fail(res, '预算金额必须大于 0');
        b.amount = round2(amount);
      }
      saveDb(); return ok(res, b, '更新成功');
    }
    if (method === 'DELETE') {
      db.ledgerBudgets = db.ledgerBudgets.filter(x => x.id !== bid);
      saveDb(); return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2989 });

    /* [L3050] if ((m = pathname.match(/^\/api\/ledger\/accounts\/(\d+)$/))) */
    router.match(/^\/api\/ledger\/accounts\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { LEDGER_ACCOUNT_TYPES, fail, ok, readBody, round2, safeSlice, saveDb } = app;
    const aid = +m[1];
    const a = db.ledgerAccounts.find(x => x.id === aid);
    if (!a) return fail(res, '账户不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return fail(res, '账户名称不能为空');
        if (name.length > 30) return fail(res, '账户名称不超过 30 字');
        if (db.ledgerAccounts.some(x => x.id !== aid && x.name === name)) return fail(res, '已存在同名账户');
        a.name = name;
      }
      if (body.type !== undefined && LEDGER_ACCOUNT_TYPES.includes(body.type)) a.type = body.type;
      if (body.icon !== undefined) a.icon = safeSlice(String(body.icon), 4);
      if (body.color !== undefined) a.color = String(body.color).slice(0, 20);
      if (body.remark !== undefined) a.remark = safeSlice(String(body.remark), 100);
      if (body.includeInNetWorth !== undefined) a.includeInNetWorth = body.includeInNetWorth !== false;
      if (body.initialBalance !== undefined) {
        const bal = Number(body.initialBalance);
        if (!Number.isFinite(bal)) return fail(res, '期初余额必须是数字');
        a.initialBalance = round2(bal);
      }
      saveDb(); return ok(res, a, '更新成功');
    }
    if (method === 'DELETE') {
      /* 有流水挂在账户上就不允许删，否则余额会凭空消失 */
      const used = db.ledgerRecords.filter(r => r.accountId === aid || r.toAccountId === aid).length;
      if (used > 0) return fail(res, `该账户下仍有 ${used} 笔流水，请先转移或删除这些流水`);
      db.ledgerAccounts = db.ledgerAccounts.filter(x => x.id !== aid);
      saveDb(); return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 3050 });

    /* [L3304] if ((m = pathname.match(/^\/api\/ledger\/records\/(\d+)$/))) */
    router.match(/^\/api\/ledger\/records\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ledgerFields, ok, readBody, saveDb, validAmount, validDateStr } = app;
    const r = db.ledgerRecords.find(x => x.id === +m[1]);
    if (!r) return fail(res, '账目不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.date !== undefined && !validDateStr(String(body.date))) return fail(res, '日期格式不正确（需 YYYY-MM-DD 且为真实日期）');
      if (body.amount !== undefined && body.amount !== null && body.amount !== '' && !validAmount(body.amount)) return fail(res, '金额必须是大于 0 的数字');
      Object.assign(r, ledgerFields(body, r));
      saveDb(); return ok(res, r, '更新成功');
    }
    if (method === 'DELETE') {
      db.ledgerRecords = db.ledgerRecords.filter(x => x.id !== r.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 3304 });
};
