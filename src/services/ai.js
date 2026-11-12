/* AI 助手：提供商配置、连通性探测、上下文构建与系统提示词。
 *
 * 为什么探测（probeProvider）和配置（aiSettings/aiConnOf）必须在
 * 一起：三态状态机（ok / none / bad_model）的判定横跨两者——
 * aiBadModel 是本地启发式，probeProvider 是真实请求，两者结论
 * 合成 aiProviderStatus 的返回值。拆开就会出现「本地说没问题、
 * 探测说 404，而状态机只信一边」的不一致。
 *
 * aiBuildContext 依赖 ledgerSummaryOf（账本口径）：AI 回答「这个月
 * 花了多少」必须和账本页同一个数字，所以它 require 账本模块而不是
 * 自己再算一遍——两套口径对不上时没有任何测试能发现。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「AI 助手（正式版）」区）。expiryItemFields
 * 虽在该区行文范围内，但属临期域，留在 server.js。 */
const https = require('https');
const rt = require('../core/runtime');
const { aesDecrypt } = require('../../lib/crypto.js');
const { daysToNextYearly, todayStr } = require('./utils');
const { decorateSchedule } = require('./schedule');
const { ledgerSummaryOf } = require('./ledger');

/* ---------------- AI 助手（正式版） ---------------- */
// 内置预设（v48 起仅作为连接编辑时的名称/地址/模型预填参考，不再是唯一配置载体；均为 OpenAI 兼容接口）
const AI_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', docs: 'https://platform.deepseek.com' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', docs: 'https://bailian.console.aliyun.com' },
  doubao: { label: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115', docs: 'https://console.volcengine.com/ark' }
};

const AI_CONN_PRESETS = Object.keys(AI_PROVIDERS).map(pid => ({ id: pid, label: AI_PROVIDERS[pid].label, baseUrl: AI_PROVIDERS[pid].baseUrl, model: AI_PROVIDERS[pid].model, docs: AI_PROVIDERS[pid].docs }));

/* 服务器内置 provider（去 Key 化）——源码里不放任何真实密钥。
 *
 * v1.48.50 起必须由部署者**显式注入** LIFE_COCKPIT_AI_KEY（或 AI_SERVER_KEY）
 * 才启用；未注入时 aiServerProvider() 返回 null，AI 如实报「未配置」，
 * 不会在用户从未配置过任何东西的情况下把家庭数据发往第三方。
 *
 * 历史事故（P0-1）：这里曾硬编码一枚真实 DeepSeek Key，注释却写着「去 Key 化」；
 * aiServerProvider() 无条件返回它，于是每个新装实例默认开启 AI 外发。这与
 * README 隐私声明「仅在主动调用时发往你配置的模型接口」「本仓库不含密钥」
 * 以及 settings.html「系统本身不会内置任何 Key」三处直接矛盾。
 * 改源码不等于撤销泄露：那枚 Key 已进入 git 历史，必须在服务商控制台作废。
 *
 * 仍然保留「开箱即用」的能力，只是把决定权从代码移到部署环境：
 * 设了环境变量就是部署者知情同意；模型/地址可用 AI_SERVER_MODEL /
 * AI_SERVER_BASE_URL 覆盖。视觉任务（票据识别）始终需要单独配视觉模型。 */
const AI_SERVER_KEY = String(process.env.LIFE_COCKPIT_AI_KEY || process.env.AI_SERVER_KEY || '').trim();
const AI_SERVER_PROVIDER = {
  id: -1, label: '服务器内置·DeepSeek', builtin: true,
  baseUrl: String(process.env.AI_SERVER_BASE_URL || 'https://api.deepseek.com').trim(),
  model: String(process.env.AI_SERVER_MODEL || 'deepseek-chat').trim(),
  apiKey: AI_SERVER_KEY
};
function aiServerProvider() {
  return AI_SERVER_PROVIDER.apiKey ? AI_SERVER_PROVIDER : null;
}

const AI_CONN_MAX = 10;

const AI_SCENES = { chat: 'AI 对话', insights: '首页洞察', quickadd: '一句话录入·AI 建档', receipt: '票据识别' };

function aiKey16() { return (rt.db.settings.aiSecretKey || '').slice(0, 16); }

// 判断模型是否支持视觉输入（多模态）。主流视觉模型名常含 vision/vl/v 等标记
function isVisionModel(model) {
  const s = String(model || '').toLowerCase();
  return /vision|[\-_]?vl\b|\bvl[\-_]|glm-4v|gpt-4o|gpt-4\.1|qwen(2|2\.5)?[\-_]vl|step-1v|doubao.*(vision|1\.5|pro)|seed.*vision|minicpm-v|internvl|deepseek-vl|kimi.*vision|gemini-2\.[05]-flash|claude.*vision/i.test(s)
    || /(^|\W)(vl|vlm)(\W|$)/i.test(s);
}

/* v48 全局设置读取（带默认值兜底；db.aiSettings 由 migrateDb 负责初始化） */
function aiSettings() {
  const s = (rt.db.aiSettings && typeof rt.db.aiSettings === 'object') ? rt.db.aiSettings : {};
  const sc = (s.scenes && typeof s.scenes === 'object') ? s.scenes : {};
  const n = parseInt(s.timeoutSec, 10);
  return {
    enabled: s.enabled !== false,
    defaultId: s.defaultId === undefined ? null : s.defaultId,
    timeoutSec: n >= 30 && n <= 3600 ? n : 120,
    scenes: { chat: sc.chat || '', insights: sc.insights || '', quickadd: sc.quickadd || '', receipt: sc.receipt || '' }
  };
}

function aiTimeoutMs() { return aiSettings().timeoutSec * 1000; }

function aiConnOf(id) {
  const n = +id;
  return (Array.isArray(rt.db.aiConnections) ? rt.db.aiConnections : []).find(c => c.id === n) || null;
}

/* 默认连接：aiSettings.defaultId 指向的连接优先（须已配 Key），否则第一个已配 Key 的连接 */
function aiDefaultConn() {
  const st = aiSettings();
  const byDefault = (st.defaultId !== null && st.defaultId !== '') ? aiConnOf(st.defaultId) : null;
  if (byDefault && byDefault.apiKeyEnc) return byDefault;
  return (Array.isArray(rt.db.aiConnections) ? rt.db.aiConnections : []).find(c => c.apiKeyEnc) || null;
}

/* P0-1：区分「压根没配 AI」与「配了但坏了」。
 * 历史缺陷：模型名一旦是空串或明显占位名，上游每次 404 而调用点静默降级，
 * 用户看到成功提示实际 AI 全废。这里显式判为 bad_model 让状态如实上报。
 * v48 通用化：deepseek 前缀规则仅在 baseUrl 确实指向 DeepSeek 时生效。
 * 注意：模型名是否被厂商真正支持无法离线判定，只能挡明显无效值（空/占位/明显笔误）。 */
function aiBadModel(baseUrl, model) {
  const m = String(model || '').trim();
  if (!m) return true;                                   // 空串 = 一定失败
  if (/^(test|mock|xxx+|你的模型名|model|模型)$/i.test(m)) return true;
  // 明显笔误：模型名里不该有的连字符写法（deepseek-flash 等 deepseek 无此模型）
  if (/deepseek/i.test(String(baseUrl || '')) && !/^deepseek-(chat|reasoner|coder)/.test(m)) return true;
  // 与厂商默认模型同前缀但端点对不上的名称，交由上游判断，不下断言
  return false;
}

/** AI 可用性三态：ok / none（未配置或总开关关闭）/ bad_model（配置损坏，调用必失败） */
function aiProviderStatus() {
  const st = aiSettings();
  if (!st.enabled) return { state: 'none', reason: 'AI 总开关已关闭，如需使用请到 AI 设置开启' };
  const conn = aiDefaultConn();
  if (!conn) {
    const srv = aiServerProvider();
    if (srv) return { state: 'ok', provider: { id: srv.id, model: srv.model } };
    return { state: 'none', reason: '尚未配置可用的 AI 提供商，请先在 AI 设置填写 API Key' };
  }
  if (aiBadModel(conn.baseUrl, conn.textModel)) {
    return { state: 'bad_model', provider: { id: conn.id, model: conn.textModel }, reason: '连接「' + conn.label + '」的文本模型名「' + (conn.textModel || '(空)') + '」无效，调用会失败，请到 AI 设置改正' };
  }
  return { state: 'ok', provider: { id: conn.id, model: conn.textModel } };
}

/* P0-1：实测连通性。模型名是否被该账号开通，离线无法判定（qwen-vl-plus 是合法名，
 * 但未开通就会 404），唯一可靠的办法是真发一次最小请求。
 * quick：只发 1 个 token 的短请求，成本可忽略；
 * full（mode==='full'）：真实短补全并返回模型回复，用于「完整测试」。
 * v48 签名改为 (baseUrl, model, apiKeyEnc, mode)，供连接测试/临时值测试复用。 */
async function probeProvider(baseUrl, model, apiKeyEnc, mode) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const mdl = String(model || '').trim();
  let apiKey = '';
  try { apiKey = apiKeyEnc ? aesDecrypt(apiKeyEnc, aiKey16()) : ''; } catch (e) { }
  if (!base || !mdl || !apiKey) return { ok: false, message: '配置不完整（缺少 API 地址 / 模型名 / API Key）' };
  const full = mode === 'full';
  const toMs = Math.min(30000, Math.max(15000, aiTimeoutMs()));
  const t0 = Date.now();
  try {
    const up = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(full
        ? { model: mdl, messages: [{ role: 'user', content: '请用不超过十个字打个招呼' }], max_tokens: 50, stream: false }
        : { model: mdl, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(toMs)
    });
    const raw = await up.text();
    const ms = Date.now() - t0;
    if (!up.ok) {
      // 上游错误信息里通常直接说明原因（model_not_found / invalid_api_key / quota）
      let detail = raw.slice(0, 200);
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error.code)) || (j.message) || detail; } catch (e) { }
      return { ok: false, message: 'HTTP ' + up.status + '：' + String(detail).slice(0, 160), ms };
    }
    if (full) {
      let reply = '';
      try { reply = ((((JSON.parse(raw).choices || [])[0] || {}).message) || {}).content || ''; } catch (e) { }
      if (!reply) return { ok: false, message: '上游 200 但未返回内容（模型名可能无效）', ms };
      return { ok: true, ms, reply: String(reply).slice(0, 120) };
    }
    return { ok: true, ms };
  } catch (e) {
    return { ok: false, message: (e && e.name === 'TimeoutError') ? '连接超时（' + Math.round(toMs / 1000) + 's）' : String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

/* v48：取当前生效连接（返回结构与旧版保持一致 {id,label,baseUrl,model,apiKey}，8 处调用点零改动）。
 * 优先级：场景指定连接（scene 传入且有 Key）→ 默认连接 → 第一个已配 Key 的连接；总开关关闭返回 null。 */
function aiActiveProvider(scene) {
  const st = aiSettings();
  if (!st.enabled) return null;
  let conn = null;
  if (scene && st.scenes[scene]) {
    const sc = aiConnOf(st.scenes[scene]);
    if (sc && sc.apiKeyEnc) conn = sc;       // 场景连接没 Key → 落回默认连接
  }
  if (!conn) conn = aiDefaultConn();
  if (!conn) {
    const srv = aiServerProvider();
    if (srv) return { id: srv.id, label: srv.label, baseUrl: srv.baseUrl, model: srv.model, apiKey: srv.apiKey };
    return null;
  }
  let key = '';
  try { key = aesDecrypt(conn.apiKeyEnc, aiKey16()); } catch (e) { }
  if (!key) return null;
  return { id: conn.id, label: conn.label, baseUrl: conn.baseUrl, model: conn.textModel || '', apiKey: key };
}

/* R06：挑视觉模型（票据/看图任务用，避免被前排文本模型挡住）。
 * 优先级：票据场景指定连接的 visionModel → 该连接文本模型本身是视觉模型 →
 * 第一个配置了 visionModel 的连接 → 默认连接文本模型兜底。 */
function aiVisionProvider() {
  const st = aiSettings();
  if (!st.enabled) return null;
  const keyed = c => {
    if (!c || !c.apiKeyEnc) return null;
    try { return aesDecrypt(c.apiKeyEnc, aiKey16()) || null; } catch (e) { return null; }
  };
  const rc = st.scenes.receipt ? aiConnOf(st.scenes.receipt) : null;
  if (rc) {
    const key = keyed(rc);
    if (key) {
      if (rc.visionModel) return { id: rc.id, label: rc.label, baseUrl: rc.baseUrl, model: rc.visionModel, apiKey: key };
      if (isVisionModel(rc.textModel)) return { id: rc.id, label: rc.label, baseUrl: rc.baseUrl, model: rc.textModel, apiKey: key };
    }
  }
  for (const c of (Array.isArray(rt.db.aiConnections) ? rt.db.aiConnections : [])) {
    if (!c.visionModel) continue;
    const key = keyed(c);
    if (!key) continue;
    return { id: c.id, label: c.label, baseUrl: c.baseUrl, model: c.visionModel, apiKey: key };
  }
  const def = aiDefaultConn();
  const dkey = keyed(def);
  if (dkey && isVisionModel(def.textModel)) return { id: def.id, label: def.label, baseUrl: def.baseUrl, model: def.textModel, apiKey: dkey };
  return null;
}

// 把家庭数据打包成 system prompt，让 AI 能回答「今天任务/临期/账本/纪念日」
function aiBuildContext() {
  const today = todayStr();
  const month = today.slice(0, 7);
  const left = d => d ? Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
  const stName = id => (id === 3 ? '已完成' : id === 2 ? '进行中' : '待处理');
  const todayTasks = rt.db.tasks.filter(t => t.date === today)
    .sort((a, b) => (a.remindTime || '').localeCompare(b.remindTime || ''))
    .map(t => (t.remindTime ? '[' + t.remindTime + '] ' : '') + t.title + '（' + stName(t.statusId) + '）');
  const scheds = rt.db.scheduledTasks.map(decorateSchedule).filter(t => t.enabled);
  const schName = t => t.name || t.title || '周期事项';
  const schedDue = scheds.filter(t => t.daysLeft <= 0).map(t => schName(t) + '（' + t.ruleText + '，' + (t.daysLeft < 0 ? '逾期' + (-t.daysLeft) + '天' : '今天到期') + '）');
  const schedSoon = scheds.filter(t => t.daysLeft > 0 && t.daysLeft <= 7).map(t => schName(t) + '（' + t.ruleText + '，还有' + t.daysLeft + '天）');
  const expiring = rt.db.expiryItems.map(i => ({ n: i.name, d: i.expiryDate, l: left(i.expiryDate) }))
    .filter(i => i.l !== null && i.l <= 30).sort((a, b) => a.l - b.l).map(i => i.n + '：' + (i.l < 0 ? '已过期' + (-i.l) + '天' : i.l + '天后到期'));
  const anns = rt.db.anniversaries.map(a => {
    let l = a.repeat === 'yearly' || a.type === 'count-up' ? daysToNextYearly(a.date) : left(a.date);
    return { n: a.title || a.name, l };
  }).filter(a => a.l !== null && a.l <= 30).sort((a, b) => a.l - b.l).map(a => a.n + '：还有' + a.l + '天');
  const birth = rt.db.familyMembers.filter(m => m.birthday).map(m => ({ n: m.name, l: daysToNextYearly(m.birthday) }))
    .filter(m => m.l <= 30).sort((a, b) => a.l - b.l).map(m => m.name + '生日：还有' + m.l + '天');
  const led = ledgerSummaryOf(month);
  const notes = rt.db.notes.slice(-5).reverse().map(n => (n.title || '（无标题）'));
  // 近 30 天复诊计划（健康提醒喂给 AI 上下文）
  const checkupSoon = [];
  rt.db.healthProfiles.forEach(h => {
    const fm = rt.db.familyMembers.find(x => x.id === h.memberId);
    const nm = fm ? fm.name : '';
    (h.checkups || []).forEach(c => {
      const l = left(c.nextDate);
      if (l !== null && l >= 0 && l <= 30) checkupSoon.push(nm + '·' + (c.name || '复诊') + '（' + c.nextDate + '，' + l + '天后）');
    });
  });
  return { today, month, todayTasks, schedDue, schedSoon, expiring, anns, birth, led, notes, checkupSoon };
}

function aiSystemPrompt(pageContext) {
  const c = aiBuildContext();
  const d = new Date(c.today + 'T00:00:00');
  const lines = [];
  lines.push('你是「生活驾驶舱」家庭生活管理应用内的 AI 助手，名叫小驾。用简体中文回答，语气亲切简洁，善用短段落和列表。');
  lines.push('回答要落地：能基于下面给的真实数据就直接给结论和行动建议，不要复述原始 JSON。');
  lines.push('涉及钱、日期、数量时必须与数据一致，不确定就说明数据里没有。不要编造功能。');
  lines.push('本应用功能模块：生活驾驶舱(首页)、日历事务、周期提醒、备忘手记、家庭成员、纪念日、家庭账本、人情记账、证件效期、位置轨迹日记、我的足迹、保险库、贷款计算、通用配置。');
  lines.push('用户问「记一笔/加个事务/设置提醒」这类写操作时，引导他去对应页面（应用暂不支持对话内直接写入），并给出具体步骤。');
  lines.push('');
  lines.push('【今天是】' + c.today + ' ' + (['日', '一', '二', '三', '四', '五', '六'][d.getDay()]) + '（账本月份 ' + c.month + '）');
  lines.push('【今日事务 ' + c.todayTasks.length + ' 条】' + (c.todayTasks.join('；') || '无'));
  lines.push('【周期提醒·今天到期 ' + c.schedDue.length + ' 条】' + (c.schedDue.join('；') || '无'));
  lines.push('【周期提醒·7 天内 ' + c.schedSoon.length + ' 条】' + (c.schedSoon.join('；') || '无'));
  lines.push('【档案库 30 天内到期 ' + c.expiring.length + ' 件】' + (c.expiring.join('；') || '无'));
  lines.push('【30 天内纪念日】' + (c.anns.join('；') || '无'));
  lines.push('【30 天内家人生日】' + (c.birth.join('；') || '无'));
  lines.push('【近 30 天复诊计划】' + ((c.checkupSoon && c.checkupSoon.join('；')) || '无'));
  lines.push('【本月账本】支出 ' + c.led.expense.toFixed(2) + ' 元（含人情 ' + c.led.giftExpense.toFixed(2) + '），收入 ' + c.led.income.toFixed(2) + ' 元，结余 ' + c.led.net.toFixed(2) + ' 元，共 ' + c.led.count + ' 笔');
  const topCat = (c.led.byCategory.expense || []).slice(0, 3).map(x => x.name + ' ' + x.amount.toFixed(2) + '元(' + x.percent + '%)').join('、');
  lines.push('【本月支出构成 TOP3】' + (topCat || '无'));
  lines.push('【最近手记】' + (c.notes.join('、') || '无'));
  if (pageContext) {
    const ctx = String(pageContext).replace(/[\u0000-\u001f]/g, ' ').slice(0, 600);
    lines.push('');
    lines.push('【用户当前所在页面】' + ctx + '（回答时优先结合这个页面做建议，必要时提示他就在这个页面可以直接操作）');
  }
  return lines.join('\n');
}

module.exports = {
  aiCompleteOnce,
  AI_CONN_MAX,
  AI_CONN_PRESETS,
  AI_PROVIDERS,
  AI_SCENES,
  aiActiveProvider,
  aiBadModel,
  aiBuildContext,
  aiConnOf,
  aiDefaultConn,
  aiKey16,
  aiProviderStatus,
  aiServerProvider,
  aiSettings,
  aiSystemPrompt,
  aiTimeoutMs,
  aiVisionProvider,
  isVisionModel,
  probeProvider,
};

/* =================== AI 单次补全 + 一句话落库 =================== */
async function aiCompleteOnce(prompt, system, temperature, scene) {
  const provider = aiActiveProvider(scene);
  if (!provider) throw new Error('未配置可用的 AI 提供商');
  const base = (provider.baseUrl || '').replace(/\/+$/, '');
  const up = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'system', content: system || '你是助手。' }, { role: 'user', content: prompt }],
      stream: false, temperature: temperature === undefined ? 0.6 : temperature
    }),
    signal: AbortSignal.timeout(aiTimeoutMs())
  });
  const raw = await up.text();
  if (!up.ok) throw new Error('AI 服务返回 ' + up.status + '：' + raw.slice(0, 200));
  const j = JSON.parse(raw);
  const text = ((((j.choices || [])[0] || {}).message) || {}).content || '';
  if (!text) throw new Error('AI 未返回内容');
  return text;
}
