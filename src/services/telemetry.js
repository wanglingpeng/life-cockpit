/* 使用统计与遥测：动作记录、访客统计、使用洞察构建。
 *
 * recordActivity / ensureStatsDay / markVisit 共享 db.stats 的按天
 * 聚合结构（{dateKey: {actions: {key: count}, days: Set, platforms}}），
 * buildUsageInsights 只读不写。三者必须同模块：写入口和读口径分开
 * 两边，就会出现「记录了的动作在洞察里看不到」——各自都符合自己的
 * 假设，没有任何测试能发现。
 *
 * telemetryEnabled 是总开关（settings.telemetry === false 时全部
 * 静默），也放这里：开关和它管的东西分开，就会有人绕过开关直接调
 * recordActivity。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区前段的统计段）。 */
const rt = require('../core/runtime');
const { CORE_ACTIONS, dateKeyShift, dayWriteAndTotal, todayStr } = require('./utils');

const ACTION_LABELS = {
  'ai.quickadd': 'AI 一句话录入', 'ai.chat': 'AI 对话', 'ai.voice': 'AI 语音输入',
  'task.create': '新建事务', 'note.create': '新建手记', 'ledger.create': '记一笔账',
  'anniversary.create': '新建纪念日', 'scheduled.create': '新建定时提醒', 'expiry.create': '新建证件效期物品',
  'today.view': '查看今日驾驶舱', 'page.view.dashboard': '浏览首页', 'page.view.ledger': '浏览账本',
  'page.view.tasks': '浏览事务', 'page.view.notes': '浏览手记', 'page.view.insights': '浏览使用洞察',
  'pwa.standalone': '以 App 形态打开', 'push.click': '点开推送'
};

function telemetryEnabled() { return !(rt.db.settings && rt.db.settings.telemetry === false); }

function ensureStatsDay(dateKey) {
  if (!rt.db.activityStats || typeof rt.db.activityStats !== 'object' || !rt.db.activityStats.byDate) rt.db.activityStats = { byDate: {} };
  const byDate = rt.db.activityStats.byDate;
  let d = byDate[dateKey];
  if (!d || typeof d !== 'object') d = byDate[dateKey] = { actions: {}, platforms: { mobile: 0, desktop: 0, tablet: 0 } };
  if (!d.actions || typeof d.actions !== 'object') d.actions = {};
  if (!d.platforms || typeof d.platforms !== 'object') d.platforms = { mobile: 0, desktop: 0, tablet: 0 };
  for (const p of ['mobile', 'desktop', 'tablet']) if (typeof d.platforms[p] !== 'number') d.platforms[p] = 0;
  return d;
}

/** 记录一次/多次行为计数（action 为空则忽略；平台缺省 desktop）。返回是否写入 */
function recordActivity(action, count, platform) {
  if (!action || typeof action !== 'string') return false;
  if (!telemetryEnabled()) return false;
  const n = Math.max(1, Math.min(100000, parseInt(count, 10) || 1));
  const day = ensureStatsDay(todayStr());
  day.actions[action] = (day.actions[action] || 0) + n;
  const p = (platform === 'mobile' || platform === 'tablet' || platform === 'desktop') ? platform : 'desktop';
  day.platforms[p] = (day.platforms[p] || 0) + n;
  if (!rt.db.visitLog || typeof rt.db.visitLog !== 'object') rt.db.visitLog = {};
  rt.db.visitLog[todayStr()] = true;
  return true;
}

/** 仅记录「今日有访问」而不计具体动作（如页面浏览兜底） */
function markVisit() {
  if (!telemetryEnabled()) return false;
  if (!rt.db.visitLog || typeof rt.db.visitLog !== 'object') rt.db.visitLog = {};
  rt.db.visitLog[todayStr()] = true;
  return true;
}

/** 汇总最近 N 天的埋点 + 真实业务记录量，产出「使用洞察」页所需结构 */
function buildUsageInsights(days, opts) {
  const base = opts && opts.base ? opts.base : todayStr();
  const to = base;
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const byDate = (rt.db.activityStats && rt.db.activityStats.byDate) || {};
  const visitLog = (rt.db.visitLog && typeof rt.db.visitLog === 'object') ? rt.db.visitLog : {};

  /* 1) 逐日序列：长度恰为 n，最早在前、今天在最后 */
  const daily = [];
  const actionByDate = {};   // key -> { count, days:Set, platforms:{...} }
  const platforms = { mobile: 0, desktop: 0, tablet: 0 };
  let rangeTotal = 0, rangeWrites = 0;
  for (let i = n - 1; i >= 0; i--) {
    const dk = dateKeyShift(to, -i);
    const day = byDate[dk];
    const wt = dayWriteAndTotal(day);
    const visited = !!visitLog[dk] || wt.total > 0 || (day && day.platforms && (day.platforms.mobile + day.platforms.desktop + day.platforms.tablet) > 0);
    daily.push({ date: dk, count: wt.write, total: wt.total, visited });
    rangeTotal += wt.total; rangeWrites += wt.write;
    if (day) {
      if (day.actions) for (const k of Object.keys(day.actions)) {
        if (!actionByDate[k]) actionByDate[k] = { count: 0, days: new Set(), platforms: {} };
        actionByDate[k].count += day.actions[k] || 0;
        actionByDate[k].days.add(dk);
        /* 该动作当天出现的平台种类（仅标记，不重复计数） */
        if (day.platforms) for (const p of ['mobile', 'desktop', 'tablet']) {
          if ((day.platforms[p] || 0) > 0) actionByDate[k].platforms[p] = true;
        }
      }
      if (day.platforms) {
        platforms.mobile += day.platforms.mobile || 0;
        platforms.desktop += day.platforms.desktop || 0;
        platforms.tablet += day.platforms.tablet || 0;
      }
    }
  }

  /* 2) 动作明细：核心写入类优先，其后按次数降序 */
  const allActions = Object.keys(actionByDate).map(k => {
    const it = actionByDate[k];
    return { key: k, label: ACTION_LABELS[k] || k, count: it.count, core: CORE_ACTIONS.has(k), activeDays: it.days.size, platforms: it.platforms };
  }).sort((a, b) => (b.core - a.core) || (b.count - a.count));
  const actions = allActions;
  /* v72 修复：extra 卡只收「未命名 key」（不在 ACTION_LABELS 中的动作）。原实现=全部非 core 动作，
   * 导致浏览首页/浏览账本等已在主卡以中文名展示的动作，又在「其他被调用的行为」卡裸显原始 key 重复出现。 */
  const extraActions = allActions.filter(a => !a.core && !ACTION_LABELS[a.key]).map(a => ({ key: a.key, count: a.count }));

  /* 3) 活跃度：仅在窗口内统计；活跃率 = 活跃天数 / 窗口天数 */
  let activeDays = 0, streak = 0, stillStreak = true;
  for (let i = 0; i < daily.length; i++) {
    const x = daily[i];
    if (x.visited || x.total > 0) {
      activeDays++;
      if (stillStreak) streak++; else streak = 0;
    } else {
      stillStreak = false;
    }
  }
  /* 连续活跃应含今天（从末尾往前数连续为真的天数）更符合直觉 */
  let backStreak = 0;
  for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].visited || daily[i].total > 0) backStreak++; else break; }

  /* 4) 北极星：本周（近 7 天窗口）有效写入达标线 15 条 */
  const weeklyWrites = daily.slice(-7).reduce((s, x) => s + x.count, 0);
  const NS_TARGET = 15;

  /* 5) 数据存量（全量累计） */
  const safeArr = a => Array.isArray(a) ? a.length : 0;
  const recordTotals = {
    tasks: safeArr(rt.db.tasks), notes: safeArr(rt.db.notes), ledger: safeArr(rt.db.ledgerRecords),
    anniversaries: safeArr(rt.db.anniversaries), scheduled: safeArr(rt.db.scheduledTasks), expiry: safeArr(rt.db.expiryItems)
  };

  /* 6) 结论（人话） */
  const findings = [];
  const nzActions = actions.filter(a => a.count > 0);
  const topCore = nzActions.filter(a => a.core).slice(0, 1)[0];
  if (weeklyWrites >= NS_TARGET) {
    findings.push({ level: 'green', text: '本周有效写入已达 ' + weeklyWrites + ' 条（目标 ' + NS_TARGET + '），产品处于「日常工具」状态，继续保持。' });
  } else if (weeklyWrites > 0) {
    findings.push({ level: 'yellow', text: '本周有效写入 ' + weeklyWrites + ' 条，距离目标 ' + NS_TARGET + ' 条还差 ' + (NS_TARGET - weeklyWrites) + ' 条，建议多记几笔。' });
  } else {
    findings.push({ level: 'red', text: '本周还没有产生任何有效写入（新建事务/手记/账单等），产品尚未被真正用起来。' });
  }
  if (recordTotals.tasks + recordTotals.notes + recordTotals.ledger === 0) {
    findings.push({ level: 'red', text: '库里几乎没有事务/手记/账单数据，建议先用最顺手的入口（如一句话录入）沉淀几条。' });
  } else {
    findings.push({ level: 'green', text: '累计已沉淀 ' + (recordTotals.tasks + recordTotals.notes + recordTotals.ledger) + ' 条核心记录（事务 ' + recordTotals.tasks + ' / 手记 ' + recordTotals.notes + ' / 账单 ' + recordTotals.ledger + '）。' });
  }
  if (topCore) {
    findings.push({ level: 'green', text: '最常用的写入动作是「' + topCore.label + '」，窗口内共 ' + topCore.count + ' 次、覆盖 ' + topCore.activeDays + ' 天。' });
  }
  if (activeDays === 0) {
    findings.push({ level: 'yellow', text: '近 ' + n + ' 天暂无访问记录，活跃度偏低。' });
  } else {
    findings.push({ level: 'green', text: '近 ' + n + ' 天有 ' + activeDays + ' 天产生访问，活跃率约 ' + Math.round((activeDays / n) * 100) + '%。' });
  }

  const pfTotal = platforms.mobile + platforms.desktop + platforms.tablet;
  return {
    rangeDays: n,
    from: daily[0] ? daily[0].date : to,
    to,
    northStar: {
      weeklyWrites, target: NS_TARGET, met: weeklyWrites >= NS_TARGET,
      unit: '条', desc: '本周有效写入（新建事务/手记/账单等）'
    },
    active: {
      activeDays, totalDays: n, rate: Math.round((activeDays / n) * 100),
      streak: backStreak, windowStreak: streak
    },
    actions, extraActions,
    findings,
    daily,
    recordTotals,
    platforms,
    rangeTotal, rangeWrites, pfTotal
  };
}

module.exports = {
  ACTION_LABELS,
  buildUsageInsights,
  ensureStatsDay,
  markVisit,
  recordActivity,
  telemetryEnabled,
};
