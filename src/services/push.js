/* 机器人推送：六通道 Webhook 适配 + 晨报定时推送。
 *
 * PUSH_CHANNELS 与发送逻辑不分的理由：六种通道的报文格式（企业
 * 微信 / 飞书 / 钉钉 / Server酱 / PushPlus / Bark）与通道表是同一
 * 份知识的两种表示，分家就会出现「表里加了通道、发送时不认识」——
 * 那种不一致没有任何测试能发现，只会有一个用户收不到日报。
 *
 * buildPushMessage 的文案口径来自 digest 模块（晨报四维分栏）：
 * 推送内容和 App 内晨报必须是同一份数据，否则用户会看到「推送说
 * 今天 3 件事、打开 App 是 5 件」。
 *
 * 定时器（startPushScheduler）的「同一分钟只发一次」靠对
 * db.settings.push 的读写实现，随模块搬迁保持原子性。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区中段）。 */
const rt = require('../core/runtime');
const { moneyVal, todayStr } = require('./utils');
const { saveDb } = require('./db-io');
const { buildDailyDigest } = require('./digest');
const { buildDailyBrief } = require('./brief');
const { decorateSchedule } = require('./schedule');
const { sendWechatSubscribeToAll } = require('./wechat');

/* =================== 消息推送 =================== */
const PUSH_CHANNELS = [
  { key: 'wecom', label: '企业微信机器人', host: 'qyapi.weixin.qq.com' },
  { key: 'feishu', label: '飞书机器人', host: 'open.feishu.cn' },
  { key: 'dingtalk', label: '钉钉机器人', host: 'oapi.dingtalk.com' },
  { key: 'serverchan', label: 'Server酱', host: 'sctapi.ftqq.com' },
  { key: 'pushplus', label: 'PushPlus', host: 'www.pushplus.plus' },
  { key: 'bark', label: 'Bark（iOS）', host: 'api.day.app' }
];

const PUSH_HOSTS = PUSH_CHANNELS.map(c => c.host);

function pushCfg() {
  if (!rt.db.settings.push || typeof rt.db.settings.push !== 'object') rt.db.settings.push = {};
  const p = rt.db.settings.push;
  const def = {
    enabled: false, webhook: '', channel: 'wecom', dailyReport: true, dailyTime: '08:00',
    leadDays: 3, baseUrl: '', lastSentDate: '', lastResult: '',
    /* P0-5：逐条到点提醒开关与当天去重表；晨报失败重试状态 */
    itemReminders: true, reminderSent: {}, lastReminderResult: '',
    dailyRetryDate: '', dailyRetry: 0, dailyLastTryAt: 0
  };
  Object.keys(def).forEach(k => { if (p[k] === undefined) p[k] = def[k]; });
  return p;
}

/** 组装推送文案（晨报 2.0：今天 / 钱 / 家底 / 记录 四维分栏） */
function buildPushMessage(isTest) {
  const d = buildDailyDigest();
  const p = pushCfg();
  const f = moneyVal;
  const md = Number(d.date.slice(5, 7)), dd = Number(d.date.slice(8, 10));
  const secs = [];

  // ① 今天要处理
  const s1 = ['📋 今天要处理 ' + d.todo.total + ' 件' + (d.todo.overdue ? '（其中逾期 ' + d.todo.overdue + ' 件）' : '')];
  if (d.todo.top.length) {
    d.todo.top.slice(0, 5).forEach((i, n) => s1.push('   ' + (n + 1) + '. ' + i.title + ' — ' + i.sub));
    if (d.todo.total > 5) s1.push('   …另有 ' + (d.todo.total - 5) + ' 件');
  } else {
    s1.push('   今天没有待处理事项 ✅');
  }
  secs.push(s1.join('\n'));

  // ② 钱
  const s2 = [];
  let head = '💰 本月支出 ¥' + f(d.money.expense);
  if (d.money.deltaPct !== null) head += '（' + (d.money.deltaPct > 0 ? '+' : '') + d.money.deltaPct + '% 较上月同期）';
  s2.push(head);
  if (d.money.biggest && d.money.biggest.amount >= 500) {
    s2.push('   最大一笔：' + d.money.biggest.name + ' ¥' + f(d.money.biggest.amount));
  }
  if (d.money.catDelta) {
    const c = d.money.catDelta;
    s2.push('   ⚠️ ' + (c.pct === null
      ? ('本月新增「' + c.name + '」支出 ¥' + f(c.cur))
      : (c.name + ' 环比 +' + c.pct + '%（¥' + f(c.cur) + '）')));
  }
  // 预算执行（迭代 3）：超支最多列 2 条，未超支时提 1 条接近上限的
  const bov2 = d.money.budget ? d.money.budget.over : [];
  const bwn2 = d.money.budget ? d.money.budget.warn : [];
  bov2.slice(0, 2).forEach(b => s2.push('   🎯 「' + b.name + '」预算已超支（已用 ' + b.percent + '%）'));
  if (!bov2.length && bwn2.length) {
    s2.push('   🎯 「' + bwn2[0].name + '」预算已用 ' + bwn2[0].percent + '%，留意节奏');
  }
  if (!d.money.recordCount) s2.push('   本月还没有记账');
  secs.push(s2.join('\n'));

  // ③ 家底（档案 / 证件 / 还款 / 复诊；阈值沿用推送设置的 leadDays）
  const lead = +p.leadDays || 0;
  const assets = (lead > 0 ? d.asset.due.filter(x => x.days <= lead) : d.asset.due).slice(0, 8);
  if (assets.length) {
    const s3 = ['📦 ' + (lead > 0 ? lead + ' 天内到期' : '30 天内到期') + ' ' + assets.length + ' 件'];
    assets.forEach(x => s3.push('   · ' + x.title + '（'
      + (x.days < 0 ? '已过期 ' + (-x.days) + ' 天' : x.days === 0 ? '今天' : x.days + ' 天后') + '）'));
    secs.push(s3.join('\n'));
  }

  // ④ 记录习惯
  secs.push('✍️ 本周已记录 ' + d.habit.week + '/' + d.habit.target + ' 条');

  // ⑤ 空置提醒（只提一条，避免刷屏）
  if (d.cold.length) secs.push('💡 ' + d.cold[0].name + '还没有数据，去补一条？');

  const lines = ['【生活驾驶舱 · ' + md + '月' + dd + '日 周' + d.weekday + '】' + (isTest ? '（测试消息）' : ''), ''];
  secs.forEach(s => { lines.push(s); lines.push(''); });
  if (p.baseUrl) lines.push('打开：' + p.baseUrl.replace(/\/+$/, ''));
  return lines.join('\n').replace(/\n+$/, '');
}

/** AI 主动简报版晨报：在结构化晨报前加一段 AI 口语「今日简报」（与首页同口径）。
 * AI 不可用或生成失败时退回纯晨报，不阻断每日推送。 */
async function buildPushMessageWithBrief(isTest) {
  const base = buildPushMessage(isTest);
  try {
    const b = await buildDailyBrief();
    if (b && b.brief) return '🤖 今日简报\n' + b.brief + '\n\n' + base;
  } catch (e) { /* AI 简报失败不阻断推送 */ }
  return base;
}

/** 发送到机器人 Webhook（适配 6 种通道的报文格式） */
async function sendPush(text, opts) {
  const p = pushCfg();
  /* 逐条到点提醒复用同一发送通道，但不覆盖晨报的 lastResult */
  const quiet = !!(opts && opts.updateLastResult === false);
  if (!p.enabled) return { ok: false, detail: '推送未开启' };
  if (!p.webhook) return { ok: false, detail: '未配置 Webhook' };
  const ch = p.channel || 'wecom';
  let payload;
  if (ch === 'wecom') payload = { msgtype: 'text', text: { content: text } };
  else if (ch === 'feishu') payload = { msg_type: 'text', content: { text } };
  else if (ch === 'dingtalk') payload = { msgtype: 'text', text: { content: text } };
  else if (ch === 'serverchan') payload = { title: '生活驾驶舱日报', desp: text };
  else if (ch === 'pushplus') payload = { title: '生活驾驶舱日报', content: text.replace(/\n/g, '<br>'), template: 'txt' };
  else if (ch === 'bark') payload = { title: '生活驾驶舱日报', body: text };
  else payload = { msgtype: 'text', text: { content: text } };
  try {
    const r = await fetch(p.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
    });
    const raw = (await r.text()).slice(0, 300);
    let okFlag = r.ok, detail = raw;
    try {
      const j = JSON.parse(raw);
      if (j.errcode !== undefined) { okFlag = r.ok && j.errcode === 0; detail = j.errmsg || raw; }
      else if (j.code !== undefined) { okFlag = r.ok && j.code === 0; detail = j.msg || raw; }
    } catch (e) { }
    if (!quiet) p.lastResult = (okFlag ? 'ok ' : 'fail ') + String(detail).slice(0, 80);
    return { ok: okFlag, detail: String(detail).slice(0, 120) };
  } catch (e) {
    if (!quiet) p.lastResult = 'fail ' + (e && e.message ? e.message : e);
    return { ok: false, detail: (e && e.message) ? e.message : String(e) };
  }
}

const hhmmNow = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

/** 每日晨报：每分钟检查，到达设定时间后发送；失败才允许当天有限重试。
 *  P0-5 修复：旧实现无条件写 lastSentDate=today，只要第一次发送失败
 *  （Webhook 打错、网络抖动、机器人限流），当天就再也不会重发，而界面
 *  上还显示「每日推送已开启」。现在只有真正成功才标记已发。 */
function startPushScheduler() {
  let inFlight = false;
  setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const p = pushCfg();
      if (!p.enabled || !p.webhook || p.dailyReport === false) return;
      const today = todayStr();
      if (p.lastSentDate === today) return;
      if (hhmmNow() < String(p.dailyTime || '08:00')) return;
      if (p.dailyRetryDate !== today) {
        p.dailyRetryDate = today; p.dailyRetry = 0; p.dailyLastTryAt = 0;
      }
      /* 首试 + 最多 3 次重试，间隔 5 分钟；避免配置错误时全天每分钟刷接口 */
      if (Number(p.dailyRetry || 0) >= 4) return;
      if (p.dailyLastTryAt && Date.now() - Number(p.dailyLastTryAt) < 5 * 60 * 1000) return;

      const msg = await buildPushMessageWithBrief(false);
      const r = await sendPush(msg);
      p.dailyRetry = Number(p.dailyRetry || 0) + 1;
      p.dailyLastTryAt = Date.now();
      if (r.ok) p.lastSentDate = today;
      p.lastResult = (r.ok ? 'ok ' : 'fail ') + String(r.detail || '').slice(0, 80)
        + (r.ok ? '' : '（第 ' + p.dailyRetry + ' 次尝试，5 分钟后重试）');
      // 微信订阅消息：向已授权用户逐条下发（失败不回滚晨报成功状态）
      try {
        const wx = await sendWechatSubscribeToAll(msg);
        if (wx.sent || wx.fail) p.lastResult += ' | 微信订阅 ' + wx.sent + ' 成功/' + wx.fail + ' 失败';
      } catch (e) { /* 不影响主推送 */ }
      saveDb();
    } catch (e) { /* 定时推送失败不打断服务 */ }
    finally { inFlight = false; }
  }, 60000);
}

/** P0-5：扫描「今天到期且 remindTime == 当前分钟」的条目，供到点提醒调度器调用
 *  （也便于单测）。读库逻辑与发送逻辑分离，便于在测试中稳定触发。 */
function collectDueReminders(at) {
  const today = todayStr();
  const hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  const out = [];
  (rt.db.tasks || []).forEach(t => {
    if (!t || t.statusId === 3) return;                 // 3 = 已完成
    if (String(t.date || '') !== today) return;
    if (String(t.remindTime || '') !== hhmm) return;
    out.push({ key: today + '|task|' + t.id, title: String(t.title || '事务'), sub: '今天 ' + hhmm });
  });
  (rt.db.scheduledTasks || []).forEach(t => {
    if (!t || t.enabled === false) return;
    if (String(t.remindTime || '09:00') !== hhmm) return;
    let nextDate = '';
    try { nextDate = decorateSchedule(t).nextRunDate; } catch (e) { return; }
    if (nextDate !== today) return;                     // 逾期项交给晨报，不逐条重复轰炸
    out.push({ key: today + '|scheduled|' + t.id, title: String(t.name || '周期事项'), sub: '周期提醒 ' + hhmm });
  });
  return out;
}

/** 逐条到点提醒（P0-5 缺失的整条链路）。
 *  以往只有 08:00 晨报一个定时器，事务的 remindTime 与周期事项的
 *  remindTime 填了也从不触发任何推送——「设了提醒却永远收不到」。 */
function startReminderScheduler() {
  let inFlight = false;
  setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const p = pushCfg();
      if (!p.enabled || !p.webhook || p.itemReminders === false) return;
      const today = todayStr();
      if (!p.reminderSent || typeof p.reminderSent !== 'object') p.reminderSent = {};
      // 去重表只保留当天，避免长期运行后无限膨胀
      for (const k of Object.keys(p.reminderSent)) {
        if (String(k).slice(0, 10) !== today) delete p.reminderSent[k];
      }
      const due = collectDueReminders(new Date()).filter(d => !p.reminderSent[d.key]);
      if (!due.length) return;
      const batch = due.slice(0, 10);
      const text = '⏰ 到点提醒\n' + batch.map((d, i) => (i + 1) + '. ' + d.title + '（' + d.sub + '）').join('\n');
      const r = await sendPush(text, { updateLastResult: false });
      p.lastReminderResult = (r.ok ? 'ok ' : 'fail ') + String(r.detail || '').slice(0, 80);
      /* 发送失败不写去重键：下一分钟会自然重试，直到成功或时间窗过去 */
      if (r.ok) batch.forEach(d => { p.reminderSent[d.key] = Date.now(); });
      saveDb();
    } catch (e) { /* 定时提醒失败不打断服务 */ }
    finally { inFlight = false; }
  }, 60000);
}

module.exports = {
  PUSH_CHANNELS,
  PUSH_HOSTS,
  buildPushMessage,
  buildPushMessageWithBrief,
  pushCfg,
  sendPush,
  startPushScheduler,
  startReminderScheduler,
  collectDueReminders,
};
