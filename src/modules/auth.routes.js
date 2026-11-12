'use strict';
/* auth —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L1224] if (pathname === '/api/auth/wechat-login' && method === 'POST') */
    router.post('/api/auth/wechat-login', async function (ctx) {
      const { req, res, q, url, method, pathname, uid, db } = ctx;
      const { SKIP_PWD_GUARD, buildTokenCookie, crypto, fail, newId, newToken, ok, readBody, saveDb, saveSessions, sessions, wxJsCode2Session } = app;
    const body = await readBody(req);
    const code = (body.code || '').trim();
    if (!code) return fail(res, '缺少 login code', 400);
    const sess = await wxJsCode2Session(code);
    if (!sess || !sess.openid) return fail(res, '微信登录失败', 401);
    let user = db.users.find(u => u.wechatOpenid === sess.openid);
    if (!user) {
      // 首次微信登录：用 openid 派生用户名自动建号（无密码）
      const uname = 'wx_' + sess.openid.slice(-8);
      user = { id: newId(db), username: uname, salt: crypto.randomBytes(8).toString('hex'), passwordHash: 'wechat', role: 'user', themeColor: db.settings.themeColor || 'green', wechatOpenid: sess.openid, wechatSubscribe: null };
      db.users.push(user); saveDb();
    }
    const token = newToken();
    sessions[token] = { userId: user.id, username: user.username, expireAt: Date.now() + 86400 * 1000 };
    saveSessions();
    return ok(res, {
      token, username: user.username, userId: user.id, role: user.role,
      themeColor: user.themeColor || 'green', refreshToken: null,
      mustChangePassword: !!user.mustChangePassword && db.settings.requirePwdChange !== false && !SKIP_PWD_GUARD,
      defaultSpaceId: 0, defaultSpaceName: '个人空间'
    }, '登录成功', { 'Set-Cookie': buildTokenCookie(req, token) });
    }, { auth: 'public', order: 1224, note: '登录接口本身；用微信 code2Session 换身份，此时还没有会话' });

    /* [L1247] if (pathname === '/api/auth/login' && method === 'POST') */
    router.post('/api/auth/login', async function (ctx) {
      const { req, res, q, url, method, pathname, uid, db } = ctx;
      const { SKIP_PWD_GUARD, buildTokenCookie, fail, hashPassword, loginFails, loginThrottleFail, loginThrottleKey, loginThrottleWait, newToken, ok, readBody, saveDb, saveSessions, sessions, sha256, verifyPassword } = app;
    const body = await readBody(req);
    const uname = (body.username || '').trim();
    const tKey = loginThrottleKey(req, uname);
    const lockedS = loginThrottleWait(tKey);
    if (lockedS > 0) {
      return fail(res, '尝试次数过多，请 ' + lockedS + ' 秒后再试', 429);
    }
    const user = db.users.find(u => u.username === uname);
    if (!user || !verifyPassword(user, body.password || '')) {
      const st = loginThrottleFail(tKey);
      return st.waitS > 0
        ? fail(res, '尝试次数过多，请 ' + st.waitS + ' 秒后再试', 429)
        : fail(res, '用户名或密码错误', 400);
    }
    loginFails.delete(tKey);
    // 旧 sha256 格式登录成功后，惰性升级为 PBKDF2 并落盘
    if (!String(user.passwordHash).startsWith('pbkdf2:')) {
      user.passwordHash = hashPassword(body.password || '', user.salt);
      saveDb();
    }
    const token = newToken();
    sessions[token] = { userId: user.id, username: user.username, expireAt: Date.now() + 86400 * 1000 };
    saveSessions();
    return ok(res, {
      token, username: user.username, userId: user.id, role: user.role,
      themeColor: user.themeColor || 'green', refreshToken: null,
      mustChangePassword: !!user.mustChangePassword && db.settings.requirePwdChange !== false && !SKIP_PWD_GUARD,
      defaultSpaceId: 0, defaultSpaceName: '个人空间'
    }, '登录成功', { 'Set-Cookie': buildTokenCookie(req, token) });
    }, { auth: 'public', order: 1247, note: '登录接口本身；带登录失败限流与密码迁移，无会话可校验' });

    /* [L1278] if (pathname === '/api/auth/config' && method === 'GET') */
    router.get('/api/auth/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, { allowRegistration: !!db.settings.allowRegistration });
    }, { auth: 'public', order: 1278, note: '登录页需要知道是否开放注册；只返回一个布尔值，不含任何账号信息' });

    /* [L1282] if (pathname === '/api/auth/logout' && method === 'POST') */
    router.post('/api/auth/logout', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildClearTokenCookie, ok, saveSessions, sessions } = app;
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
    const auth = req.headers.authorization || '';
    const token = m ? m[1] : (auth.startsWith('Bearer ') ? auth.slice(7) : null);
    if (token && sessions[token]) { delete sessions[token]; saveSessions(); }
    return ok(res, null, '已登出', { 'Set-Cookie': buildClearTokenCookie(req) });
    }, { auth: 'public', order: 1282, note: '登出必须允许无有效会话调用：会话已过期时仍要能清掉 Cookie' });

    /* [L1299] if (pathname === '/api/auth/register' && method === 'POST') */
    router.post('/api/auth/register', async function (ctx) {
      const { req, res, q, url, method, pathname, uid, db } = ctx;
      const { buildTokenCookie, crypto, fail, hashPassword, newId, newToken, ok, readBody, saveDb, saveSessions, sessions } = app;
    if (!db.settings.allowRegistration) return fail(res, '当前未开放注册');
    const body = await readBody(req);
    const username = (body.username || '').trim();
    if (!username || (body.password || '').length < 6) return fail(res, '用户名或密码不符合要求');
    if (db.users.find(u => u.username === username)) return fail(res, '用户名已存在');
    const salt = crypto.randomBytes(8).toString('hex');
    const user = { id: newId(db), username, salt, passwordHash: hashPassword(body.password, salt), role: 'user', themeColor: db.settings.themeColor || 'green' };
    db.users.push(user); saveDb();
    const token = newToken();
    sessions[token] = { userId: user.id, username: user.username, expireAt: Date.now() + 86400 * 1000 };
    saveSessions();
    return ok(res, { token, username, userId: user.id, role: 'user', themeColor: user.themeColor, defaultSpaceId: 0, defaultSpaceName: '个人空间' }, '注册成功', { 'Set-Cookie': buildTokenCookie(req, token) });
    }, { auth: 'public', order: 1299, note: '注册接口本身；是否开放由 settings.allowRegistration 控制，关闭时直接 400' });

    /* [L1450] if (pathname === '/api/users/change-password' && method === 'PUT') */
    router.put('/api/users/change-password', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { crypto, fail, hashPassword, ok, readBody, saveDb, verifyPassword } = app;
    const body = await readBody(req);
    if (!verifyPassword(user, body.oldPassword || '')) return fail(res, '原密码错误');
    if ((body.newPassword || '').length < 6) return fail(res, '新密码至少6位');
    if (body.newPassword === body.oldPassword) return fail(res, '新密码不能与原密码相同');
    user.salt = crypto.randomBytes(8).toString('hex');
    user.passwordHash = hashPassword(body.newPassword, user.salt);
    user.mustChangePassword = false;
    saveDb();
    return ok(res, { mustChangePassword: false }, '密码修改成功');
    }, { auth: 'user', order: 1450 });

    /* [L1461] if (pathname === '/api/push/subscribe' && method === 'POST') */
    router.post('/api/push/subscribe', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const tmplId = (body.tmplId || (db.settings.wechat && db.settings.wechat.templateId) || '').trim();
    if (!tmplId) return fail(res, '未配置订阅模板', 400);
    user.wechatSubscribe = { tmplId, grantedAt: Date.now() };
    saveDb();
    return ok(res, { ok: true }, '已开启消息提醒');
    }, { auth: 'user', order: 1461 });

    /* [L1469] if (pathname === '/api/users/me' && method === 'GET') */
    router.get('/api/users/me', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { SKIP_PWD_GUARD, ok, wechatSubValid } = app;
    return ok(res, {
      id: user.id, username: user.username, role: user.role, themeColor: user.themeColor, theme: db.settings.theme || 'light',
      mustChangePassword: !!user.mustChangePassword && db.settings.requirePwdChange !== false && !SKIP_PWD_GUARD,
      wechatSubscribed: !!(user.wechatSubscribe && wechatSubValid(user.wechatSubscribe))
    });
    }, { auth: 'user', order: 1469 });

    /* [L2112] if (pathname === '/api/push/test' && method === 'POST') */
    router.post('/api/push/test', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildPushMessage, fail, ok, sendPush } = app;
    const r = await sendPush(buildPushMessage(true));
    if (r.ok) return ok(res, { detail: r.detail }, '测试消息已发送，请查看手机');
    return fail(res, '发送失败：' + (r.detail || '未知错误'), 502);
    }, { auth: 'user', order: 2112 });

    /* [L2118] if (pathname === '/api/push/preview' && method === 'GET') */
    router.get('/api/push/preview', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildPushMessage, ok, pushCfg } = app;
    const p = pushCfg();
    return ok(res, { text: buildPushMessage(false), enabled: !!p.enabled, hasWebhook: !!p.webhook, channel: p.channel });
    }, { auth: 'user', order: 2118 });

    /* [L4474] if (pathname === '/api/users' && method === 'GET') */
    router.get('/api/users', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, isAdmin, ok } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可查看用户列表', 403);
    return ok(res, db.users.map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt || '' })));
    }, { auth: 'user', order: 4474, role: 'admin' });

    /* [L4479] if (pathname === '/api/users' && method === 'POST') */
    router.post('/api/users', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { crypto, fail, hashPassword, isAdmin, newId, nowStr, ok, readBody, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可创建/管理用户', 403);
    const body = await readBody(req);
    const username = (body.username || '').trim();
    if (!username || !body.password) return fail(res, '用户名和密码不能为空');
    if (body.password.length < 6) return fail(res, '密码至少6位');
    if (db.users.some(u => u.username === username)) return fail(res, '用户名已存在');
    const salt = crypto.randomBytes(8).toString('hex');
    /* 口令统一走 PBKDF2（hashPassword），不再写裸 sha256(pwd+salt) 的旧格式；
       role 只接受 admin/user 两档，避免请求体塞入任意角色字符串。 */
    const nu = { id: newId(db), username, salt, passwordHash: hashPassword(body.password, salt), role: body.role === 'admin' ? 'admin' : 'user', themeColor: 'green', createdAt: nowStr() };
    db.users.push(nu); saveDb();
    return ok(res, { id: nu.id, username: nu.username }, '用户已添加');
    }, { auth: 'user', order: 4479, role: 'admin' });

    /* [L4522] if (pathname === '/api/users/me' && method === 'PUT') */
    router.put('/api/users/me', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const username = (body.username || '').trim();
    if (!username) return fail(res, '用户名不能为空');
    if (db.users.some(u => u.username === username && u.id !== user.id)) return fail(res, '用户名已被占用');
    user.username = username; saveDb();
    return ok(res, { id: user.id, username: user.username }, '用户名已更新');
    }, { auth: 'user', order: 4522 });

    /* [L4492] if ((m = pathname.match(/^\/api\/users\/(\d+)\/password$/)) && method === 'PUT') */
    router.match(/^\/api\/users\/(\d+)\/password$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { crypto, fail, hashPassword, ok, readBody, saveDb, saveSessions, sessions } = app;
    /* P0-2：重置任意用户密码是管理员操作。旧实现只要求登录，任何普通用户
       都能把 admin 的密码改掉并接管实例，且用的是弱哈希 sha256(pwd+salt)。 */
    if (!user || user.role !== 'admin') return fail(res, '仅管理员可重置用户密码', 403);
    const body = await readBody(req);
    if (!body.password || body.password.length < 6) return fail(res, '新密码至少6位');
    const target = db.users.find(u => u.id === +m[1]);
    if (!target) return fail(res, '用户不存在', 404);
    target.salt = crypto.randomBytes(8).toString('hex');
    target.passwordHash = hashPassword(body.password, target.salt);
    target.mustChangePassword = true;   // 重置的是管理员设定的临时口令，首次登录须自行修改
    /* 旧会话必须立即失效，否则拿着旧 token 仍可继续操作 */
    for (const t of Object.keys(sessions)) { if (sessions[t] && sessions[t].userId === target.id) delete sessions[t]; }
    saveSessions();
    saveDb();
    return ok(res, null, '密码已重置');
    }, { auth: 'user', order: 4492, method: 'PUT', role: 'admin' });

    /* [L4504] if ((m = pathname.match(/^\/api\/users\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/users\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, isAdmin, ok, saveDb, saveSessions, sessions } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可删除用户', 403);
    const tid = +m[1];
    const target = db.users.find(u => u.id === tid);
    if (!target) return fail(res, '用户不存在', 404);
    if (target.id === user.id) return fail(res, '不能删除当前登录的自己');
    if (target.role === 'admin') {
      const adminCount = db.users.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) return fail(res, '必须保留至少一个管理员');
    }
    db.users = db.users.filter(u => u.id !== tid);
    // 同时失效该用户的所有会话，避免已登录态残留
    for (const t of Object.keys(sessions)) { if (sessions[t] && sessions[t].userId === tid) delete sessions[t]; }
    saveSessions();
    saveDb();
    return ok(res, { id: tid, username: target.username }, '用户已删除');
    }, { auth: 'user', order: 4504, method: 'DELETE', role: 'admin' });
};
