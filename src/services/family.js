/* 家人档案与纪念日：字段整形、纪念日倒数、还贷日推算、成员统计富化。
 *
 * anniversaryLeft 是纪念日剩余天数的唯一入口（每年循环支持农历
 * 换算、单次按公历），memberWithStats 与 nearestAnniversaryOf 都
 * 建立在它上面——三处各算一遍就会出现「首页说 30 天、档案说 28 天」
 * 的不一致，而这种不一致没有任何测试能发现。
 *
 * mortgageNextPayment 的「下一个还款日」口径（遇节假日不顺延、
 * 按月推进）被房贷页与今日摘要共用，同模块保证同口径。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区前段）。 */
const rt = require('../core/runtime');
const { daysToNextYearly, daysToNextYearlyLunar, daysUntil, todayStr, validDateStr } = require('./utils');

/* ---------------- 家人档案 / 家庭账本 辅助 ---------------- */
function familyFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  return {
    name: String(pick('name', '') || '').trim(),
    relation: pick('relation', '') || '',
    emoji: pick('emoji', '🙂') || '🙂',
    color: pick('color', '#4CAF50') || '#4CAF50',
    birthday: pick('birthday', '') || '',
    phone: pick('phone', '') || '',
    address: pick('address', '') || '',
    remark: pick('remark', '') || '',
    avatar: pick('avatar', null) || null
  };
}

/** 纪念日剩余天数统一入口：每年循环（yearly/count-up）支持农历换算，单次按公历 */
function anniversaryLeft(a) {
  if (!a || !a.date) return null;
  const cyc = a.type === 'count-up' || a.repeat === 'yearly';
  if (cyc) return a.lunar ? daysToNextYearlyLunar(a.date) : daysToNextYearly(a.date);
  return daysUntil(a.date);
}

function mortgageNextPayment(m) {
  if (!m || !m.startDate || !validDateStr(String(m.startDate))) return null;
  const day = +m.startDate.slice(8, 10) || 1;
  const today = new Date(todayStr() + 'T00:00:00');
  const base = new Date(m.startDate + 'T00:00:00');
  const end = new Date(base.getFullYear() + (Math.max(0, +m.years || 0)), base.getMonth(), base.getDate());
  let next = new Date(today.getFullYear(), today.getMonth(), day);
  if (next < today) next = new Date(today.getFullYear(), today.getMonth() + 1, day);
  if (next > end) return null;
  return todayStr(next);
}

function nearestAnniversaryOf(list) {
  let best = null;
  list.forEach(a => {
    const left = anniversaryLeft(a);
    if (left === null || left === undefined) return;
    if (!best || left < best.left) best = { title: a.title, date: a.date, left };
  });
  return best;
}

function memberWithStats(fm) {
  const anns = rt.db.anniversaries.filter(a => a.memberId === fm.id);
  const gifts = rt.db.giftRecords.filter(r => r.memberId === fm.id);
  const giftIn = gifts.filter(r => r.direction === 'in').reduce((s, r) => s + (+r.amount || 0), 0);
  const giftOut = gifts.filter(r => r.direction === 'out').reduce((s, r) => s + (+r.amount || 0), 0);
  const items = rt.db.expiryItems.filter(i => i.memberId === fm.id);
  const today = todayStr();
  const itemSoon = items.filter(i => i.expiryDate && Math.round((new Date(i.expiryDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) <= 30).length;
  return Object.assign({}, fm, {
    annCount: anns.length,
    giftIn, giftOut, giftNet: giftIn - giftOut, giftCount: gifts.length,
    itemCount: items.length, itemSoon,
    vaultCount: rt.db.vaultEntries.filter(v => v.memberId === fm.id).length,
    nextAnniversary: nearestAnniversaryOf(anns),
    birthdayLeft: fm.birthday ? daysToNextYearly(fm.birthday) : null
  });
}

/* ---------------- 家庭档案库条目（证件效期）字段归一 ----------------
 * 从 server.js「从 handleApi 上提的局部常量与函数」区搬入。为什么属于
 * 家人档案域：expiryItems 与 familyMembers 同属家庭档案库（memberWithStats
 * 就跨读这两张表），且本函数与 familyFields 是同一形态（body + base →
 * 归一对象）——两个整形函数同模块，改「pick 语义」时不会只改一边。
 *
 * remindLeadDays 的三态（不传/null/数字）是刻意保留的：null 表示「不提醒」，
 * 与「没填」在 UI 上不同， clamp 0-90 是防呆不是业务规则。 */
function expiryItemFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  const intOrNull = (v, d) => (v === undefined ? d : (v ? +v : null));
  return {
    name: String(pick('name', '') || '').trim(),
    categoryId: intOrNull(body.categoryId, isNew ? null : cur.categoryId),
    qty: Math.max(1, +pick('qty', 1) || 1),
    expiryDate: pick('expiryDate', '') || '',
    location: pick('location', '') || '',
    warrantyUntil: pick('warrantyUntil', '') || '',
    serialNo: pick('serialNo', '') || '',
    attachments: Array.isArray(body.attachments) ? body.attachments.filter(x => x && String(x).trim()).slice(0, 20).map(x => String(x).trim())
      : (isNew ? [] : (cur.attachments || [])),
    memberId: intOrNull(body.memberId, isNew ? null : cur.memberId),
    remindLeadDays: (body.remindLeadDays === undefined ? (isNew ? null : (cur.remindLeadDays !== undefined ? cur.remindLeadDays : null))
      : (body.remindLeadDays === '' || body.remindLeadDays === null ? null : Math.max(0, Math.min(90, +body.remindLeadDays || 0)))),
    remark: pick('remark', '') || ''
  };
}

module.exports = {
  anniversaryLeft,
  expiryItemFields,
  familyFields,
  memberWithStats,
  mortgageNextPayment,
  nearestAnniversaryOf,
};
