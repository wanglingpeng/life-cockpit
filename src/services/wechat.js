/* 微信生态：code2Session 换身份、access_token 缓存、订阅消息下发。
 *
 * _wxToken / _wxTokenExpire 是 access_token 的模块内缓存（标 internal
 * 不导出）：导出去就是一份永远为 null 的快照，后来者照着用必错——
 * token 缓存必须和读写它的函数同模块，这是缓存正确性的位置要求。
 *
 * 安全（P0-2）：MOCK 只在显式设置 MOCK_WECHAT=1 时启用。旧逻辑是
 * 「没配 appSecret 就自动静默转 MOCK」，而默认部署恰恰没配密钥——
 * 任意人拿任意 code 都能换到 mock_openid，/api/auth/wechat-login 还会
 * 自动建号发会话，等于完全绕过登录。现在未配密钥时登录必须失败，
 * 绝不降级成一个「可登录身份」。MOCK 仅用于本地开发/自动化测试。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区中段的微信段）。 */
const https = require('https');
const rt = require('../core/runtime');
const { fillTpl, wechatSubValid } = require('./utils');

/* =================== 微信小程序（登录 / 订阅消息推送） =================== */
let _wxToken = '';

let _wxTokenExpire = 0;

function wxMockMode() { return process.env.MOCK_WECHAT === '1'; }

async function getWxAccessToken() {
  const w = rt.db.settings.wechat || {};
  if (wxMockMode()) { _wxToken = 'MOCK_TOKEN'; _wxTokenExpire = Date.now() + 7200 * 1000; return _wxToken; }
  if (!w.appId || !w.appSecret) return '';
  if (_wxToken && Date.now() < _wxTokenExpire) return _wxToken;
  try {
    const u = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(w.appId) + '&secret=' + encodeURIComponent(w.appSecret);
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.access_token) { _wxToken = j.access_token; _wxTokenExpire = Date.now() + (j.expires_in || 7200) * 1000 - 60000; return _wxToken; }
  } catch (e) { /* ignore */ }
  return '';
}

async function wxJsCode2Session(code) {
  const w = rt.db.settings.wechat || {};
  if (wxMockMode()) return { openid: 'mock_openid_' + (code || 'x'), session_key: 'mock_sk' };
  /* 没配密钥就没有任何可信任的身份来源：直接拒绝，不再发出注定失败的
     请求，更不能回落成 MOCK 身份（否则登录接口会自动建号）。 */
  if (!w.appId || !w.appSecret || !code) return null;
  try {
    const u = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(w.appId) + '&secret=' + encodeURIComponent(w.appSecret) + '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.openid) return { openid: j.openid, session_key: j.session_key || '' };
  } catch (e) { /* ignore */ }
  return null;
}

async function sendWechatSubscribe(openid, text) {
  const w = rt.db.settings.wechat || {};
  if (!w.templateId) return { ok: false, detail: '未配置模板' };
  const token = await getWxAccessToken();
  if (!token) return { ok: false, detail: 'access_token 获取失败' };
  const data = {};
  const fields = (w.tplFields && w.tplFields.length)
    ? w.tplFields
    : (w.tplData ? Object.keys(w.tplData).map(k => ({ key: k, label: k, value: (w.tplData[k] && w.tplData[k].value !== undefined) ? w.tplData[k].value : '' })) : []);
  fields.forEach(f => { if (f && f.key) data[f.key] = { value: fillTpl(f.value, text) }; });
  const body = { touser: openid, template_id: w.templateId, page: w.page || 'pages/dashboard/dashboard', data, miniprogram_state: 'formal' };
  if (wxMockMode()) return { ok: true, detail: 'MOCK sent', body };
  try {
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    return { ok: j.errcode === 0, detail: j.errmsg || '' };
  } catch (e) { return { ok: false, detail: (e && e.message) || 'send fail' }; }
}

async function sendWechatSubscribeToAll(text) {
  let sent = 0, fail = 0;
  for (const u of rt.db.users) {
    if (!u.wechatOpenid || !wechatSubValid(u.wechatSubscribe)) continue;
    const r = await sendWechatSubscribe(u.wechatOpenid, text);
    if (r.ok) sent++; else fail++;
  }
  return { sent, fail };
}

module.exports = {
  getWxAccessToken,
  sendWechatSubscribe,
  sendWechatSubscribeToAll,
  wxJsCode2Session,
  wxMockMode,
};
