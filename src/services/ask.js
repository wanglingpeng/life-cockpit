'use strict';
/* P1④ 自然语言查询「问驾驶舱」：把驾驶舱结构化数据组装成文本快照，交给 AI 按问题回答；
 * AI 不可用时按问题关键词从数据里提取关键结论兜底，保证接口永不空返回。
 * 数据复用 buildTodayPayload（首页同口径）+ 账本/待办明细，避免二次计算口径漂移。 */
const { buildTodayPayload } = require('./today');

const round2 = v => Math.round((+v || 0) * 100) / 100;
const dayName = d => ['日', '一', '二', '三', '四', '五', '六'][d];

/** 组装「驾驶舱快照」文本，供 AI 回答任意数据问题。 */
function buildAskSnapshot(db, today) {
  const now = new Date();
  const p = buildTodayPayload();
  const lines = [];
  lines.push('今天 ' + today + '（周' + dayName(now.getDay()) + '），这是「生活驾驶舱」里你家庭的实时数据：');

  // 钱：账本
  const catName = id => { const c = (db.ledgerCategories || []).find(x => x.id === id); return c ? c.name : ''; };
  const recs = (db.ledgerRecords || []).filter(r => r.kind !== 'transfer').sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const month = today.slice(0, 7);
  const sum = arr => arr.reduce((s, r) => s + (+r.amount || 0), 0);
  const expM = recs.filter(r => r.kind === 'expense' && (r.date || '').startsWith(month));
  const incM = recs.filter(r => r.kind === 'income' && (r.date || '').startsWith(month));
  lines.push('- 账本：本月支出 ' + round2(sum(expM)) + ' 元（' + expM.length + ' 笔），本月收入 ' + round2(sum(incM)) + ' 元（' + incM.length + ' 笔）。');
  const recent = recs.slice(0, 15);
  if (recent.length) lines.push('- 最近账目：' + recent.map(r => (r.kind === 'expense' ? '支出' : '收入') + (catName(r.categoryId) ? '[' + catName(r.categoryId) + ']' : '') + ' ' + r.amount + ' 元' + (r.date ? '(' + r.date + ')' : '') + (r.remark ? '·' + r.remark : '')).join('；'));

  // 待办
  const todos = (db.tasks || []).filter(t => t.statusId === 1).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (todos.length) lines.push('- 未完成待办 ' + todos.length + ' 项：' + todos.slice(0, 12).map(t => t.title + (t.date ? '(' + t.date + ')' : '')).join('；'));

  // 近期/今日要处理（按类别结构化，无则写「暂无」，保证到期/生日类问题有据可答）
  const pi = p.items || [];
  const expiryL = pi.filter(i => i.kind === 'expiry' || i.kind === 'vault');
  const bdL = pi.filter(i => i.kind === 'birthday' || i.kind === 'anniversary');
  const careL = pi.filter(i => i.kind === 'health' || i.kind === 'mortgage');
  lines.push('- 临期证件/物品：' + (expiryL.length ? expiryL.map(i => i.title).join('、') : '暂无'));
  lines.push('- 近期生日/纪念日：' + (bdL.length ? bdL.map(i => i.title).join('、') : '暂无'));
  lines.push('- 健康复诊/还款：' + (careL.length ? careL.map(i => i.title).join('、') : '暂无'));
  const exp = p.metrics && p.metrics.find(m => m.key === 'expense');
  const due = p.metrics && p.metrics.find(m => m.key === 'due');
  if (exp) lines.push('- 钱指标：' + exp.display + (exp.trend && exp.trend.text ? '（' + exp.trend.text + '）' : ''));
  if (due && due.display && due.display !== '0') lines.push('- 30 天内到期 ' + due.display + ' 件' + (due.trend && due.trend.text ? '，' + due.trend.text : ''));
  if (p.northStar && p.northStar.week !== undefined) lines.push('- 本周已记录 ' + p.northStar.week + ' 条');
  return lines.join('\n');
}

/** AI 不可用时的规则兜底：按问题关键词从数据里给出最贴切的结论。 */
function ruleAnswer(p, db, today, q) {
  const k = String(q || '').toLowerCase();
  const month = today.slice(0, 7);
  const recs = (db.ledgerRecords || []).filter(r => r.kind !== 'transfer' && (r.date || '').startsWith(month));
  const sum = arr => arr.reduce((s, r) => s + (+r.amount || 0), 0);
  const expM = recs.filter(r => r.kind === 'expense');
  const incM = recs.filter(r => r.kind === 'income');
  const todos = (db.tasks || []).filter(t => t.statusId === 1);
  const due = p.metrics && p.metrics.find(m => m.key === 'due');

  if (/花|支出|开销|钱|多少|账|消费/.test(k)) {
    return '本月（' + month + '）支出 ' + round2(sum(expM)) + ' 元，共 ' + expM.length + ' 笔；收入 ' + round2(sum(incM)) + ' 元。想看明细可到「家庭账本」。';
  }
  if (/待办|要做|处理|办/.test(k)) {
    if (!todos.length) return '当前没有未完成的待办。';
    return '未完成待办 ' + todos.length + ' 项：' + todos.slice(0, 10).map(t => t.title + (t.date ? '(' + t.date + ')' : '')).join('、') + '。';
  }
  if (/到期|证件|保险|效期|过期/.test(k)) {
    if (due && due.display && due.display !== '0') return '30 天内到期的有 ' + due.display + ' 件' + (due.trend && due.trend.text ? '（' + due.trend.text + '）' : '') + '，具体在「证件效期」里看。';
    return '30 天内没有到期事项。';
  }
  if (/生日|纪念日|谁|家人/.test(k)) {
    const bd = (p.items || []).filter(i => i.kind === 'birthday' || i.kind === 'anniversary');
    if (bd.length) return '近期相关：' + bd.map(i => i.title).join('、') + '。';
    return '近期没有临近的生日或纪念日。';
  }
  // 兜底：给驾驶舱现状摘要
  return '驾驶舱现状：本月支出 ' + round2(sum(expM)) + ' 元（' + expM.length + ' 笔）、收入 ' + round2(sum(incM)) + ' 元；未完成待办 ' + todos.length + ' 项；' + ((due && due.display && due.display !== '0') ? '30 天内到期 ' + due.display + ' 件。' : '30 天内无到期。');
}

module.exports = { buildAskSnapshot, ruleAnswer };
