/* 今日视图数据组装：首页四维 payload（今天 / 钱 / 家底 / 记录）+ AI 快捷追加。
 *
 * buildTodayPayload 是首页唯一数据源：它调 ai/ledger/family/telemetry
 * 等服务取数再组装，自己不做任何计算——「汇总数字在 payload 里算
 * 一遍、在账本页又算一遍」是对不上的根源，所以这里只组装、不算账。
 *
 * applyQuickAdd 与它同模块的理由：快捷追加的落库口径（默认账本、
 * 分类解析、遥测记录）与 payload 的展示口径必须一致，拆开就会出现
 * 「追加成功但首页不显示」——两条路径各自正确，合起来对不上。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区中段）。 */
const rt = require('../core/runtime');
const { holidaysOf } = require('../../lib/lunar.js');
const { daysToNextYearly, greetingByHour, monthShift, newId, nowStr, safeSlice, todayStr, weekStartOf } = require('./utils');
const { decorateSchedule } = require('./schedule');
const { defaultLedgerBookId, ledgerBudgetStatus, ledgerSummaryOf } = require('./ledger');
const { mortgageNextPayment } = require('./family');
const { recordActivity } = require('./telemetry');
const { aiProviderStatus } = require('./ai');

/* 「今天要处理」的唯一窗口（方案A口径）：逾期 + 7 天内；>7 天的远期事件
 * 交给首页倒计时横幅，不进「今天」清单。此前这个 7 散落在 today.js、
 * brief.js(3 天)、digest.js、Web 首页、小程序首页五处，同一份数据能被
 * 算成三个不同的件数——所以窗口必须是服务端一个常量，并随 payload 下发。 */
const ACTION_WINDOW_DAYS = 7;

/** 从 payload 取「今天要处理」的条目。所有消费点都必须经过它，
 *  不允许再写一遍 order<=N（N 写错不会报错，只是悄悄换一批条目）。 */
function todayActionItems(payload) {
  return ((payload && payload.items) || []).filter(i => i.order <= ACTION_WINDOW_DAYS);
}

/** 待办域的「今天」：未完成（statusId!==3）且 date<=今天（含逾期）。
 *  首页行动流与 /api/tasks?tab=today 共用，避免两个页面给出两张清单。
 *  空日期保持既有行为（'' <= today 成立，归入今天），此处逐字复用旧表达式。 */
function isTodayTask(t, today) {
  return (t.date || '') <= (today || todayStr()) && (t.statusId || 1) !== 3;
}

/** 「近期」：未完成且 date>今天。与 isTodayTask 互斥且覆盖全部未完成待办。 */
function isUpcomingTask(t, today) {
  return (t.date || '') > (today || todayStr()) && (t.statusId || 1) !== 3;
}

/** 首屏数据：今天要处理的事 + 3 个关键指标（带同比/阈值）+ 本周记录量 + 数据健康度 */
function buildTodayPayload() {
  const today = todayStr();
  const dt = new Date(today + 'T00:00:00');
  // 假期/周末识别（P1-05）：法定节假日优先，其次周末，其余工作日
  const holInfo = holidaysOf(+today.slice(0, 4))[today];
  const dayType = holInfo ? 'holiday' : (dt.getDay() === 0 || dt.getDay() === 6 ? 'weekend' : 'workday');
  const dayName = holInfo ? holInfo.name : '';
  const left = s => (s ? Math.round((new Date(s + 'T00:00:00') - dt) / 86400000) : null);
  const items = [];
  const add = (l, o) => items.push(Object.assign({ order: l < 0 ? -1000 + l : l }, o));
  const isWorkText = s => /工作|上班|加班|出差|投标|会议|报表|述职/.test(String(s || ''));
  // P1-1 家人归属：按 memberId 取家庭成员名（additive，仅供首页行动流显示「给谁办」）
  const memberNameOf = id => { const m = id != null && rt.db.familyMembers.find(x => x.id === id); return m ? (m.name || '') : ''; };

  // 今天 / 逾期事务（未完成）
  rt.db.tasks.filter(t => isTodayTask(t, today)).forEach(t => {
    const l = left(t.date);
    // v43 工作事务扶正：显式 client 字段优先（真值来源），标题正则兜底（旧数据兼容）。
    // sub 文案含客户名与「下一步」，与 dashboard 的标签/副标题渲染对齐。
    const wc = String(t.client || '').trim();
    const na = String(t.nextAction || '').trim();
    const baseSub = l < 0 ? '待办 · 已逾期 ' + (-l) + ' 天' : '待办 · ' + (t.remindTime || '今天');
    add(l, {
      kind: 'task', id: t.id, icon: l < 0 ? '⚠️' : (t.pinned ? '📌' : '📋'), title: t.title,
      sub: wc ? (baseSub + ' · ' + wc + (na ? ' · 下一步：' + na : ' · 下一步：待定')) : baseSub,
      client: wc, nextAction: na,
      memberId: t.memberId || null, memberName: memberNameOf(t.memberId),
      level: l < 0 ? 'red' : 'yellow', link: '/tasks', workTag: !!wc || isWorkText(t.title)
    });
  });
  // 周期提醒（今天到期 / 已逾期）
  rt.db.scheduledTasks.map(decorateSchedule).filter(t => t.enabled && t.daysLeft <= 0).forEach(t => {
    add(t.daysLeft, {
      kind: 'scheduled', id: t.id, icon: '🔁', title: t.name || t.title || '周期事项',
      sub: '循环 · ' + (t.category || '其他') + (t.daysLeft < 0 ? ' · 逾期 ' + (-t.daysLeft) + ' 天' : ' · 今天'),
      memberId: t.memberId || null, memberName: memberNameOf(t.memberId),
      level: t.daysLeft < 0 ? 'red' : 'yellow', link: '/scheduled-tasks', workTag: /工作/.test(t.category || '')
    });
  });
  // 7 天内到期档案
  rt.db.expiryItems.forEach(i => {
    const l = left(i.expiryDate);
    if (l !== null && l <= 7) add(l, {
      kind: 'expiry', id: i.id, icon: '📦', title: i.name,
      sub: '证件效期 · ' + (l < 0 ? '已过期 ' + (-l) + ' 天' : l === 0 ? '今天到期' : l + ' 天后到期'),
      level: l < 0 ? 'red' : (l <= 2 ? 'yellow' : 'green'), link: '/expiries'
    });
  });
  // 7 天内纪念日 / 生日（showHome=false 的纪念日不上首页，行动流/倒计时区同源过滤）
  rt.db.anniversaries.forEach(a => {
    if (a.showHome === false) return;
    const l = (a.repeat === 'yearly' || a.type === 'count-up') ? daysToNextYearly(a.date) : left(a.date);
    if (l !== null && l <= 7) add(l, {
      kind: 'anniversary', id: a.id, icon: '💖', title: a.title,
      sub: '纪念日 · ' + (l === 0 ? '就是今天' : l + ' 天后'), level: l <= 1 ? 'yellow' : 'green', link: '/anniversaries'
    });
  });
  rt.db.familyMembers.forEach(m => {
    const l = m.birthday ? daysToNextYearly(m.birthday) : null;
    if (l !== null && l <= 7) add(l, {
      kind: 'birthday', id: m.id, icon: m.emoji || '🎂', title: m.name + ' 的生日',
      sub: '家人生日 · ' + (l === 0 ? '就是今天' : l + ' 天后'), level: l <= 1 ? 'yellow' : 'green', link: '/family'
    });
  });
  // 30 天内证件 / 保单
  rt.db.vaultEntries.forEach(e => {
    const l = left(e.expireDate);
    if (l !== null && l <= 30) add(l, {
      kind: 'vault', id: e.id, icon: '🔐', title: e.title,
      sub: '证件保单 · ' + (l < 0 ? '已过期 ' + (-l) + ' 天' : l + ' 天后'),
      level: l < 0 ? 'red' : 'green', link: '/vault'
    });
  });
  // 健康复诊（R02：补进首页聚合）
  rt.db.healthProfiles.forEach(h => {
    const hfm = rt.db.familyMembers.find(x => x.id === h.memberId);
    (h.checkups || []).forEach(c => {
      const l = left(c.nextDate);
      if (l !== null && l <= 7) add(l, {
        kind: 'health', id: c.id, icon: '🩺', title: (hfm ? hfm.name : '家人') + ' · ' + (c.name || '复诊'),
        sub: '健康复诊 · ' + (l < 0 ? '已逾期 ' + (-l) + ' 天' : l === 0 ? '就是今天' : l + ' 天后'),
        level: l < 0 ? 'red' : (l <= 1 ? 'yellow' : 'green'), link: '/health'
      });
    });
  });
  // 贷款还款日（统一引擎补齐此前缺失的模块）
  rt.db.mortgages.forEach(m => {
    const np = mortgageNextPayment(m);
    const l = left(np);
    if (l !== null && l <= 30) add(l, {
      kind: 'mortgage', id: m.id, icon: '🏠', title: (m.name || '贷款') + '还款',
      sub: '贷款还款 · ' + (l === 0 ? '就是今天' : l + ' 天后'),
      level: l === 0 ? 'red' : (l <= 7 ? 'yellow' : 'green'), link: '/mortgage'
    });
  });
  items.sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title)));

  // ---------- 关键指标 ----------
  const overdue = items.filter(i => i.level === 'red').length;
  const month = today.slice(0, 7);
  const curExpense = ledgerSummaryOf(month).expense;
  const prevExpense = ledgerSummaryOf(monthShift(month, -1), { asOfDay: dt.getDate() }).expense;
  const deltaPct = prevExpense > 0 ? Math.round((curExpense - prevExpense) / prevExpense * 100) : null;
  // 预算接入（迭代 3）：设了总预算时，超支/接近上限直接改写指标卡状态
  const totalBudget = ledgerBudgetStatus(month).total;
  // 「30 天内到期」口径：家庭档案 + 证件保单（与标签、落地页一致，不含纪念日/生日）
  const dueItems = [
    ...rt.db.expiryItems.map(i => ({ kind: 'expiry', title: i.name, l: left(i.expiryDate), level: (left(i.expiryDate) || 0) < 0 ? 'red' : 'green' })),
    ...rt.db.vaultEntries.map(e => ({ kind: 'vault', title: e.title, l: left(e.expireDate), level: (left(e.expireDate) || 0) < 0 ? 'red' : 'green' }))
  ].filter(x => x.l !== null && x.l <= 30).sort((a, b) => a.l - b.l);
  const dueCount = dueItems.length;
  const nearestDue = dueItems[0];

  /* 方案A口径：「今天要处理」只收「逾期 + 7 天内」，>7 天远期事件由首页倒计时横幅承接，两区互补不双显。
   * itemTotal 维持 = items.length（v30 A2 契约不变），另增 actionableTotal 供指标卡与前端头部使用。
   * 注意：itemTotal 是「30 天内全部」，绝不能当「今天要处理」用——晨报与小程序曾踩过 */
  const actionableTotal = todayActionItems({ items }).length;

  const metrics = [
    {
      key: 'todo', label: '今天要处理', value: actionableTotal, unit: '件', display: String(actionableTotal),
      level: overdue > 0 ? 'red' : (actionableTotal > 0 ? 'yellow' : 'green'),
      trend: overdue > 0
        ? { dir: 'up', text: '逾期 ' + overdue + ' 件', bad: true }
        : { dir: actionableTotal ? 'flat' : 'down', text: actionableTotal ? '无逾期' : '今天清空', bad: false },
      link: '/tasks', cta: '去处理'
    },
    {
      key: 'expense', label: '本月支出', value: Math.round(curExpense * 100) / 100, unit: '元',
      display: '¥' + curExpense.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      level: totalBudget
        ? (totalBudget.status === 'over' ? 'red' : totalBudget.status === 'warn' ? 'yellow' : 'green')
        : (deltaPct === null ? 'green' : (deltaPct >= 30 ? 'red' : deltaPct >= 10 ? 'yellow' : 'green')),
      trend: totalBudget && totalBudget.status !== 'ok'
        ? { dir: totalBudget.status === 'over' ? 'up' : 'flat', text: '总预算已用 ' + totalBudget.percent + '%', bad: true }
        : (deltaPct === null
          ? { dir: 'flat', text: '上月同期无记录', bad: false }
          : { dir: deltaPct > 0 ? 'up' : (deltaPct < 0 ? 'down' : 'flat'), text: (deltaPct > 0 ? '+' : '') + deltaPct + '% 环比上月同期', bad: deltaPct > 0 }),
      link: '/ledger', cta: '看账本'
    },
    {
      key: 'due', label: '30 天内到期', value: dueCount, unit: '件', display: String(dueCount),
      level: dueCount >= 3 ? 'red' : (dueCount >= 1 ? 'yellow' : 'green'),
      trend: nearestDue
        ? { dir: 'flat', text: '最近：' + nearestDue.title + (nearestDue.l < 0 ? '（已过期 ' + (-nearestDue.l) + ' 天）' : nearestDue.l === 0 ? '（今天到期）' : '（还有 ' + nearestDue.l + ' 天）'), bad: nearestDue.level === 'red' }
        : { dir: 'flat', text: '暂无到期', bad: false },
      link: '/expiries', cta: '查档案'
    }
  ];

  // ---------- 北极星：本周有效记录量 ----------
  const ws = weekStartOf(today);
  const inWeek = (arr, f) => (arr || []).filter(x => { const s = f(x); return s && String(s).slice(0, 10) >= ws; }).length;
  const weekWrites =
    inWeek(rt.db.tasks, x => x.createdAt || x.date) + inWeek(rt.db.notes, x => x.createdAt) +
    inWeek(rt.db.ledgerRecords, x => x.createdAt || x.date) + inWeek(rt.db.giftRecords, x => x.createdAt || x.date) +
    inWeek(rt.db.tracks, x => x.createdAt) + inWeek(rt.db.trackPoints, x => x.time) +
    inWeek(rt.db.fpDiary, x => x.createdAt) + inWeek(rt.db.expiryItems, x => x.createdAt) +
    inWeek(rt.db.anniversaries, x => x.createdAt) + inWeek(rt.db.familyMembers, x => x.createdAt);

  // ---------- 数据健康度：长期空置的模块 ----------
  const cold = [];
  if (!rt.db.ledgerRecords.length) cold.push({ name: '家庭账本', link: '/ledger' });
  if (!rt.db.expiryItems.length && !rt.db.vaultEntries.length) cold.push({ name: '证件效期', link: '/expiries' });
  if (!rt.db.familyMembers.length) cold.push({ name: '家庭成员', link: '/family' });
  if (!rt.db.anniversaries.length) cold.push({ name: '纪念日', link: '/anniversaries' });
  if (!rt.db.tracks.length) cold.push({ name: '位置轨迹', link: '/location' });

  return {
    today, weekday: ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()], month,
    dayType, dayName,
    greeting: dayType === 'holiday' ? (dayName + ' · ' + greetingByHour(new Date().getHours()))
      : (dayType === 'weekend' ? ('周末愉快 · ' + greetingByHour(new Date().getHours()))
      : greetingByHour(new Date().getHours())),
    items, itemTotal: items.length, actionableTotal, actionWindow: ACTION_WINDOW_DAYS, overdue, metrics,
    northStar: { week: weekWrites, target: 15, level: weekWrites >= 15 ? 'green' : (weekWrites >= 8 ? 'yellow' : 'red'), since: ws },
    workFold: !!rt.db.settings.todayWorkFold,   // v43：假期/周末工作事项是否折叠（用户偏好，默认 false）
    cold, aiReady: aiProviderStatus().state === 'ok',
    aiState: aiProviderStatus().state,       // ok | none | bad_model
    aiReason: aiProviderStatus().reason || ''
  };
}

/** 把 AI 解析出的 items 写入对应集合。
 *  返回 { created, failed }：以前只返回 created，落库失败/类型不识别的条目
 *  被 catch 静默吞掉，接口却回 200「已创建 N 项」，用户以为记下了其实没有。
 *  failed 每项含 index/type/title/reason，skipped:true 表示主动合并（非故障）。 */
function applyQuickAdd(items, uid) {
  const today = todayStr();
  const created = [];
  const failed = [];
  const labelOf = it => safeSlice(String((it && (it.title || it.name || it.content || it.person
    || it.remark || it.categoryName || it.eventType)) || ''), 40);
  const safeDate = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : today);
  const safeTime = s => (/^\d{2}:\d{2}$/.test(String(s || '')) ? s : '');
  const num = v => Math.round((+v || 0) * 100) / 100;
  // R05：同一批里已有随礼(gift)项时，跳过独立的人情 ledger 行——gift 已自动折算入总账，避免月报双计
  const hasGift = items.some(it => it && it.type === 'gift' && (+it.amount || 0) > 0);
  items.forEach((it, idx) => {
    if (!it || typeof it !== 'object') {
      failed.push({ index: idx, type: '', title: '', reason: '条目不是有效对象', skipped: false });
      return;
    }
    const before = created.length;
    const failedBefore = failed.length;
    try {
      if (it.type === 'task' && it.title) {
        const row = {
          id: newId(rt.db), title: safeSlice(String(it.title), 80), date: safeDate(it.date), remindTime: safeTime(it.remindTime),
          statusId: 1, color: '', pinned: false, remark: safeSlice(String(it.remark || ''), 200), createdAt: nowStr(), userId: uid
        };
        rt.db.tasks.push(row);
        created.push({ kind: 'task', id: row.id, icon: '📋', title: row.title, sub: row.date + (row.remindTime ? ' ' + row.remindTime : ''), link: '/tasks' });
      } else if (it.type === 'scheduled' && (it.name || it.title)) {
        /* 变量名不能叫 rt：模块级的 rt 是 runtime（rt.db），一旦被这里的字符串
           遮蔽，下面 newId(rt.db) 必抛 TypeError，而外层 catch 又静默吞掉，
           表现为「周期提醒永远建不出来，接口却回 200 说创建成功」。 */
        const ruleType = ['daily', 'weekly', 'monthly', 'yearly'].includes(it.ruleType) ? it.ruleType : 'monthly';
        const row = {
          id: newId(rt.db), name: safeSlice(String(it.name || it.title), 40), ruleType: ruleType,
          ruleValue: String(it.ruleValue || (ruleType === 'monthly' ? today.slice(8, 10) : (ruleType === 'yearly' ? today.slice(5) : '1'))),
          remindTime: safeTime(it.remindTime) || '09:00', enabled: true,
          category: safeSlice(String(it.category || '其他'), 20), intervalValue: 1, intervalUnit: 'month',
          startDate: '', lastRun: '', lastDoneAt: '', doneCount: 0, remark: '', memberId: null, createdAt: nowStr()
        };
        rt.db.scheduledTasks.push(row);
        created.push({ kind: 'scheduled', id: row.id, icon: '🔁', title: row.name, sub: '周期提醒 · ' + row.remindTime, link: '/scheduled-tasks' });
      } else if (it.type === 'anniversary' && it.title) {
        const row = {
          id: newId(rt.db), title: safeSlice(String(it.title), 40), date: safeDate(it.date), type: 'count-down',
          repeat: it.repeat === 'none' ? 'none' : 'yearly', color: '', remark: '', showHome: true, notify: false,
          memberId: null, createdAt: nowStr()
        };
        rt.db.anniversaries.push(row);
        created.push({ kind: 'anniversary', id: row.id, icon: '💖', title: row.title, sub: row.date, link: '/anniversaries' });
      } else if (it.type === 'ledger' && num(it.amount) > 0) {
        // R05：同一批已有随礼项时，跳过人情类的独立记账，避免与 gift 折算重复
        if (hasGift && /人情|随礼|送礼|红包|份子/.test(String(it.categoryName || '') + String(it.remark || ''))) {
          failed.push({ index: idx, type: 'ledger', title: labelOf(it), reason: '已由同批随礼项折算入总账，避免重复记账', skipped: true });
          return;
        }
        const kind = it.kind === 'income' ? 'income' : 'expense';
        /* 迭代 2：AI 给的分类名优先匹配二级（「午餐」比「餐饮」更精确），
           同名只在一级时再退到一级；都匹配不到就留空（记为未分类，不瞎猜）。 */
        const nameWant = it.categoryName ? String(it.categoryName).trim() : '';
        const cat = nameWant
          ? (rt.db.ledgerCategories.find(c => c.kind === kind && c.name === nameWant && c.parentId)
            || rt.db.ledgerCategories.find(c => c.kind === kind && c.name === nameWant && !c.parentId)
            || rt.db.ledgerCategories.find(c => c.kind === kind && nameWant.indexOf(c.name) >= 0))
          : null;
        const row = {
          id: newId(rt.db), createdAt: nowStr(), source: 'ai', date: safeDate(it.date), kind,
          categoryId: cat ? cat.id : null, amount: num(it.amount), method: '', memberId: null,
          remark: safeSlice(String(it.remark || ''), 100),
          /* 迭代 2：一句话录入同样落默认账本 */
          bookId: defaultLedgerBookId()
        };
        rt.db.ledgerRecords.push(row);
        created.push({
          kind: 'ledger', id: row.id, icon: kind === 'income' ? '💰' : '💸',
          title: (kind === 'income' ? '收入 ' : '支出 ') + row.amount + ' 元',
          sub: row.date + (cat ? ' · ' + cat.name : ''), link: '/ledger'
        });
      } else if (it.type === 'gift' && num(it.amount) > 0) {
        const dir = it.direction === 'in' ? 'in' : 'out';
        const pname = safeSlice(String(it.person || '').trim(), 20);
        let person = pname ? rt.db.giftPersons.find(p => p.name === pname) : null;
        if (!person && pname) {
          person = { id: newId(rt.db), name: pname, groupId: null, remark: '', memberId: null };
          rt.db.giftPersons.push(person);
        }
        const row = {
          id: newId(rt.db), personId: person ? person.id : null, relation: '', eventType: safeSlice(String(it.eventType || ''), 20),
          direction: dir, amount: num(it.amount), date: safeDate(it.date), remark: safeSlice(String(it.remark || ''), 100),
          memberId: null, createdAt: nowStr()
        };
        rt.db.giftRecords.push(row);
        created.push({
          kind: 'gift', id: row.id, icon: '🎁',
          title: (dir === 'in' ? '收礼 ' : '随礼 ') + row.amount + ' 元',
          sub: (pname ? pname + ' · ' : '') + row.date, link: '/gift-records'
        });
      } else if (it.type === 'expiry' && it.name) {
        const row = {
          id: newId(rt.db), name: safeSlice(String(it.name), 40), categoryId: null, qty: 1,
          expiryDate: safeDate(it.expiryDate), warrantyUntil: '', location: '', serialNo: '',
          attachments: [], memberId: null, remark: '', createdAt: nowStr()
        };
        rt.db.expiryItems.push(row);
        created.push({ kind: 'expiry', id: row.id, icon: '📦', title: row.name, sub: '到期 ' + row.expiryDate, link: '/expiries' });
      } else if (it.type === 'note' && (it.title || it.content)) {
        const row = {
          id: newId(rt.db), title: safeSlice(String(it.title || safeSlice(String(it.content), 20)), 60),
          content: safeSlice(String(it.content || ''), 2000), format: 'text',
          createdAt: nowStr(), updatedAt: nowStr(), userId: uid
        };
        rt.db.notes.push(row);
        created.push({ kind: 'note', id: row.id, icon: '📝', title: row.title, sub: '备忘手记', link: '/notes' });
      }
    } catch (e) {
      /* 单条失败不影响其余条目，但必须如实上报：以前这里静默吞异常，
         用户看到「已创建 N 项」却少了记录，且无从排查。 */
      failed.push({
        index: idx, type: String(it.type || ''), title: labelOf(it),
        reason: (e && e.message) ? String(e.message) : String(e), skipped: false
      });
    }
    /* 分支正常走完却没有任何写入：类型没被识别，或必需字段缺失
       （task 无 title、ledger 无金额…）。同样算一条未落库，不能算成功。 */
    if (created.length === before && failed.length === failedBefore) {
      failed.push({
        index: idx, type: String(it.type || ''), title: labelOf(it),
        reason: '未识别的记录类型或缺少必要字段（如标题、名称、金额）', skipped: false
      });
    }
  });
  /* 埋点：反映「AI 一句话录入」这条真实用户路径的写入结果。
     按实际落库类型分别计入对应 CORE_ACTIONS，并统一累加 ai.quickadd
     （语义＝该入口产生的有效写入次数，故每条有效写入各 +1）。
     recordActivity 内部已受 db.settings.telemetry 开关控制，关闭时不计数。 */
  const _kindMap = {
    task: 'task.create', ledger: 'ledger.create', anniversary: 'anniversary.create',
    scheduled: 'scheduled.create', expiry: 'expiry.create', note: 'note.create'
  };
  const _counts = {};
  for (const c of created) { const k = _kindMap[c.kind]; if (k) _counts[k] = (_counts[k] || 0) + 1; }
  for (const k of Object.keys(_counts)) recordActivity(k, _counts[k]);
  if (created.length) recordActivity('ai.quickadd', created.length);
  return { created, failed };
}

module.exports = {
  ACTION_WINDOW_DAYS,
  applyQuickAdd,
  buildTodayPayload,
  isTodayTask,
  isUpcomingTask,
  todayActionItems,
};
