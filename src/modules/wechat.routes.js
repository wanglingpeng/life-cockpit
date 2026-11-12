'use strict';
/* wechat —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L1220] if (pathname === '/api/wechat/config' && method === 'GET') */
    router.get('/api/wechat/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const w = db.settings.wechat || {};
    return ok(res, { appId: w.appId || '', templateId: w.templateId || '', page: w.page || '', appSecretSet: !!w.appSecret, tplFields: Array.isArray(w.tplFields) ? w.tplFields : [] });
    }, { auth: 'public', order: 1220, note: '小程序端未登录时读取 AppId/模板字段；appSecret 只回传「是否已设置」布尔值，不泄露' });
};
