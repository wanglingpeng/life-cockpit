/* 家庭账本：字段整形、月度汇总、预算状态、账户余额、净资产。
 *
 * 汇总口径是本模块的硬约束：ledgerSummaryOf 的 expense / income / net
 * 等字段语义被 5 处服务端消费 + 小程序共用，改一个
 * 数字的下溢入口就会三边不一致。ledgerBudgetStatus 的口径与它完全
 * 同源（硬性：绝不另算一遍），所以这两个函数必须同模块，拆开就会
 * 出现「预算百分比和汇总总额对不上」——而这种不一致没有任何测试
 * 能发现，因为两边各自都是「对的」。
 *
 * 余额不落盘、由流水实时推导（ledgerAccountBalances）：落盘余额会
 * 与流水漂移，而漂移不报错，只是账目对不上。
 *
 * defaultLedgerBookId 原在 F7 区（库迁移建默认账本用），随本模块
 * 搬迁：它是账本概念，且 ledgerFields / 记账路由都要用。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原散在 F7 区与「家人档案 / 家庭账本 辅助」区）。 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');
const rt = require('../core/runtime');
const { saveDb } = require('./db-io');
const { newId, round2, safeSlice, todayStr } = require('./utils');

function defaultLedgerBookId() {
  const b = rt.db.ledgerBooks.find(x => x.name === '日常账本') || rt.db.ledgerBooks[0];
  return b ? b.id : null;
}

function ledgerFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  const intOrNull = (v, d) => (v === undefined ? d : (v ? +v : null));
  /* 转账是第三种 kind：不计收入、不计支出，只改两个账户的余额 */
  const rawKind = pick('kind', 'expense');
  const kind = (rawKind === 'income' || rawKind === 'transfer') ? rawKind : 'expense';
  return {
    date: pick('date', todayStr()) || todayStr(),
    kind,
    categoryId: kind === 'transfer' ? null : intOrNull(body.categoryId, isNew ? null : cur.categoryId),
    amount: Math.abs(+pick('amount', 0)) || 0,
    method: pick('method', '') || '',
    memberId: intOrNull(body.memberId, isNew ? null : cur.memberId),
    remark: pick('remark', '') || '',
    /* accountId：支出/收入的所属账户；转账时为「转出账户」 */
    accountId: intOrNull(body.accountId, isNew ? null : cur.accountId),
    /* toAccountId：仅转账使用，表示「转入账户」 */
    toAccountId: kind === 'transfer' ? intOrNull(body.toAccountId, isNew ? null : cur.toAccountId) : null,
    /* bookId：归属场景账本（迭代 2）；缺省落日常账本，避免出现无归属流水 */
    bookId: intOrNull(body.bookId, isNew ? defaultLedgerBookId() : cur.bookId),
    /* source：流水来源（manual/quickdrawer/quickadd/import 等），仅接受字符串，缺省沿用原值 */
    source: (typeof pick('source', '') === 'string' && pick('source', '')) ? safeSlice(String(pick('source', '')), 32) : (isNew ? 'manual' : (cur.source || 'manual'))
  };
}

/* =================== 晨报 2.0：四维聚合 + 家庭洞察 =================== */
/** 账本分类名（按 id 查） */
function ledgerCatName(id) {
  const c = rt.db.ledgerCategories.find(x => x.id === id);
  return c ? (c.name || '') : '';
}

/* 账本唯一聚合内核：网页月报 / 小程序月报 / 晨报环比 / 首页今日卡 / 预算 全部走它，
 * 杜绝「转账/人情/分类明细」口径漂移（历史上曾出现网页 ¥7,145 / 小程序 ¥5,347 的跨端口径不一致）。
 * opts.asOfDay：非空正整数时只汇总到当月第 asOfDay 天（MTD）；0/缺省=整月。
 * 转账（kind==='transfer'）一律不计入 expense/income（只改账户余额），与账本总预算同规则。 */
function ledgerSummaryOf(month, opts) {
  const bookId = opts && opts.bookId ? +opts.bookId : null;
  const asOfDay = opts && opts.asOfDay ? parseInt(opts.asOfDay, 10) || 0 : 0;
  const inBook = r => !bookId || r.bookId === bookId;
  const dayOk = r => !asOfDay || (parseInt((r.date || '').slice(8, 10), 10) || 0) <= asOfDay;
  const recs = rt.db.ledgerRecords.filter(r => inBook(r) && (!month || (r.date || '').startsWith(month)) && dayOk(r));
  const gifts = bookId ? [] : rt.db.giftRecords.filter(r => (!month || (r.date || '').startsWith(month)) && dayOk(r));
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  const manualExpense = sum(recs.filter(r => r.kind === 'expense'), r => +r.amount || 0);
  const manualIncome = sum(recs.filter(r => r.kind === 'income'), r => +r.amount || 0);
  const giftExpense = sum(gifts.filter(r => r.direction === 'out'), r => +r.amount || 0);
  const giftIncome = sum(gifts.filter(r => r.direction === 'in'), r => +r.amount || 0);
  const expense = manualExpense + giftExpense;
  const income = manualIncome + giftIncome;

  const build = kind => {
    const total = kind === 'expense' ? expense : income;
    const pct = a => (total ? Math.round(a / total * 1000) / 10 : 0);
    const parents = rt.db.ledgerCategories.filter(c => c.kind === kind && !c.parentId);
    /* 能把金额落到某个一级行上的分类 id（一级自身 + 挂在其下且父级仍在的二级）。
       不在这两个集合里的 categoryId 一律计入「未分类」，保证「各分类合计 ≡ 总额」恒成立。 */
    const owned = new Set();
    parents.forEach(p => {
      owned.add(p.id);
      rt.db.ledgerCategories.filter(c => c.parentId === p.id).forEach(c => owned.add(c.id));
    });
    const rows = parents.map(p => {
      const kids = rt.db.ledgerCategories.filter(c => c.parentId === p.id);
      const own = sum(recs.filter(r => r.kind === kind && r.categoryId === p.id), r => +r.amount || 0);
      const children = kids.map(k => ({
        id: k.id, name: k.name, icon: k.icon,
        amount: sum(recs.filter(r => r.kind === kind && r.categoryId === k.id), r => +r.amount || 0)
      })).filter(k => k.amount > 0).sort((a, b) => b.amount - a.amount);
      const kidSum = children.reduce((s, k) => s + k.amount, 0);
      const amount = own + kidSum;
      children.forEach(k => { k.percent = pct(k.amount); });
      return { id: p.id, name: p.name, icon: p.icon, amount, percent: pct(amount), auto: false, children };
    }).filter(r => r.amount > 0);
    const giftAmount = kind === 'expense' ? giftExpense : giftIncome;
    if (giftAmount > 0) {
      rows.push({ id: 'gift', name: '人情往来', icon: '🎁', amount: giftAmount, percent: pct(giftAmount), auto: true, children: [] });
    }
    /* 未分类：流水没有 categoryId（或指向已删除分类）时，金额仍计入总额，
       必须在明细里显式列出来，否则「各分类合计」永远对不上「支出总额」。 */
    const unclassified = sum(recs.filter(r => r.kind === kind && !owned.has(r.categoryId)), r => +r.amount || 0);
    if (unclassified > 0) {
      rows.push({ id: 'uncategorized', name: '未分类', icon: '❓', amount: unclassified, percent: pct(unclassified), auto: false, children: [] });
    }
    rows.sort((a, b) => b.amount - a.amount);
    return rows;
  };
  return {
    month: month || '',
    expense, income, net: income - expense,
    manualExpense, manualIncome, giftExpense, giftIncome,
    /* count / manualCount 的口径保持不变（含转账笔数），只新增 transferCount 供前端区分。
       支出与收入金额一律不含转账——转账只改账户余额，不改收支。 */
    count: recs.length + gifts.length,
    manualCount: recs.length, giftCount: gifts.length,
    transferCount: recs.filter(r => r.kind === 'transfer').length,
    /* 新增：本次汇总的作用域（bookId 为 null 表示全账本） */
    bookId: bookId || null,
    byCategory: { expense: build('expense'), income: build('income') }
  };
}

/* ==================== 月度预算（迭代 3） ====================
 * 口径（硬性）：与 ledgerSummaryOf 完全同源，绝不另算一遍——
 *   分类预算 spent = summary.byCategory.expense 里该一级行的金额（已含其二级与「直属流水」）；
 *   总预算 spent   = summary.expense（含人情往来：人情是家庭级支出，理应被总预算管住）。
 *   转账不计入任何预算（与收支同规则）。
 * 状态阈值：percent <80 ok；80～<100 warn（黄色）；>=100 over（红色）。
 * spent 永远实时推导，预算记录里只存 amount。
 */
function ledgerBudgetStatus(month) {
  const budgets = (rt.db.ledgerBudgets || []).filter(b => b.month === month);
  if (!budgets.length) return { month, budgets: [], total: null, expense: 0, overCount: 0, warnCount: 0 };
  const sum = ledgerSummaryOf(month);
  const catRow = id => sum.byCategory.expense.find(r => r.id === id) || null;
  const rows = budgets.map(b => {
    const row = b.categoryId ? catRow(b.categoryId) : null;
    const spent = b.categoryId ? (row ? row.amount : 0) : sum.expense;
    const percent = b.amount > 0 ? Math.round(spent / b.amount * 1000) / 10 : 0;
    const status = percent >= 100 ? 'over' : (percent >= 80 ? 'warn' : 'ok');
    const c = b.categoryId ? rt.db.ledgerCategories.find(x => x.id === b.categoryId) : null;
    return {
      id: b.id, month: b.month, categoryId: b.categoryId || null,
      categoryName: c ? c.name : '总预算', icon: c ? (c.icon || '🏷') : '🎯',
      amount: round2(b.amount), spent: round2(spent), percent, status,
      remaining: round2(b.amount - spent), createdAt: b.createdAt
    };
  }).sort((a, b) => b.percent - a.percent || a.id - b.id);
  const total = rows.find(r => r.categoryId === null) || null;
  return {
    month,
    budgets: rows,
    total,
    expense: round2(sum.expense),
    overCount: rows.filter(r => r.status === 'over').length,
    warnCount: rows.filter(r => r.status === 'warn').length
  };
}

function ledgerAccountBalances(month) {
  const map = new Map();
  rt.db.ledgerAccounts.forEach(a => map.set(a.id, {
    id: a.id, name: a.name, type: a.type, icon: a.icon || '', color: a.color || '',
    initialBalance: round2(a.initialBalance),
    includeInNetWorth: a.includeInNetWorth !== false,
    balance: round2(a.initialBalance),
    monthIncome: 0, monthExpense: 0, monthTransferIn: 0, monthTransferOut: 0, monthRecordCount: 0
  }));
  const inMonth = r => !month || (r.date || '').startsWith(month);
  rt.db.ledgerRecords.forEach(r => {
    const amt = +r.amount || 0;
    if (!amt) return;
    const isM = inMonth(r);
    if (r.kind === 'transfer') {
      const out = map.get(r.accountId), inn = map.get(r.toAccountId);
      if (out) { out.balance -= amt; if (isM) { out.monthTransferOut += amt; out.monthRecordCount++; } }
      if (inn) { inn.balance += amt; if (isM) { inn.monthTransferIn += amt; } }
      return;
    }
    const acc = map.get(r.accountId);
    if (!acc) return;                       // 未指定账户的流水：不影响任何账户余额
    if (r.kind === 'income') { acc.balance += amt; if (isM) { acc.monthIncome += amt; acc.monthRecordCount++; } }
    else { acc.balance -= amt; if (isM) { acc.monthExpense += amt; acc.monthRecordCount++; } }
  });
  const accounts = Array.from(map.values()).map(a => Object.assign(a, {
    balance: round2(a.balance),
    monthIncome: round2(a.monthIncome), monthExpense: round2(a.monthExpense),
    monthTransferIn: round2(a.monthTransferIn), monthTransferOut: round2(a.monthTransferOut),
    /* 当月净变动（含转账），用于账户卡片上的「本月 +/−」 */
    monthDelta: round2(a.monthIncome - a.monthExpense + a.monthTransferIn - a.monthTransferOut)
  }));
  /* 只统计「计入净资产」的账户：正余额算资产、负余额算负债（信用卡欠款） */
  let ledgerAssets = 0, ledgerDebts = 0;
  accounts.forEach(a => {
    if (!a.includeInNetWorth) return;
    if (a.balance >= 0) ledgerAssets += a.balance; else ledgerDebts += -a.balance;
  });
  const unassignedCount = rt.db.ledgerRecords.filter(r => r.kind !== 'transfer' && !r.accountId).length;
  return {
    month: month || '',
    accounts,
    ledgerAssets: round2(ledgerAssets),
    ledgerDebts: round2(ledgerDebts),
    ledgerNetWorth: round2(ledgerAssets - ledgerDebts),
    unassignedCount
  };
}

/* ==================== 家庭净资产（唯一权威口径，全站共用） ====================
 * 口径（硬性，禁止任何页面/接口自行重算）：
 *   资产 = 家底手工资产（db.assets） + 账本账户正余额（ledgerAssets）
 *   负债 = 账本账户负余额（ledgerDebts：信用卡/钱包欠款） + 房贷本金 + 其他负债
 *   净资产 = 资产 − 负债
 *
 * 为什么必须把账本账户算进来：账户余额是由流水实时推导的真实存量。若只算手工资产，
 * 家庭账本页会出现「总资产 15,100 − 总负债 816,325.80 ≠ 所示净资产」的自相矛盾；
 * 而首页/家底总览/生活月报又会给出另一个数——同一个词两个答案，用户只会认为算错了。
 *
 * 返回 ledgerNetWorth / manualAssets 等分量，供页面把「账本口径」作为明细并排展示，
 * 而不是各自再算一遍总额。
 */
/* 手工资产类型枚举（db.assets[].type）：finance.routes.js 两处消费——
   集合 POST 与 :id PUT 写入时校验（不认识的类型回落 'other'）。
   从 server.js 混合块搬入——它与 computeNetWorth 同属净资产域，且
   「类型清单」与「汇总口径」分开两地就会出现新增类型只改一边
   （写得进、汇总里没有分组），不报错。 */
const ASSET_TYPES = ['deposit', 'fund', 'stock', 'gold', 'cash', 'house', 'vehicle', 'invest', 'receivable', 'other'];

function computeNetWorth() {
  const b = ledgerAccountBalances('');            // 传空 month = 全量推导（存量概念）
  const manualAssets = round2(rt.db.assets.reduce((s, a) => s + (+a.amount || 0), 0));
  const mortgageDebt = round2(rt.db.mortgages.reduce((s, m) => s + (+m.principal || 0) * 10000, 0)); // principal 单位万元
  const otherDebts = round2(rt.db.otherDebts.reduce((s, d) => s + (+d.amount || 0), 0));
  const assetTotal = round2(manualAssets + b.ledgerAssets);
  const debtTotal = round2(b.ledgerDebts + mortgageDebt + otherDebts);
  return {
    manualAssets,
    ledgerAssets: b.ledgerAssets,
    ledgerDebts: b.ledgerDebts,
    ledgerNetWorth: b.ledgerNetWorth,
    mortgageDebt,
    otherDebts,
    assetTotal,
    debtTotal,
    net: round2(assetTotal - debtTotal),
    accountCount: b.accounts.filter(a => a.includeInNetWorth !== false).length,
    accountTotal: b.accounts.length
  };
}

/* ---------------- 默认数据播种与历史结构迁移 ----------------
 * 为什么和上面的汇总函数同模块：三件事共享同一份账本结构定义——
 * LEDGER_DEFAULT_CATS / BOOK_PRESETS / ACCOUNTS 是「新库长什么样」，
 * ensure* 是「旧库缺什么补什么」，migrate*Once 是「旧结构怎么搬到新结构」。
 * 拆开就会出现「预置分类在播种里改了名、迁移校验还认旧名」——两边各自
 * 是对的，合起来校验不过或静默漏迁，没有任何测试能发现。
 * 备份先行是硬规则：两个 migrate*Once 都在任何改动之前先落一份
 * db-before-*，失败即整体中止——不可回滚的结构变更不做。
 *
 * 从 server.js 搬入（原 F7 区尾段，与 db-lifecycle 的 schema 迁移相邻
 * 但属账本域：migrateDb 管「键存在不存在」，这里管「账本数据长什么样」）。 */

const LEDGER_DEFAULT_CATS = {
  expense: [['餐饮', '🍚'], ['日用', '🧺'], ['交通', '🚗'], ['居住', '🏠'], ['医疗', '💊'],
    ['教育', '📚'], ['人情', '🎁'], ['娱乐', '🎬'], ['服饰', '👕'], ['其他', '📦']],
  income: [['工资', '💼'], ['奖金', '🏆'], ['理财', '📈'], ['红包', '🧧'], ['其他', '💰']]
};

function ensureLedgerCategories() {
  if (rt.db.ledgerCategories.length > 0) return;
  Object.keys(LEDGER_DEFAULT_CATS).forEach(kind =>
    LEDGER_DEFAULT_CATS[kind].forEach(([name, icon]) =>
      rt.db.ledgerCategories.push({ id: newId(rt.db), name, icon, kind, builtin: true })));
  saveDb();
}

/* ==================== 账本二级分类（迭代 2） ====================
 * 已有一级分类的 id / name / icon / kind 一律不动（历史流水零改动），只补 parentId/sort/archived。
 * 新增一级分类用「名称+kind」判重，二级分类用「名称 + parentId」判重，全部幂等。
 */
const LEDGER_NEW_PARENT_CATS = [['育儿', '👶'], ['宠物', '🐾']];

const LEDGER_CHILD_CATS = {
  'expense|餐饮': [['早餐', '🥣'], ['午餐', '🍱'], ['晚餐', '🍲'], ['夜宵', '🌙'], ['外卖', '🛵'], ['食材', '🥬'], ['零食饮料', '🥤'], ['下馆子', '🍜']],
  'expense|日用': [['日用品', '🧴'], ['清洁', '🧽'], ['纸品', '🧻'], ['小家电', '🔌']],
  'expense|交通': [['公交', '🚌'], ['地铁', '🚇'], ['打车', '🚕'], ['加油', '⛽'], ['停车', '🅿️'], ['过路费', '🛣'], ['维修保养', '🔧']],
  'expense|居住': [['房租', '🏘'], ['房贷', '🏦'], ['水电', '💡'], ['燃气', '🔥'], ['物业', '🏢'], ['宽带', '🌐']],
  'expense|医疗': [['门诊', '🩺'], ['药品', '💊'], ['体检', '📋'], ['住院', '🏥'], ['牙科', '🦷']],
  'expense|教育': [['学费', '🎓'], ['培训', '📖'], ['书籍', '📕'], ['文具', '✏️'], ['兴趣班', '🎨']],
  'expense|人情': [['红白喜事', '🎊'], ['送礼', '🎁'], ['请客', '🍽'], ['探病', '💐']],
  'expense|娱乐': [['电影', '🎦'], ['游戏', '🎮'], ['旅行', '🧳'], ['运动', '🏃'], ['订阅会员', '📺']],
  'expense|服饰': [['衣服', '👔'], ['鞋帽', '👟'], ['箱包', '👜'], ['化妆护肤', '💄']],
  'expense|育儿': [['奶粉', '🍼'], ['尿不湿', '🧷'], ['玩具', '🧸'], ['童装', '👶'], ['早教', '🧩']],
  'expense|宠物': [['粮', '🐾'], ['医疗', '💉'], ['用品', '🪀']],
  'expense|其他': [['未分类', '❓'], ['手续费', '🏷'], ['罚款', '⚠️']],
  'income|工资': [['基本工资', '💼'], ['绩效', '📊'], ['加班费', '⏰']],
  'income|奖金': [['年终奖', '🏆'], ['项目奖', '🎖']],
  'income|理财': [['利息', '💰'], ['分红', '📈'], ['基金收益', '📉']],
  'income|红包': [['红包', '🧧'], ['压岁钱', '🎊'], ['退款', '↩️'], ['报销回款', '🧾']]
};

/* 场景账本：装修/旅行这类一次性大额开销混在日常流水里会让「本月支出」失去参考价值 */
const LEDGER_BOOK_PRESETS = [
  ['日常账本', '🏠', 'daily', '#0ea5e9'],
  ['家庭账本', '👨👩👧', 'family', '#22c55e'],
  ['装修账本', '🛠', 'project', '#f59e0b'],
  ['旅行账本', '✈️', 'travel', '#8b5cf6']
];

const LEDGER_BOOK_KINDS = ['daily', 'family', 'project', 'travel', 'child', 'vehicle', 'big-ticket', 'other'];

function ensureLedgerPresetCategories() {
  let changed = false;
  const findTop = (name, kind) => rt.db.ledgerCategories.find(c => c.name === name && c.kind === kind && !c.parentId);
  /* 1) 现有分类补齐层级字段（只在缺失时写，保持幂等；id 一律不动） */
  let sort = 0;
  rt.db.ledgerCategories.filter(c => !c.parentId).forEach(c => {
    if (c.parentId === undefined) { c.parentId = null; changed = true; }
    if (c.sort === undefined) { c.sort = sort; changed = true; }
    if (c.archived === undefined) { c.archived = false; changed = true; }
    sort++;
  });
  /* 2) 补新增的一级分类 */
  LEDGER_NEW_PARENT_CATS.forEach(([name, icon], i) => {
    if (!findTop(name, 'expense')) {
      rt.db.ledgerCategories.push({ id: newId(rt.db), name, icon, kind: 'expense', builtin: true, parentId: null, sort: sort + i, archived: false });
      changed = true;
    }
  });
  /* 3) 补二级分类：按「名称 + parentId」判重 */
  Object.keys(LEDGER_CHILD_CATS).forEach(key => {
    const [kind, pname] = key.split('|');
    const parent = findTop(pname, kind);
    if (!parent) return;
    LEDGER_CHILD_CATS[key].forEach(([name, icon], i) => {
      const exists = rt.db.ledgerCategories.some(c => c.name === name && c.parentId === parent.id);
      if (!exists) {
        rt.db.ledgerCategories.push({ id: newId(rt.db), name, icon, kind, builtin: true, parentId: parent.id, sort: i, archived: false });
        changed = true;
      }
    });
  });
  if (changed) saveDb();
  return changed;
}

function ensureLedgerBooks() {
  let changed = false;
  LEDGER_BOOK_PRESETS.forEach(([name, icon, kind, color], i) => {
    if (rt.db.ledgerBooks.some(b => b.name === name)) return;
    rt.db.ledgerBooks.push({ id: newId(rt.db), name, icon, color, kind, memberIds: [], archived: false, sort: i, builtin: true });
    changed = true;
  });
  if (changed) saveDb();
  return changed;
}

/* ==================== 账本账户（迭代 1） ====================
 * 账户是账本地基：没有账户实体，钱从哪来、到哪去、还剩多少都答不上。
 * 余额一律由流水实时推导（见 ledgerAccountBalances），不落盘，避免余额与流水对不上。
 */
const LEDGER_DEFAULT_ACCOUNTS = [
  ['现金', 'cash', '💵'],
  ['招行储蓄卡', 'debit', '🏦'],
  ['信用卡', 'credit', '💳'],
  ['微信钱包', 'ewallet', '💚'],
  ['支付宝', 'ewallet', '🐜'],
  ['余额宝', 'investment', '📈']
];

const LEDGER_ACCOUNT_TYPES = ['cash', 'debit', 'credit', 'ewallet', 'investment', 'other'];

function ensureLedgerAccounts() {
  if (rt.db.ledgerAccounts.length > 0) return;
  LEDGER_DEFAULT_ACCOUNTS.forEach(([name, type, icon]) =>
    rt.db.ledgerAccounts.push({
      id: newId(rt.db), name, type, icon, color: '',
      initialBalance: 0, includeInNetWorth: true, remark: '', builtin: true
    }));
  saveDb();
}

/**
 * 历史流水的账户回填（幂等）。
 * 只在「支付方式自由文本能唯一对应到某个预置账户」时回填，其余留 null 表示未指定账户，
 * 绝不猜测归属——把没写支付方式的流水硬塞进某个账户会直接算错余额。
 */
const METHOD_TO_ACCOUNT = {
  微信: '微信钱包', 微信支付: '微信钱包', 支付宝: '支付宝',
  银行卡: '招行储蓄卡', 储蓄卡: '招行储蓄卡', 信用卡: '信用卡',
  现金: '现金', 余额宝: '余额宝'
};

function backfillRecordAccounts() {
  if (!rt.db.ledgerRecords.length || !rt.db.ledgerAccounts.length) return { scanned: 0, filled: 0 };
  const idByAccountName = {};
  rt.db.ledgerAccounts.forEach(a => { idByAccountName[a.name] = a.id; });
  let scanned = 0, filled = 0;
  rt.db.ledgerRecords.forEach(r => {
    if (r.accountId !== undefined) return;   // 幂等：处理过即跳过
    scanned++;
    r.accountId = null;
    if (r.kind === 'transfer') {
      if (r.toAccountId === undefined) r.toAccountId = null;
      return;
    }
    const target = METHOD_TO_ACCOUNT[String(r.method || '').trim()];
    if (target && idByAccountName[target] !== undefined) { r.accountId = idByAccountName[target]; filled++; }
  });
  return { scanned, filled };
}

/**
 * 一次性账户迁移编排：备份 → 预置账户 → 回填 → 校验 → 落盘。
 * 校验项：迁移前后「支出总额」与「收入总额」必须完全相等——
 * 回填只应新增 accountId，一旦金额/kind 被改写就说明迁移破坏了数据。
 */
function migrateLedgerAccountsOnce() {
  const needAccounts = rt.db.ledgerAccounts.length === 0;
  const needBackfill = rt.db.ledgerRecords.some(r => r.accountId === undefined);
  if (!needAccounts && !needBackfill) return { skipped: true, scanned: 0, filled: 0, ok: true };
  const rawTotals = () => ({
    expense: round2(rt.db.ledgerRecords.filter(r => r.kind === 'expense').reduce((a, r) => a + (+r.amount || 0), 0)),
    income: round2(rt.db.ledgerRecords.filter(r => r.kind === 'income').reduce((a, r) => a + (+r.amount || 0), 0))
  });
  const before = rawTotals();
  /* 1) 备份：必须在任何改动之前，且只在真正要改历史数据时做 */
  let backupPath = '';
  try {
    const dir = path.join(DATA_DIR, 'backup');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backupPath = path.join(dir, 'db-before-ledger-accounts-' + stamp + '.json');
    fs.writeFileSync(backupPath, JSON.stringify(rt.db, null, 2), 'utf8');
  } catch (e) {
    console.error('[账本迁移] 备份失败，已中止迁移以避免不可回滚：', e.message);
    return { skipped: true, scanned: 0, filled: 0, ok: false, error: '备份失败，迁移中止' };
  }
  /* 2) 预置账户 + 3) 回填 */
  ensureLedgerAccounts();
  const { scanned, filled } = backfillRecordAccounts();
  saveDb();
  /* 4) 校验 */
  const after = rawTotals();
  const ok = Math.abs(before.expense - after.expense) < 0.005 && Math.abs(before.income - after.income) < 0.005;
  if (!ok) console.error('[账本迁移] 收支总额校验不一致！before=', before, 'after=', after);
  console.log(`[账本迁移] 扫描 ${scanned} 条历史流水，回填账户 ${filled} 条，未指定账户 ${scanned - filled} 条，`
    + `收支总额校验${ok ? '通过' : '失败'}，备份 ${backupPath}`);
  return { skipped: false, scanned, filled, ok, backupPath };
}

/* 分类层级 + 场景账本迁移：备份 → 补层级字段 → 预置二级分类 → 预置账本 → 历史流水归属默认账本（幂等） */
function migrateLedgerTaxonomyOnce() {
  const needCats = rt.db.ledgerCategories.some(c => c.parentId === undefined)
    || !rt.db.ledgerCategories.some(c => c.name === '育儿' && c.kind === 'expense')
    || !rt.db.ledgerCategories.some(c => c.parentId);
  const needBooks = rt.db.ledgerBooks.length === 0;
  const needBookId = rt.db.ledgerRecords.some(r => r.bookId === undefined);
  if (!needCats && !needBooks && !needBookId) return { skipped: true, ok: true };
  const rawTotals = () => ({
    expense: round2(rt.db.ledgerRecords.filter(r => r.kind === 'expense').reduce((a, r) => a + (+r.amount || 0), 0)),
    income: round2(rt.db.ledgerRecords.filter(r => r.kind === 'income').reduce((a, r) => a + (+r.amount || 0), 0))
  });
  const before = rawTotals();
  const idsBefore = rt.db.ledgerCategories.map(c => c.id).join(',');
  /* 备份：必须在任何改动之前；失败则整体中止，避免不可回滚 */
  let backupPath = '';
  try {
    const dir = path.join(DATA_DIR, 'backup');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backupPath = path.join(dir, 'db-before-ledger-taxonomy-' + stamp + '.json');
    fs.writeFileSync(backupPath, JSON.stringify(rt.db, null, 2), 'utf8');
  } catch (e) {
    console.error('[账本分类迁移] 备份失败，已中止迁移以避免不可回滚：', e.message);
    return { skipped: true, ok: false, error: '备份失败，迁移中止' };
  }
  ensureLedgerPresetCategories();
  ensureLedgerBooks();
  /* 历史流水统一归属默认账本 */
  const bid = defaultLedgerBookId();
  let assigned = 0;
  rt.db.ledgerRecords.forEach(r => { if (r.bookId === undefined) { r.bookId = bid; assigned++; } });
  saveDb();
  /* 校验：原有分类 id 一个不少 + 收支总额不变 */
  const idsAfter = rt.db.ledgerCategories.map(c => c.id);
  const keepAll = idsBefore.split(',').every(id => idsAfter.includes(+id));
  const after = rawTotals();
  const ok = keepAll
    && Math.abs(before.expense - after.expense) < 0.005
    && Math.abs(before.income - after.income) < 0.005;
  if (!ok) console.error('[账本分类迁移] 校验不一致！保留原有分类=', keepAll, 'before=', before, 'after=', after);
  const parents = rt.db.ledgerCategories.filter(c => !c.parentId).length;
  console.log(`[账本分类迁移] 分类 ${rt.db.ledgerCategories.length} 个（一级 ${parents} + 二级 ${rt.db.ledgerCategories.length - parents}），`
    + `账本 ${rt.db.ledgerBooks.length} 本，历史流水归属默认账本 ${assigned} 条，`
    + `原有分类 id 保留${keepAll ? '完整' : '异常'}，收支总额校验${Math.abs(before.expense - after.expense) < 0.005 && Math.abs(before.income - after.income) < 0.005 ? '通过' : '失败'}，备份 ${backupPath}`);
  return { skipped: false, ok, backupPath };
}

/* 只导出 server.js 消费的入口；其余（预置数据表、ensure/backfill 系列）均为本模块
 * 内部步骤——migrate*Once 的编排顺序就是调用约定，导出它们只会诱导外部绕过编排。 */
module.exports = {
  ASSET_TYPES,
  LEDGER_ACCOUNT_TYPES, LEDGER_BOOK_KINDS, ensureLedgerCategories, migrateLedgerAccountsOnce, migrateLedgerTaxonomyOnce,
  computeNetWorth,
  defaultLedgerBookId,
  ledgerAccountBalances,
  ledgerBudgetStatus,
  ledgerCatName,
  ledgerFields,
  ledgerSummaryOf,
};
