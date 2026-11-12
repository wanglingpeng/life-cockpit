'use strict';
/* home —— 首页与跨域聚合层。
 *
 * 为什么单独一层：这些路由每一个都横跨多个域（事务 + 效期 + 纪念日 + 账本
 * + 保险库 + 足迹……）拼出首页 / 今日 / 提醒总览 / 家庭月报 / 全局搜索的视图，
 * 消费方只有页面级组件。算进任何一个域都会让那个域被迫认识其他所有域；
 * 聚合一处的代价是它会随页面需求生长，收益是「改首页不用翻八个文件」。
 *
 * 注意 L4840 与 L1362 是同一路径同一方法的两条注册：router 按 order 全局
 * 排序、首个命中即返回，L1362（token 校验）永远先赢，L4840 实际不可达——
 * 原 if 链里就是这个语义，逐字保留，不要「顺手修好」它。
 *
 * 与 server.js 时代的关系：由 handleApi() 机械切出，路由体逐字保留，
 * [Lxxxx] 是原 if 链中的行号。每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {

    /* [L1362] if (pathname === '/api/calendar.ics' && method === 'GET') */
    router.get('/api/calendar.ics', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { decorateSchedule, fail, getAuthUser, mortgageNextPayment, nextRunDate } = app;
    const token = q.get('token') || '';
    const tokenOk = token && db.settings.subscribeToken && token === db.settings.subscribeToken;
    if (!tokenOk && !getAuthUser(req)) return fail(res, '订阅链接无效或已过期，请在通用配置中重新生成', 401);
    const padI = n => String(n).padStart(2, '0');
    const fmtDate = s => s.replace(/-/g, '');
    const rg = db.settings.icsRange || {};
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Life Cockpit//CN\r\nX-WR-CALNAME:生活驾驶舱\r\n';
    db.tasks.forEach(t => {
      if (!t.date) return;
      if (rg.start && t.date < rg.start) return;
      if (rg.end && t.date > rg.end) return;
      ics += 'BEGIN:VEVENT\r\nUID:task-' + t.id + '@remindflow.local\r\n';
      ics += 'DTSTART;VALUE=DATE:' + fmtDate(t.date) + '\r\n';
      ics += 'SUMMARY:' + (t.pinned ? '【备忘】' : '') + (t.title || '') + '\r\n';
      if (t.remark) ics += 'DESCRIPTION:' + t.remark.replace(/\r?\n/g, '\\n') + '\r\n';
      ics += 'END:VEVENT\r\n';
    });
    db.anniversaries.forEach(a => {
      if (!a.date) return;
      if (rg.start && a.date < rg.start) return;
      if (rg.end && a.date > rg.end) return;
      ics += 'BEGIN:VEVENT\r\nUID:ann-' + a.id + '@remindflow.local\r\n';
      ics += 'DTSTART;VALUE=DATE:' + fmtDate(a.date) + '\r\n';
      ics += 'SUMMARY:纪念日 - ' + (a.title || '') + '\r\n';
      if (a.repeat === 'yearly') ics += 'RRULE:FREQ=YEARLY\r\n';
      ics += 'END:VEVENT\r\n';
    });
    // 周期提醒：按 nextRunDate 生成单次事件
    db.scheduledTasks.forEach(t => {
      if (!t.enabled) return;
      const nd = decorateSchedule(t).nextRunDate;
      if (!nd) return;
      if (rg.start && nd < rg.start) return;
      if (rg.end && nd > rg.end) return;
      ics += 'BEGIN:VEVENT\r\nUID:sched-' + t.id + '@remindflow.local\r\n';
      ics += 'DTSTART;VALUE=DATE:' + fmtDate(nd) + '\r\n';
      ics += 'SUMMARY:周期 - ' + (t.name || '') + '\r\nEND:VEVENT\r\n';
    });
    // 效期物品：到期日 + 保修到期 各一条
    db.expiryItems.forEach(i => {
      if (i.expiryDate && !(rg.start && i.expiryDate < rg.start) && !(rg.end && i.expiryDate > rg.end)) {
        ics += 'BEGIN:VEVENT\r\nUID:exp-' + i.id + '-e@remindflow.local\r\n';
        ics += 'DTSTART;VALUE=DATE:' + fmtDate(i.expiryDate) + '\r\n';
        ics += 'SUMMARY:效期 - ' + (i.name || '') + '\r\nEND:VEVENT\r\n';
      }
      if (i.warrantyUntil && !(rg.start && i.warrantyUntil < rg.start) && !(rg.end && i.warrantyUntil > rg.end)) {
        ics += 'BEGIN:VEVENT\r\nUID:exp-' + i.id + '-w@remindflow.local\r\n';
        ics += 'DTSTART;VALUE=DATE:' + fmtDate(i.warrantyUntil) + '\r\n';
        ics += 'SUMMARY:保修 - ' + (i.name || '') + '\r\nEND:VEVENT\r\n';
      }
    });
    // 房贷下次还款日
    db.mortgages.forEach(m => {
      const np = mortgageNextPayment(m);
      if (!np) return;
      if (rg.start && np < rg.start) return;
      if (rg.end && np > rg.end) return;
      ics += 'BEGIN:VEVENT\r\nUID:mort-' + m.id + '@remindflow.local\r\n';
      ics += 'DTSTART;VALUE=DATE:' + fmtDate(np) + '\r\n';
      ics += 'SUMMARY:房贷 - ' + (m.name || '') + '还款\r\nEND:VEVENT\r\n';
    });
    ics += 'END:VCALENDAR\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="remindflow.ics"',
      'Cache-Control': 'no-cache'
    });
    return res.end(ics);
    }, { auth: 'public', order: 1362, note: '日历订阅源：手机日历 App 不带 Cookie，靠 URL 里的 subscribeToken 校验；无 token 时回退会话' });

    /* [L1477] if (pathname === '/api/report' && method === 'GET') */
    router.get('/api/report', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { ledgerSummaryOf, ok } = app;
    const months = [];
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      /* 口径与 Web 端 /api/monthly-report 完全同源（ledgerSummaryOf）：
         含人情往来自动汇总、转账既不计收入也不计支出。
         旧实现在此用 kind !== 'expense' 当收入（把转账算成收入），且不含人情往来，
         导致同一个月「网页 ¥7,145.58 / 小程序 ¥5,347」的跨端口径不一致。 */
      const s = ledgerSummaryOf(ym);
      const monthTasks = db.tasks.filter(t => (t.date || '').slice(0, 7) === ym);
      const done = monthTasks.filter(t => t.statusId === 3).length;
      months.push({
        id: ym,
        title: d.getFullYear() + '年' + (d.getMonth() + 1) + '月 家庭月报',
        month: ym,
        expense: s.expense,
        income: s.income,
        net: s.net,
        taskTotal: monthTasks.length,
        taskDone: done,
        vaultCount: (db.vaultEntries || []).length
      });
    }
    return ok(res, months);
    }, { auth: 'user', order: 1477 });

    /* [L1506] if (pathname === '/api/dashboard/stats' && method === 'GET') */
    router.get('/api/dashboard/stats', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { ok, todayStr } = app;
    const today = todayStr();
    const list = db.tasks.filter(t => t.date === today);
    return ok(res, {
      stats: {
        totalTasks: list.length,
        pendingTasks: db.tasks.filter(t => t.date <= today && (t.statusId === 1 || t.statusId === 2)).length,
        inProgressTasks: list.filter(t => t.statusId === 2).length,
        completedTasks: list.filter(t => t.statusId === 3).length
      }
    });
    }, { auth: 'user', order: 1506 });

    /* [L1519] if (pathname === '/api/dashboard/life' && method === 'GET') */
    router.get('/api/dashboard/life', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { anniversaryLeft, daysToNextYearly, decorateSchedule, ledgerSummaryOf, nearestAnniversaryOf, ok, todayStr } = app;
    const today = todayStr();
    const month = today.slice(0, 7);
    const left = d => d ? Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;

    const todayTasks = db.tasks.filter(t => t.date === today)
      .sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (a.remindTime || '').localeCompare(b.remindTime || ''));

    const schedules = db.scheduledTasks.map(decorateSchedule).filter(t => t.enabled);
    const scheduleDue = schedules.filter(t => t.daysLeft <= 0).sort((a, b) => a.daysLeft - b.daysLeft);
    const scheduleSoon = schedules.filter(t => t.daysLeft > 0 && t.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft);

    const expirySoon = db.expiryItems.map(i => ({
      id: i.id, name: i.name, location: i.location || '', expiryDate: i.expiryDate, warrantyUntil: i.warrantyUntil || '',
      left: left(i.expiryDate), wLeft: left(i.warrantyUntil), attachments: i.attachments || []
    })).filter(i => i.left !== null && i.left <= 30).sort((a, b) => a.left - b.left);

    const anns = db.anniversaries.filter(a => a.showHome !== false).map(a => Object.assign({}, a, { left: anniversaryLeft(a) }))
      .filter(a => a.left !== null && a.left !== undefined && a.left <= 30).sort((a, b) => a.left - b.left);

    const members = db.familyMembers.map(m => ({
      id: m.id, name: m.name, emoji: m.emoji, avatar: m.avatar || null, relation: m.relation,
      birthdayLeft: m.birthday ? daysToNextYearly(m.birthday) : null,
      nextAnniversary: nearestAnniversaryOf(db.anniversaries.filter(a => a.memberId === m.id && a.showHome !== false))
    })).filter(m => (m.birthdayLeft !== null && m.birthdayLeft <= 30)
      || (m.nextAnniversary && m.nextAnniversary.left <= 30));

    const ledger = ledgerSummaryOf(month);
    const vaultExpiring = db.vaultEntries.filter(e => e.expireDate).map(e => ({
      id: e.id, title: e.title, kind: e.kind || 'password', holder: e.holder || '', expireDate: e.expireDate, left: left(e.expireDate)
    })).filter(e => e.left !== null && e.left <= 60).sort((a, b) => a.left - b.left);

    return ok(res, {
      today,
      tasks: {
        list: todayTasks,
        total: todayTasks.length,
        pending: todayTasks.filter(t => t.statusId === 1).length,
        progress: todayTasks.filter(t => t.statusId === 2).length,
        done: todayTasks.filter(t => t.statusId === 3).length
      },
      schedules: { due: scheduleDue, soon: scheduleSoon, enabledTotal: schedules.length },
      expiries: { soon: expirySoon, total: db.expiryItems.length },
      anniversaries: anns,
      members,
      ledger,
      vaultExpiring,
      counts: {
        family: db.familyMembers.length,
        archives: db.expiryItems.length,
        giftRecords: db.giftRecords.length,
        notes: db.notes.length
      }
    });
    }, { auth: 'user', order: 1519 });

    /* [L1576] if (pathname === '/api/reminders/overview' && method === 'GET') */
    router.get('/api/reminders/overview', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { anniversaryLeft, daysToNextYearly, daysUntil, decorateSchedule, dueState, mortgageNextPayment, ok, pushCfg, todayStr } = app;
    const leadDays = +pushCfg().leadDays || 3;
    const list = [];
    const add = o => { if (o && o.state !== 'ok') list.push(o); };
    // 周期事项（nextRun）
    db.scheduledTasks.forEach(t => {
      if (!t.enabled) return;
      const d = decorateSchedule(t);
      add({ module: 'scheduled', icon: '🔁', title: t.name || '周期事项', date: d.nextRunDate, daysLeft: d.daysLeft, state: d.state, link: '/scheduled-tasks' });
    });
    // 档案效期（到期 + 保修；条目可单独覆盖提前提醒天数 remindLeadDays）
    db.expiryItems.forEach(i => {
      const itLead = (i.remindLeadDays !== null && i.remindLeadDays !== undefined) ? i.remindLeadDays : leadDays;
      const a = dueState(daysUntil(i.expiryDate), itLead);
      if (a) add({ module: 'expiry', icon: '📦', title: i.name, date: i.expiryDate, daysLeft: a.daysLeft, state: a.state, link: '/expiries' });
      const w = dueState(daysUntil(i.warrantyUntil), itLead);
      if (w) add({ module: 'expiry', icon: '🛠️', title: i.name + '·保修', date: i.warrantyUntil, daysLeft: w.daysLeft, state: w.state, link: '/expiries' });
    });
    // 保险库到期
    db.vaultEntries.forEach(v => {
      const s = dueState(daysUntil(v.expireDate), leadDays);
      if (s) add({ module: 'vault', icon: '🔐', title: v.title || '保险库条目', date: v.expireDate, daysLeft: s.daysLeft, state: s.state, link: '/vault' });
    });
    // 贷款还款日（补上此前从未计算的模块）
    db.mortgages.forEach(m => {
      const np = mortgageNextPayment(m);
      const s = dueState(daysUntil(np), leadDays);
      if (s) add({ module: 'mortgage', icon: '🏠', title: (m.name || '贷款') + '还款', date: np, daysLeft: s.daysLeft, state: s.state, link: '/mortgage' });
    });
    // 纪念日/生日（每年循环，支持农历）
    db.anniversaries.forEach(a => {
      const s = dueState(anniversaryLeft(a), leadDays);
      if (s) add({ module: 'anniversary', icon: '💖', title: a.title, date: a.date, daysLeft: s.daysLeft, state: s.state, link: '/anniversaries' });
    });
    // 家人生日
    db.familyMembers.forEach(m => {
      if (!m.birthday) return;
      const s = dueState(daysToNextYearly(m.birthday), leadDays);
      if (s) add({ module: 'birthday', icon: '🎂', title: m.name + '生日', date: m.birthday, daysLeft: s.daysLeft, state: s.state, link: '/family' });
    });
    // 人情对象生日（随礼提醒）：临期时带出最近 365 天随礼金额
    const giftSince = todayStr(new Date(Date.now() - 365 * 86400000));
    db.giftPersons.forEach(p => {
      if (!p.birthday) return;
      const s = dueState(daysToNextYearly(p.birthday), leadDays);
      if (!s) return;
      const outAmt = db.giftRecords
        .filter(r => r.personId === p.id && r.direction === 'out' && (r.date || '') >= giftSince)
        .reduce((x, r) => x + (+r.amount || 0), 0);
      const remark = outAmt > 0 ? ('去年随礼 ' + outAmt + ' 元') : '暂无随礼记录';
      add({ module: 'gift', icon: '🎁', title: (p.name || '往来对象') + '·生日', date: p.birthday, daysLeft: s.daysLeft, state: s.state, link: '/gift-records', remark });
    });
    // 逾期单事务（R02：引擎补上此前漏掉的未完成任务）
    const todayS = todayStr();
    db.tasks.forEach(tt => {
      if ((tt.statusId || 1) === 3) return;
      if (!tt.date || tt.date > todayS) return;
      const s = dueState(daysUntil(tt.date), leadDays);
      if (s) add({ module: 'task', icon: '📋', title: tt.title || '待办', date: tt.date, daysLeft: s.daysLeft, state: s.state, link: '/tasks' });
    });
    // 健康复诊（R02：补进统一引擎，与首页/月报同口径）
    db.healthProfiles.forEach(h => {
      const hfm = db.familyMembers.find(x => x.id === h.memberId);
      (h.checkups || []).forEach(c => {
        if (!c.nextDate) return;
        const s = dueState(daysUntil(c.nextDate), leadDays);
        if (s) add({ module: 'health', icon: '🩺', title: (hfm ? hfm.name : '家人') + '·' + (c.name || '复诊'), date: c.nextDate, daysLeft: s.daysLeft, state: s.state, link: '/health' });
      });
    });
    list.sort((a, b) => a.daysLeft - b.daysLeft);
    const count = st => list.filter(x => x.state === st).length;
    return ok(res, { today: todayStr(), leadDays, list, counts: { soon: count('soon'), due: count('due'), overdue: count('overdue') }, total: list.length });
    }, { auth: 'user', order: 1576 });

    /* [L1651] if (pathname === '/api/today' && method === 'GET') */
    router.get('/api/today', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { buildTodayPayload, ok, recordActivity, saveDb } = app;
    recordActivity('today.view', 1); saveDb();
    return ok(res, buildTodayPayload());
    }, { auth: 'user', order: 1651 });

    /* [L2174] if (pathname === '/api/holiday' && method === 'GET') */
    router.get('/api/holiday', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { holidaysOf, ok } = app;
    const year = parseInt(q.get('year') || String(new Date().getFullYear()), 10);
    return ok(res, holidaysOf(year));
    }, { auth: 'user', order: 2174 });

    /* [L3101] if (pathname === '/api/search' && method === 'GET') */
    router.get('/api/search', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { htmlToPlain, ledgerCatName, ok } = app;
    const raw = String(q.get('kw') || '').trim();
    if (!raw) return ok(res, [], '空关键词');          // 空/纯空格：空数组
    const k = raw.slice(0, 50).toLowerCase();           // 超长截断到 50
    const hit = s => String(s == null ? '' : s).toLowerCase().includes(k);
    const cut = text => {                                // 命中词前后约 30 字
      const t = String(text == null ? '' : text);
      const i = t.toLowerCase().indexOf(k);
      if (i < 0) return t.slice(0, 60);
      const s = Math.max(0, i - 30), e = Math.min(t.length, i + k.length + 30);
      return (s > 0 ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : '');
    };
    const PER = 5, perType = {}, data = [];
    const push = o => {
      perType[o.type] = perType[o.type] || 0;
      if (perType[o.type] >= PER) return;
      perType[o.type]++; data.push(o);
    };
    const gname = pid => (db.giftPersons.find(p => p.id === pid) || {}).name || '';
    // —— 事务 ——
    (db.tasks || []).filter(t => hit(t.title) || hit(t.remark)).forEach(t => push({
      type: 'task', id: t.id, title: String(t.title || '').slice(0, 60),
      snippet: cut(hit(t.title) ? t.title : t.remark), date: t.date || '', href: '/tasks'
    }));
    // —— 手记（content 可能是 HTML → 先 htmlToPlain，绝不回原文） ——
    (db.notes || []).forEach(n => {
      const plain = n.format === 'html' ? htmlToPlain(n.content || '') : String(n.content || '');
      if (!(hit(n.title) || hit(plain))) return;
      push({
        type: 'note', id: n.id, title: String(n.title || '').slice(0, 60),
        snippet: cut(hit(n.title) ? n.title : plain), date: String(n.updatedAt || n.createdAt || '').slice(0, 10), href: '/notes'
      });
    });
    // —— 流水（金额用于展示；命中 remark / 分类名。转账不计） ——
    (db.ledgerRecords || []).forEach(r => {
      const cat = ledgerCatName(r.categoryId) || '未分类';
      if (r.kind === 'transfer' || !(hit(r.remark) || hit(cat))) return;
      push({
        type: 'ledger', id: r.id,
        title: cat + ' ¥' + (Math.round((+r.amount || 0) * 100) / 100),
        snippet: cut(hit(r.remark) ? r.remark : cat), date: r.date || '', href: '/ledger'
      });
    });
    // —— 人情（命中 人名 / 事件类型 / 备注） ——
    (db.giftRecords || []).forEach(r => {
      const pn = gname(r.personId);
      if (!(hit(pn) || hit(r.eventType) || hit(r.remark))) return;
      push({
        type: 'gift', id: r.id,
        title: (pn ? pn + ' · ' : '') + (r.eventType || '往来') + ' ' + (r.direction === 'in' ? '收礼' : '随礼') + ' ¥' + (Math.round((+r.amount || 0) * 100) / 100),
        snippet: cut(r.remark || r.eventType), date: r.date || '', href: '/gift-records'
      });
    });
    return ok(res, data.length ? [{ group: '数据', items: data.slice(0, 20) }] : []);
    }, { auth: 'user', order: 3101 });

    /* [L3380] if (pathname === '/api/monthly-report' && method === 'GET') */
    router.get('/api/monthly-report', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { computeNetWorth, fail, ledgerSummaryOf, mortgageMonthlyPayment, ok, round2, todayStr } = app;
    const month = (q.get('month') || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, '月份格式不正确（需 YYYY-MM）');
    const s = ledgerSummaryOf(month);
    const inMonth = r => (r.date || '').startsWith(month);
    const top = db.ledgerRecords.filter(r => r.kind === 'expense' && inMonth(r)).slice()
      .sort((a, b) => b.amount - a.amount).slice(0, 5)
      .map(r => { const c = db.ledgerCategories.find(x => x.id === r.categoryId); return { amount: r.amount, date: r.date, cat: c ? c.name : '未分类', icon: c ? c.icon || '' : '', remark: r.remark || '', method: r.method || '' }; });
    const gifts = db.giftRecords.filter(inMonth);
    const giftIn = gifts.filter(g => g.direction === 'in').reduce((x, g) => x + (+g.amount || 0), 0);
    const giftOut = gifts.filter(g => g.direction === 'out').reduce((x, g) => x + (+g.amount || 0), 0);
    const anniv = db.anniversaries.filter(a => { const d = (a.date || ''); if (d.length < 10) return false; const yearly = a.repeat === 'yearly' || a.type === 'count-up'; return yearly ? d.slice(5, 7) === month.slice(5, 7) : d.slice(0, 7) === month; })
      /* yearly 纪念日落在本月，月报语境下只展示 MM-DD（原始年份多为出生/结婚年，展示易困惑）；非重复项保留完整日期 */
      .map(a => { const fm = db.familyMembers.find(x => x.id === a.memberId); const yearly = a.repeat === 'yearly' || a.type === 'count-up'; return { title: a.title, date: yearly ? a.date.slice(5) : a.date, member: fm ? fm.name : '' }; });
    const checkups = [];
    db.healthProfiles.forEach(h => { (h.checkups || []).forEach(c => { if (c.nextDate && c.nextDate.slice(0, 7) === month) { const fm = db.familyMembers.find(x => x.id === h.memberId); checkups.push({ title: c.name, date: c.nextDate, member: fm ? fm.name : '' }); } }); });
    const footprintCount = db.footprints.filter(f => (f.firstDate || '').startsWith(month)).length;
    const notesCount = db.notes.filter(n => (n.createdAt || '').slice(0, 7) === month).length;
    // 本月手记标题（近 8 条，供月报回看入口）
    const noteTitles = db.notes.filter(n => (n.createdAt || '').slice(0, 7) === month).slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id - a.id)
      .slice(0, 8).map(n => ({ title: n.title || '无标题', date: (n.createdAt || '').slice(0, 10) }));
    // 本月房贷月供合计（每条贷款按月供公式计算后相加；principal 单位万元）
    const mortgagePayment = Math.round(db.mortgages.reduce((x, m) => x + mortgageMonthlyPayment(m), 0));
    const expCats = (s.byCategory && s.byCategory.expense) || [];
    const topCat = expCats[0] ? expCats[0] : null;
    const days = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    /* 日均口径：查看当月时按「已过天数（含今天）」均摊，避免月中按整月平均导致数值虚低；
       查看历史月份时该月已完结，按整月天数均摊。 */
    const isCurrentMonth = month === todayStr().slice(0, 7);
    const elapsedDays = isCurrentMonth ? new Date().getDate() : days;
    const avgDaily = elapsedDays ? +(s.expense / elapsedDays).toFixed(2) : 0;
    /* 净资产：与首页/家底总览/账本同源（computeNetWorth），不再各自重算 */
    const w = computeNetWorth();
    const netWorth = w.net;
    /* 消费构成必须与「支出总额」自洽：完整返回全部分类（旧版 slice(0,8) 会静默吞掉小额分类，
       导致「各分类合计 ≠ 支出总额」）。分类数超过 12 时把尾部合并成显式「其他 N 项」，
       合计恒等于 expense。 */
    const CAT_CAP = 12;
    let catRows = expCats;
    if (expCats.length > CAT_CAP) {
      const head = expCats.slice(0, CAT_CAP);
      const restSum = round2(expCats.slice(CAT_CAP).reduce((x, c) => x + (+c.amount || 0), 0));
      head.push({
        id: '__others', name: '其他 ' + (expCats.length - CAT_CAP) + ' 项', icon: '📦',
        amount: restSum, percent: s.expense ? Math.round(restSum / s.expense * 1000) / 10 : 0,
        auto: false, children: []
      });
      catRows = head;
    }
    return ok(res, {
      month, expense: s.expense, income: s.income, net: s.net, count: s.count,
      giftExpense: s.giftExpense || 0, manualExpense: s.manualExpense || 0,
      byCategory: catRows, categoryTotal: round2(catRows.reduce((x, c) => x + (+c.amount || 0), 0)), top, giftIn, giftOut, giftCount: gifts.length,
      anniv, checkups, footprintCount, notesCount, noteTitles, mortgagePayment, netWorth,
      netWorthParts: { manualAssets: w.manualAssets, ledgerAssets: w.ledgerAssets, ledgerDebts: w.ledgerDebts, mortgageDebt: w.mortgageDebt, otherDebts: w.otherDebts, assetTotal: w.assetTotal, debtTotal: w.debtTotal },
      topCat, avgDaily, days, elapsedDays, isCurrentMonth
    });
    }, { auth: 'user', order: 3380 });

    /* [L4840] if (pathname === '/api/calendar.ics' && method === 'GET') */
    router.get('/api/calendar.ics', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { fail } = app;
    return fail(res, '请通过「通用配置 → 日历订阅」的链接访问', 400);
    }, { auth: 'user', order: 4840 });
};
