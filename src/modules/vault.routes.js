'use strict';
/* vault —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L3531] if (pathname === '/api/vault/status' && method === 'GET') */
    router.get('/api/vault/status', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { ok} = app;
    const byKind = {};
    db.vaultEntries.forEach(e => { const k = e.kind || 'password'; byKind[k] = (byKind[k] || 0) + 1; });
    return ok(res, { masterSet: !!db.vaultMaster, unlocked: !!state.vaultEncKey, count: db.vaultEntries.length, byKind });
    }, { auth: 'user', order: 3531 });

    /* [L3536] if (pathname === '/api/vault/master' && method === 'POST') */
    router.post('/api/vault/master', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { KDF_ITER, aesDecrypt, aesEncrypt, crypto, fail, ok, readBody, saveDb, sha256} = app;
    const body = await readBody(req);
    const pw = body.masterPassword || '';
    if (pw.length < 6) return fail(res, '主密码至少6位');
    const mkVaultV2 = (encKeyHex, pwPlain) => {
      const salt = crypto.randomBytes(16).toString('hex'), iter = KDF_ITER;
      const dk = crypto.pbkdf2Sync(pwPlain, salt, iter, 32, 'sha256').toString('hex');
      /* verifier 由裸 sha256(dk) 升级为 HMAC-SHA256(key=salt, msg=dk)，前缀 hmac: 与旧格式共存 */
      return { v: 2, salt, iter, verifier: 'hmac:' + crypto.createHmac('sha256', String(salt)).update(dk).digest('hex'), encKeyEnc: aesEncrypt(encKeyHex, dk.slice(0, 16)) };
    };
    if (db.vaultMaster) {
      const vm = db.vaultMaster;
      if (vm.v === 2) {
        const dk = crypto.pbkdf2Sync(pw, vm.salt, vm.iter, 32, 'sha256').toString('hex');
        /* 新旧 verifier 兼容：hmac: 前缀走 HMAC 校验，旧库 sha256(dk) 原样校验 */
        const vOk = String(vm.verifier).startsWith('hmac:')
          ? crypto.createHmac('sha256', String(vm.salt)).update(dk).digest('hex') === String(vm.verifier).slice(5)
          : vm.verifier === sha256(dk);
        if (!vOk) return fail(res, '主密码错误');
        const encKey = aesDecrypt(vm.encKeyEnc, dk.slice(0, 16));
        if (!encKey) return fail(res, '保险库密钥数据异常，无法解锁');
        state.vaultEncKey = encKey;
        return ok(res, { encKey: state.vaultEncKey }, '解锁成功');
      }
      // 旧版（v1：sha256 单次哈希 + encKey 明文落盘）→ 校验通过后平滑升级为 v2
      if (vm.hash !== sha256(pw + vm.salt)) return fail(res, '主密码错误');
      db.vaultMaster = mkVaultV2(vm.encKey, pw);
      state.vaultEncKey = vm.encKey; saveDb();
      return ok(res, { encKey: state.vaultEncKey }, '解锁成功（安全架构已自动升级）');
    }
    const encKey = crypto.randomBytes(16).toString('hex');
    db.vaultMaster = mkVaultV2(encKey, pw);
    state.vaultEncKey = encKey; saveDb();
    return ok(res, { encKey }, '主密码设置成功');
    }, { auth: 'user', order: 3536 });

    /* [L3571] if (pathname === '/api/vault/lock' && method === 'POST') */
    router.post('/api/vault/lock', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { ok} = app;
    state.vaultEncKey = null;
    return ok(res, null, '保险库已重新锁定');
    }, { auth: 'user', order: 3571 });

    /* [L3576] if (pathname === '/api/vault/entries' && method === 'GET') */
    router.get('/api/vault/entries', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { aesDecrypt, fail, ok, vaultLocked } = app;
    if (vaultLocked()) return fail(res, '保险库已锁定，请先解锁', 423);
    const key = state.vaultEncKey || '';
    const kind = q.get('kind');
    let list = db.vaultEntries.map(e => ({
      id: e.id, title: e.title, username: e.username,
      password: aesDecrypt(e.passwordEnc, key), secret: aesDecrypt(e.secretEnc, key),
      kind: e.kind || 'password', holder: e.holder || '', expireDate: e.expireDate || '',
      memberId: e.memberId || null, url: e.url, remark: e.remark
    }));
    if (kind) list = list.filter(e => e.kind === kind);
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return ok(res, list);
    }, { auth: 'user', order: 3576 });

    /* [L3591] if (pathname === '/api/vault/expiring' && method === 'GET') */
    router.get('/api/vault/expiring', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { aesDecrypt, ok, todayStr, vaultLocked } = app;
    const days = Math.max(1, +(q.get('days') || 60));
    const today = todayStr();
    const key = state.vaultEncKey || '';
    const list = db.vaultEntries.filter(e => e.expireDate).map(e => {
      const left = Math.round((new Date(e.expireDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      return { id: e.id, title: e.title, kind: e.kind || 'password', holder: e.holder || '', expireDate: e.expireDate, left, secret: vaultLocked() ? '' : aesDecrypt(e.secretEnc, key) };
    }).filter(e => e.left <= days).sort((a, b) => a.left - b.left);
    return ok(res, list);
    }, { auth: 'user', order: 3591 });

    /* [L3601] if (pathname === '/api/vault/entries' && method === 'POST') */
    router.post('/api/vault/entries', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const { aesEncrypt, fail, newId, ok, readBody, saveDb, vaultLocked } = app;
    const body = await readBody(req);
    if (!body.title) return fail(res, '标题不能为空');
    const kind = body.kind || 'password';
    if (kind === 'password' && !body.password) return fail(res, '密码不能为空');
    if (kind !== 'password' && !body.secret) return fail(res, '证件号/卡号不能为空');
    if (!db.vaultMaster) return fail(res, '请先在设置页设置保险库主密码', 400);
    if (vaultLocked()) return fail(res, '保险库已锁定，请先解锁', 423);
    const key = state.vaultEncKey;
    const e = {
      id: newId(db), title: body.title, kind,
      username: body.username || '',
      passwordEnc: body.password ? aesEncrypt(body.password, key) : '',
      secretEnc: body.secret ? aesEncrypt(body.secret, key) : '',
      holder: body.holder || '', expireDate: body.expireDate || '',
      memberId: body.memberId ? +body.memberId : null,
      url: body.url || '', remark: body.remark || ''
    };
    db.vaultEntries.push(e); saveDb(); return ok(res, { id: e.id }, '创建成功');
    }, { auth: 'user', order: 3601 });

    /* [L3621] if ((m = pathname.match(/^\/api\/vault\/entries\/(\d+)$/))) */
    router.match(/^\/api\/vault\/entries\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { aesEncrypt, fail, ok, readBody, saveDb, vaultLocked } = app;
    const e = db.vaultEntries.find(x => x.id === +m[1]);
    if (!e) return fail(res, '条目不存在', 404);
    if (!db.vaultMaster) return fail(res, '请先在设置页设置保险库主密码', 400);
    if (vaultLocked()) return fail(res, '保险库已锁定，请先解锁', 423);
    if (method === 'PUT') {
      const body = await readBody(req);
      ['title', 'username', 'url', 'remark', 'kind', 'holder', 'expireDate'].forEach(k => { if (body[k] !== undefined) e[k] = body[k]; });
      if (body.memberId !== undefined) e.memberId = body.memberId ? +body.memberId : null;
      if (body.password !== undefined) e.passwordEnc = body.password ? aesEncrypt(body.password, state.vaultEncKey) : '';
      if (body.secret !== undefined) e.secretEnc = body.secret ? aesEncrypt(body.secret, state.vaultEncKey) : '';
      saveDb(); return ok(res, null, '更新成功');
    }
    if (method === 'DELETE') {
      db.vaultEntries = db.vaultEntries.filter(x => x.id !== e.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 3621 });
};
