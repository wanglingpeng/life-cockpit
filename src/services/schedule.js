/* 周期调度引擎 + 统一到期引擎。
 *
 * 两块内容原本散在 server.js 里，共同点是「给定一条记录，算出它下次什么时候
 * 该出现、现在处于什么状态」——纯计算，不碰 db，可被任何模块直接 import。
 *
 * 从 server.js 抽出（原「周期调度引擎：统一下次执行时间」区）。 */
const { todayStr, validDateStr } = require('./utils');

/* ---------------- 周期调度引擎：统一下次执行时间 ---------------- */
/**
 * 计算下次执行日期（YYYY-MM-DD）
 * - daily   每天（今天）
 * - weekly  每周 ruleValue=1..7（1=周一）
 * - monthly 每月 ruleValue=1..28
 * - yearly  每年 ruleValue='MM-DD'
 * - interval 每 intervalValue 个 intervalUnit（day/week/month/year），
 *            以 lastDoneAt 为基准；从未完成且未设 startDate 则视为「立即待办」
 */
function nextRunDate(t, asOf) {
  const today = (asOf && validDateStr(String(asOf))) ? asOf : todayStr();
  if (t.ruleType === 'interval') {
    const n = Math.max(1, +t.intervalValue || 1);
    const unit = t.intervalUnit || 'month';
    /* P1-2：base 优先级 = lastDoneAt（上次真的做了）> startDate（用户指定的起算日）。
     * 历史缺陷：只认 lastDoneAt，导致「每 3 个月换滤芯」这类从未标记完成的周期事项
     * 永远落在「今天 = 到期」，红条天天滞留、首次提醒日期完全失真。
     * 现在：设了 startDate 就按它推进到第一个 >= today 的周期点；两者都没有才退回「立即待办」。 */
    const base = (t.lastDoneAt && validDateStr(String(t.lastDoneAt)) ? t.lastDoneAt : '')
      || (t.startDate && validDateStr(String(t.startDate)) ? t.startDate : '');
    if (!base) return today;
    const d = new Date(base + 'T00:00:00');
    if (isNaN(d.getTime())) return today;
    const step = () => {
      if (unit === 'day') d.setDate(d.getDate() + n);
      else if (unit === 'week') d.setDate(d.getDate() + n * 7);
      else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
      else d.setMonth(d.getMonth() + n);
    };
    step();
    // startDate 可能远在过去：推进到第一个不早于今天的周期点（防止一建就永久逾期）
    let guard = 0;
    while (todayStr(d) < today && guard++ < 600) step();
    return todayStr(d);
  }
  // daily：完成后跳到 lastDoneAt+1 天，避免当天标完、红条滞留到第二天
  if (t.ruleType === 'daily') {
    const base = t.lastDoneAt || '';
    if (!base) return today;
    const d = new Date(base + 'T00:00:00');
    if (isNaN(d.getTime())) return today;
    d.setDate(d.getDate() + 1);
    return todayStr(d);
  }
  const d = new Date(today + 'T00:00:00');
  if (t.ruleType === 'weekly') {
    const target = Math.min(7, Math.max(1, +(t.ruleValue || 1)));
    const curDow = d.getDay() === 0 ? 7 : d.getDay();
    d.setDate(d.getDate() + ((target - curDow + 7) % 7));
  } else if (t.ruleType === 'monthly') {
    // 支持 1–31 号；当月无该日（小月/2月）则按当月最后一天执行
    const wantDay = Math.min(31, Math.max(1, +(t.ruleValue || 1)));
    const lastDayOf = (dt) => new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(wantDay, lastDayOf(d)));
    if (todayStr(d) < today) {
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(wantDay, lastDayOf(d)));
    }
  } else if (t.ruleType === 'yearly') {
    const parts = (t.ruleValue || '01-01').split('-').map(Number);
    const mm = Math.min(12, Math.max(1, parts[0] || 1));
    const wantDay = Math.min(31, Math.max(1, parts[1] || 1));
    const lastDayOf = (dt) => new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    d.setMonth(mm - 1);
    d.setDate(Math.min(wantDay, lastDayOf(d)));
    if (todayStr(d) < today) d.setFullYear(d.getFullYear() + 1, mm - 1);
  }
  return todayStr(d); // daily
}

function calcNextRun(t, asOf) {
  return nextRunDate(t, asOf) + ' ' + (t.remindTime || '09:00');
}

/** 给周期任务补齐状态信息（前端直接用） */
function decorateSchedule(t) {
  const today = todayStr();
  /* 优先信任存储的 nextRun（create/PUT/done 均重算维护，skip 手动写入下一周期）。
   * 此前一律 nextRunDate(t) 重算：「跳过一次」把 nextRun 推到下周期后，展示与推送
   * 仍按 lastDoneAt 重算回旧日期，导致 skip 在 UI 与提醒里都不生效。 */
  const storedNext = (t.nextRun && validDateStr(String(t.nextRun).slice(0, 10))) ? String(t.nextRun).slice(0, 10) : '';
  const next = storedNext || nextRunDate(t);
  const daysLeft = Math.round((new Date(next + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  let state = 'ok';
  if (!t.enabled) state = 'disabled';
  else if (daysLeft < 0) state = 'overdue';
  else if (daysLeft === 0) state = 'due';
  else if (daysLeft <= 7) state = 'soon';
  const extra = {};
  // monthly 规则日 >28 会被钳到 28 日，标记出来提示前端
  if (t.ruleType === 'monthly' && parseInt(t.ruleValue, 10) > 28) extra.clamped = true;
  /* interval 且 startDate 在未来 → 尚未开始（P1-2 后 nextRunDate 已按 startDate 推进，
   * 此标记仍保留：让前端显示「未开始」而非「X 天后」，语义更准） */
  if (t.ruleType === 'interval' && t.startDate && validDateStr(String(t.startDate)) && t.startDate > today) extra.notStarted = true;
  // interval 从未完成且无 startDate → 首次提醒就在今天（「现在就该做」），标出来提示用户
  if (t.ruleType === 'interval' && !t.lastDoneAt && !(t.startDate && validDateStr(String(t.startDate)))) extra.neverDone = true;
  return Object.assign({}, t, {
    nextRun: storedNext ? t.nextRun : calcNextRun(t),
    nextRunDate: next,
    daysLeft,
    state,
    ruleText: scheduleRuleText(t)
  }, extra);
}

function scheduleRuleText(t) {
  const unitCN = { day: '天', week: '周', month: '个月', year: '年' };
  const weekCN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };
  if (t.ruleType === 'daily') return '每天';
  if (t.ruleType === 'weekly') return '每周' + (weekCN[t.ruleValue] || '一');
  if (t.ruleType === 'monthly') return '每月 ' + (t.ruleValue || 1) + ' 日';
  if (t.ruleType === 'yearly') return '每年 ' + (t.ruleValue || '01-01');
  const n = Math.max(1, +t.intervalValue || 1);
  return '每 ' + n + ' ' + (unitCN[t.intervalUnit] || '个月');
}

function scheduledFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  return {
    name: String(pick('name', '') || '').trim(),
    ruleType: pick('ruleType', 'daily'),
    ruleValue: pick('ruleValue', '') === null ? '' : String(pick('ruleValue', '')),
    remindTime: pick('remindTime', '09:00') || '09:00',
    enabled: body.enabled !== undefined ? !!body.enabled : (isNew ? true : !!cur.enabled),
    category: pick('category', '其他') || '其他',
    intervalValue: Math.max(1, +pick('intervalValue', 1) || 1),
    intervalUnit: pick('intervalUnit', 'month') || 'month',
    lastDoneAt: pick('lastDoneAt', '') || '',
    startDate: pick('startDate', '') || '',
    remark: pick('remark', '') || '',
    memberId: body.memberId !== undefined ? (body.memberId ? +body.memberId : null) : (isNew ? null : cur.memberId || null)
  };
}

function dueState(daysLeft, leadDays) {
  if (daysLeft === null || daysLeft === undefined) return null;
  const lead = leadDays === undefined ? 3 : Math.max(0, +leadDays || 0);
  return { daysLeft, state: daysLeft < 0 ? 'overdue' : (daysLeft === 0 ? 'due' : (daysLeft <= lead ? 'soon' : 'ok')) };
}

module.exports = {
  calcNextRun,
  decorateSchedule,
  dueState,
  nextRunDate,
  scheduleRuleText,
  scheduledFields,
};
