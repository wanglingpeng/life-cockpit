/* 晨报与洞察：每日摘要构建、使用洞察、AI 一句话总结。
 *
 * buildDailyDigest 与 buildInsights 共享同一份「当日口径」：digest
 * 是 insights 的上游（insights 的复诊计划、临期等区块都从 digest 取
 * 数），两处各算一遍就会出现「晨报说 3 件事、洞察说 5 件事」。
 *
 * aiInsightCache 是跨请求缓存（按日期 + force 失效），必须**导出**：
 * 路由命中缓存时直接读、未命中时回写，都是对同一个对象引用的读写。
 * 标成 internal 就会让路由拿到一份永远空的快照——它按值导出是个
 * 陷阱，对象引用才是正确形态。
 *
 * aiInsightSummary 与 buildDailyDigest 同模块：AI 总结的输入就是
 * digest，口径分家就会出现「AI 总结的和晨报显示的不是同一份数据」。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区末段）。 */
const rt = require('../core/runtime');
const { moneyVal, monthShift } = require('./utils');
const { buildTodayPayload, todayActionItems } = require('./today');
const { ledgerBudgetStatus, ledgerCatName, ledgerSummaryOf } = require('./ledger');
const { mortgageNextPayment } = require('./family');
const { aiActiveProvider, aiCompleteOnce } = require('./ai');

/**
 * 晨报 2.0：四维聚合（今天 / 钱 / 家底 / 记录）。
 * 推送文案与 AI 洞察共用同一份口径，避免两处算法漂移。
 */
function buildDailyDigest() {
  const t = buildTodayPayload();
  const today = t.today;
  const month = today.slice(0, 7);
  const dt = new Date(today + 'T00:00:00');
  const dayOfMonth = dt.getDate();
  const left = s => (s ? Math.round((new Date(s + 'T00:00:00') - dt) / 86400000) : null);
  const prevMonth = monthShift(month, -1);

  // ---------- 钱 ----------
  /* 统一聚合内核 ledgerSummaryOf：本月（整月）vs 上月截至同日（asOfDay），
   * 与网页/小程序月报同源，杜绝转账/人情/分类口径漂移。 */
  const cur = ledgerSummaryOf(month);
  const prevSame = ledgerSummaryOf(prevMonth, { asOfDay: dayOfMonth });
  const deltaPct = prevSame.expense > 0 ? Math.round((cur.expense - prevSame.expense) / prevSame.expense * 100) : null;

  // 本月最大单笔支出（含人情往来）
  let biggest = null;
  rt.db.ledgerRecords.filter(r => (r.date || '').startsWith(month) && r.kind === 'expense').forEach(r => {
    const amt = +r.amount || 0;
    if (amt > 0 && (!biggest || amt > biggest.amount)) {
      biggest = { amount: amt, name: ledgerCatName(r.categoryId) || '支出', remark: r.remark || '' };
    }
  });
  rt.db.giftRecords.filter(r => (r.date || '').startsWith(month) && r.direction === 'out').forEach(r => {
    const amt = +r.amount || 0;
    const pn = (rt.db.giftPersons.find(p => p.id === r.personId) || {}).name || '';
    if (amt > 0 && (!biggest || amt > biggest.amount)) {
      biggest = { amount: amt, name: '人情 · ' + (pn || '往来'), remark: '' };
    }
  });

  // 分类环比：本月 ≥200 元且环比涨幅最大的分类
  const catDelta = (() => {
    const curCat = {}, prevCat = {};
    rt.db.ledgerRecords.filter(r => (r.date || '').startsWith(month) && r.kind === 'expense')
      .forEach(r => { const k = ledgerCatName(r.categoryId) || '未分类'; curCat[k] = (curCat[k] || 0) + (+r.amount || 0); });
    rt.db.ledgerRecords.filter(r => (r.date || '').startsWith(prevMonth) && r.kind === 'expense')
      .forEach(r => { const k = ledgerCatName(r.categoryId) || '未分类'; prevCat[k] = (prevCat[k] || 0) + (+r.amount || 0); });
    const rows = [];
    Object.keys(curCat).forEach(k => {
      const c = curCat[k], pv = prevCat[k] || 0;
      if (c < 200) return;
      if (pv === 0) { rows.push({ name: k, cur: c, prev: 0, pct: null }); return; }
      const pct = Math.round((c - pv) / pv * 100);
      if (pct >= 50) rows.push({ name: k, cur: c, prev: pv, pct });
    });
    rows.sort((a, b) => (b.pct === null ? 99999 : b.pct) - (a.pct === null ? 99999 : a.pct));
    return rows[0] || null;
  })();

  const recordCount = rt.db.ledgerRecords.filter(r => (r.date || '').startsWith(month)).length
    + rt.db.giftRecords.filter(r => (r.date || '').startsWith(month)).length;

  // 预算执行（迭代 3）：与账本汇总同口径，超支/接近上限进晨报与洞察
  const bstat = ledgerBudgetStatus(month);

  // ---------- 家底：30 天内到期 ----------
  const due = [];
  rt.db.expiryItems.forEach(i => { const l = left(i.expiryDate); if (l !== null && l <= 30) due.push({ title: i.name || '档案', days: l, kind: '档案' }); });
  rt.db.vaultEntries.forEach(e => { const l = left(e.expireDate); if (l !== null && l <= 30) due.push({ title: e.title || '证件保单', days: l, kind: '证件' }); });
  rt.db.mortgages.forEach(m => { const l = left(mortgageNextPayment(m)); if (l !== null && l <= 30) due.push({ title: (m.name || '贷款') + '还款', days: l, kind: '还款' }); });
  rt.db.healthProfiles.forEach(h => {
    const hfm = rt.db.familyMembers.find(x => x.id === h.memberId);
    (h.checkups || []).forEach(c => {
      const l = left(c.nextDate);
      if (l !== null && l <= 30) due.push({ title: (hfm ? hfm.name + '·' : '') + (c.name || '复诊'), days: l, kind: '健康' });
    });
  });
  due.sort((a, b) => a.days - b.days);

  // ---------- 家底规模 ----------
  const assetTotal = Math.round(rt.db.assets.reduce((s, a) => s + (+a.amount || 0), 0));
  const debtTotal = Math.round(rt.db.mortgages.reduce((s, m) => s + (+m.principal || 0) * 10000, 0)
    + rt.db.otherDebts.reduce((s, d) => s + (+d.amount || 0), 0));

  return {
    date: today,
    weekday: t.weekday,
    greeting: t.greeting,
    todo: { total: t.actionableTotal, overdue: t.overdue, top: todayActionItems(t) },
    money: {
      month, expense: cur.expense, income: cur.income,
      deltaPct, prevExpense: prevSame.expense,
      biggest, catDelta, recordCount,
      budget: {
        over: bstat.budgets.filter(b => b.status === 'over').map(b => ({ name: b.categoryName, percent: b.percent, spent: b.spent, amount: b.amount })),
        warn: bstat.budgets.filter(b => b.status === 'warn').map(b => ({ name: b.categoryName, percent: b.percent, spent: b.spent, amount: b.amount })),
        total: bstat.total ? { percent: bstat.total.percent, spent: bstat.total.spent, amount: bstat.total.amount } : null
      }
    },
    asset: {
      due, dueCount: due.length,
      urgent: due.filter(x => x.days <= 7),
      hasNetworth: (assetTotal + debtTotal) > 0,
      assetTotal, debtTotal, net: assetTotal - debtTotal
    },
    habit: { week: t.northStar.week, target: t.northStar.target, level: t.northStar.level },
    cold: t.cold
  };
}

/**
 * 规则型家庭洞察：不依赖 AI，永远可用。
 * level：red（要处理）/ yellow（留意）/ info（建议）
 */
function buildInsights(digest) {
  const d = digest || buildDailyDigest();
  const out = [];
  const add = (level, icon, title, detail, link) => out.push({ level, icon, title, detail, link });
  const f = moneyVal;

  // 1) 逾期事务
  if (d.todo.overdue > 0) {
    const first = d.todo.top.find(i => i.level === 'red');
    add('red', '⚠️', d.todo.overdue + ' 件事务已逾期',
      first ? ('最早：' + first.title + '，' + first.sub) : '去日历事务里处理一下', '/tasks');
  }
  // 2) 支出环比
  if (d.money.deltaPct !== null && d.money.deltaPct >= 15) {
    add(d.money.deltaPct >= 30 ? 'red' : 'yellow', '💰', '本月支出比上月同期高 ' + d.money.deltaPct + '%',
      '本月 ¥' + f(d.money.expense) + '，上月同期 ¥' + f(d.money.prevExpense), '/ledger');
  }
  // 2b) 预算执行（迭代 3）：超支红 / 接近上限黄
  const bov = d.money.budget ? d.money.budget.over : [];
  const bwn = d.money.budget ? d.money.budget.warn : [];
  if (bov.length) {
    add('red', '🎯',
      bov.map(b => b.name).join('、') + (bov.length > 1 ? ' 等预算已超支' : ' 预算已超支'),
      bov.map(b => b.name + ' 已用 ' + b.percent + '%（¥' + f(b.spent) + '/¥' + f(b.amount) + '）').join('；'),
      '/ledger');
  } else if (bwn.length) {
    const w0 = bwn[0];
    add('yellow', '🎯',
      w0.name + ' 预算已用 ' + w0.percent + '%',
      (bwn.length > 1 ? '另有 ' + (bwn.length - 1) + ' 个分类接近上限；' : '') + '剩余 ¥' + f(w0.amount - w0.spent) + '，节奏留意', '/ledger');
  }
  // 3) 单个分类暴涨
  if (d.money.catDelta) {
    const c = d.money.catDelta;
    add('yellow', '📈',
      c.pct === null ? ('本月新增「' + c.name + '」支出') : (c.name + ' 环比上涨 ' + c.pct + '%'),
      c.pct === null ? ('本月 ¥' + f(c.cur) + '，上月无记录') : ('本月 ¥' + f(c.cur) + '，上月 ¥' + f(c.prev)), '/ledger');
  }
  // 4) 大额单笔
  if (d.money.biggest && d.money.biggest.amount >= 1000) {
    add('info', '🧾', '本月最大一笔：' + d.money.biggest.name,
      '¥' + f(d.money.biggest.amount) + (d.money.biggest.remark ? '（' + d.money.biggest.remark + '）' : ''), '/ledger');
  }
  // 5) 到期：过期 / 2 天内 / 30 天内
  const expired = d.asset.urgent.filter(x => x.days < 0);
  const verySoon = d.asset.urgent.filter(x => x.days >= 0 && x.days <= 2);
  if (expired.length) {
    add('red', '📦', expired.length + ' 件档案已过期', expired.slice(0, 3).map(x => x.title).join('、'), '/expiries');
  } else if (verySoon.length) {
    add('red', '📦', verySoon.length + ' 件 2 天内到期',
      verySoon.map(x => x.title + '（' + (x.days === 0 ? '今天' : x.days + ' 天后') + '）').join('、'), '/expiries');
  } else if (d.asset.dueCount) {
    add('yellow', '📦', '30 天内有 ' + d.asset.dueCount + ' 件到期',
      d.asset.due.slice(0, 3).map(x => x.title + '（' + x.days + ' 天后）').join('、'), '/expiries');
  }
  // 6) 还款临近
  const pay = d.asset.due.find(x => x.kind === '还款' && x.days <= 7);
  if (pay) {
    add(pay.days <= 1 ? 'red' : 'yellow', '🏠',
      pay.title + (pay.days < 0 ? ' 已逾期' : pay.days === 0 ? ' 就是今天' : ' ' + pay.days + ' 天后'),
      '记得提前准备资金', '/mortgage');
  }
  // 7) 健康复诊逾期
  const hz = d.asset.due.find(x => x.kind === '健康' && x.days < 0);
  if (hz) add('yellow', '🩺', hz.title + ' 已逾期 ' + (-hz.days) + ' 天', '健康复查别拖', '/health');
  // 8) 收支倒挂
  if (d.money.income > 0 && d.money.expense > d.money.income) {
    add('yellow', '⚖️', '本月支出已超收入', '支出 ¥' + f(d.money.expense) + '，收入 ¥' + f(d.money.income), '/ledger');
  }
  // 9) 本月未记账
  if (!d.money.recordCount) add('info', '✍️', '本月还没有记账', '记一笔，账本才有意义', '/ledger');
  // 10) 空置模块
  d.cold.slice(0, 3).forEach(c => add('info', '🌱', c.name + '还是空的', '补一条就能开始积累', c.link));

  const rank = { red: 0, yellow: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return out.slice(0, 6);
}

/* P1-3：AI 一句话摘要按天内存缓存（单用户产品，无需 per-user；重启清空，跨天自动重建）
   key 用 digest.date（与 todayStr() 同本地时区口径），避免 UTC 偏移导致 key 错乱。
   取舍：key 只含日期，故同一天内即使 digest 内容变化也命中同一缓存 —— 摘要为「缓存生成时刻」快照，
   当天新记账不体现（PRD 已接受，页面刷新按钮 ?refresh=1 兜底）。
   （本条注释在 server.js 孤儿状态下躺了整个抽取期，随本次清理归位。） */
const aiInsightCache = { date: '', summary: '', aiUsed: false, generatedAt: '' };

/** AI 一句话洞察（未配置 AI 或失败时返回空串，不阻塞主流程） */
async function aiInsightSummary(digest) {
  if (!aiActiveProvider()) return '';
  const d = digest;
  const lines = [
    '日期：' + d.date,
    '今天要处理 ' + d.todo.total + ' 件（逾期 ' + d.todo.overdue + '）',
    '本月支出 ¥' + d.money.expense.toFixed(2) + (d.money.deltaPct !== null ? '，较上月同期 ' + (d.money.deltaPct > 0 ? '+' : '') + d.money.deltaPct + '%' : ''),
    '本月收入 ¥' + d.money.income.toFixed(2),
    '30 天内到期 ' + d.asset.dueCount + ' 件',
    d.asset.hasNetworth ? ('净资产 ¥' + d.asset.net) : '尚未录入资产负债',
    '本周记录 ' + d.habit.week + '/' + d.habit.target + ' 条'
  ];
  const sys = '你是「生活驾驶舱」的家庭生活助手。根据给定数据，用一句不超过 40 字的中文，指出今天最值得关注的一件事，或给一个具体建议。'
    + '要求：具体、可执行、说人话；不复述全部数字；不要客套；不要 Markdown；不要引号。';
  try {
    const s = await aiCompleteOnce(lines.join('\n'), sys, 0.5, 'insights');
    return String(s || '').replace(/[\r\n]+/g, ' ').replace(/^["「『]|["」』]$/g, '').trim().slice(0, 80);
  } catch (e) { return ''; }
}

module.exports = {
  aiInsightCache,
  aiInsightSummary,
  buildDailyDigest,
  buildInsights,
};
