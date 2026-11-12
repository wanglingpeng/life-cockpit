'use strict';
/* 驾驶舱简报：把 buildTodayPayload 已汇总的家庭数据交给 AI 组织成一段可读的「今日简报」。
 * 数据复用首页 payload（buildTodayPayload），避免二次计算口径漂移；AI 不可用时降级为
 * 规则模板，保证接口永不空返回。 */
const rt = require('../core/runtime');
const { buildTodayPayload, todayActionItems } = require('./today');
const { aiCompleteOnce, aiProviderStatus } = require('./ai');
const { daysToNextYearly, newId, nowStr, safeSlice, todayStr } = require('./utils');
const { mortgageNextPayment } = require('./family');
const { recordActivity } = require('./telemetry');
const { saveDb } = require('./db-io');

const ICON = { task: '📋', scheduled: '🔁', expiry: '📦', anniversary: '💖', birthday: '🎂', vault: '🔐', health: '🩺', mortgage: '🏠' };

/** 生成今日驾驶舱简报。
 * 返回 { brief, facts, generatedAt, aiUsed, fallbackReason, aiState, today } */
async function buildDailyBrief() {
  const today = todayStr();
  const p = buildTodayPayload();
  const urgent = todayActionItems(p).slice(0, 4);            // 复用唯一口径：逾期 + 7 天内，简报至多列 4 条
  const exp = p.metrics && p.metrics.find(m => m.key === 'expense');
  const due = p.metrics && p.metrics.find(m => m.key === 'due');
  const facts = [];
  if (exp) facts.push('本月支出 ' + exp.display + (exp.trend && exp.trend.text ? '（' + exp.trend.text + '）' : ''));
  if (due && due.display && due.display !== '0') facts.push('30 天内到期 ' + due.display + ' 件' + (due.trend && due.trend.text ? '，' + due.trend.text : ''));
  if (urgent.length) facts.push('今天要处理 ' + p.actionableTotal + ' 件：' + urgent.map(i => ICON[i.kind] + i.title).join('、'));
  else facts.push('今天没有临近到期的生日、证件或健康事项');
  if (p.northStar && p.northStar.week !== undefined) facts.push('本周已记录 ' + p.northStar.week + ' 条');
  if (p.cold && p.cold.length) facts.push('还未启用：' + p.cold.map(c => c.name).join('、'));
  const factsText = facts.join('\n');

  let brief = '';
  let aiUsed = false;
  let fallbackReason = '';
  if (aiProviderStatus().state === 'ok') {
    try {
      const system = '你是生活驾驶舱的家庭管家。把给的今日数据组织成 60-100 字的中文口语提醒，像对家人说话：先最急的事，再钱，再其他；要连贯自然，不要列点、不要喊口号、不要敬语客套。';
      const prompt = '今天是 ' + today + '。家庭数据：\n' + factsText;
      brief = (await aiCompleteOnce(prompt, system, 0.7, 'chat')).trim();
      aiUsed = true;
    } catch (e) {
      fallbackReason = e && e.message || String(e);
    }
  } else {
    fallbackReason = aiProviderStatus().reason || 'AI 未配置';
  }
  if (!brief) {
    const head = urgent.slice(0, 4).map(i => i.title).join('、');
    const money = exp ? '本月支出 ' + exp.display + '。' : '';
    brief = head
      ? '今天要留意：' + head + '。' + money
      : money || '今天没有特别要紧的事，安心安排。';
  }
  return {
    brief, facts: factsText, generatedAt: new Date().toISOString(),
    aiUsed, fallbackReason, aiState: aiProviderStatus().state, today
  };
}

/** 跨模块联动：把临期项（证件/保险/生日/纪念日/健康/还款）转入统一待办。
 * 不污染原模块——在原模块保留倒计时信息，tasks 里新增一条可执行待办并标记来源。
 * 防重复：tasks 里已存在 origin:<kind>:<id> 来源标记时返回 dup，不重复建档。 */
function convertExpiryToTodo(kind, id, uid) {
  const db = rt.db;
  const found = (() => {
    if (kind === 'expiry') { const i = db.expiryItems.find(x => String(x.id) === String(id)); return i ? { title: i.name, date: i.expiryDate } : null; }
    if (kind === 'vault') { const e = db.vaultEntries.find(x => String(x.id) === String(id)); return e ? { title: e.title, date: e.expireDate } : null; }
    if (kind === 'birthday') { const m = db.familyMembers.find(x => String(x.id) === String(id)); return (m && m.birthday) ? { title: m.name + ' 的生日', date: daysToNextYearly(m.birthday) } : null; }
    if (kind === 'anniversary') { const a = db.anniversaries.find(x => String(x.id) === String(id)); return a ? { title: a.title, date: ((a.repeat === 'yearly' || a.type === 'count-up') ? daysToNextYearly(a.date) : a.date) } : null; }
    if (kind === 'health') {
      for (const h of db.healthProfiles) for (const c of (h.checkups || [])) if (String(c.id) === String(id)) {
        const fm = db.familyMembers.find(x => x.id === h.memberId);
        return { title: (fm ? fm.name : '家人') + ' · ' + (c.name || '复诊'), date: c.nextDate };
      }
      return null;
    }
    if (kind === 'mortgage') { const m = db.mortgages.find(x => String(x.id) === String(id)); return m ? { title: (m.name || '贷款') + '还款', date: mortgageNextPayment(m) } : null; }
    return null;
  })();
  if (!found || !found.date) throw new Error('未找到对应事项');
  const origin = 'origin:' + kind + ':' + id;
  if (db.tasks.some(t => String(t.remark || '').indexOf(origin) >= 0)) return { dup: true };
  const task = {
    id: newId(db), title: safeSlice(String(found.title), 80), date: found.date,
    remindTime: '', statusId: 1, color: '', pinned: false,
    remark: safeSlice(origin + ' 已转入待办', 200),
    client: '', nextAction: '', memberId: null, createdAt: nowStr()
  };
  db.tasks.push(task); saveDb();
  recordActivity('task.create', 1);
  return { task };
}

module.exports = { buildDailyBrief, convertExpiryToTodo };
