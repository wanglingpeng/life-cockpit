'use strict';
/* settings —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L1291] if (pathname === '/api/version' && method === 'GET') */
    router.get('/api/version', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { APP_VERSION, STARTED_AT, ok } = app;
    return ok(res, { version: APP_VERSION, startedAt: STARTED_AT });
    }, { auth: 'public', order: 1291, note: '版本/启动时间探针，供部署脚本与「有新版本」提示使用，不含业务数据' });

    /* [L1296] if (pathname === '/api/ping' && method === 'GET') */
    router.get('/api/ping', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { APP_VERSION, ok } = app;
    return ok(res, { status: 'ok', version: APP_VERSION });
    }, { auth: 'public', order: 1296, note: '存活探针，只回 status 与版本号' });

    /* [L1661] if (pathname === '/api/onboarding/status' && method === 'GET') */
    router.get('/api/onboarding/status', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { backupStatus, ok } = app;
    const bstat = backupStatus();
    const cloudLast = (db.settings.storageApi && db.settings.storageApi.lastBackup) || null;
    return ok(res, {
      counts: {
        tasks: db.tasks.length,
        notes: db.notes.length,
        ledgerRecords: db.ledgerRecords.length,
        familyMembers: db.familyMembers.length,
        anniversaries: db.anniversaries.length,
        vaultEntries: db.vaultEntries.length,
        scheduledTasks: db.scheduledTasks.length,
        giftRecords: db.giftRecords.length,
        footprints: db.footprints.length
      },
      pwdChanged: !user.mustChangePassword,
      backupDone: !!(bstat.dirCount > 0 || (cloudLast && cloudLast.result === 'ok'))
    });
    }, { auth: 'user', order: 1661 });

    /* [L1964] if (pathname === '/api/modules' && method === 'GET') */
    router.get('/api/modules', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { BUILTIN_MODULES, ensureModules, ok } = app;
    ensureModules();
    const list = BUILTIN_MODULES.map(m => Object.assign({}, m, db.modules[m.module_id] || { status: 'enabled' }));
    return ok(res, list);
    }, { auth: 'user', order: 1964 });

    /* [L1969] if (pathname === '/api/modules' && method === 'PUT') */
    router.put('/api/modules', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { BUILTIN_MODULES, ensureModules, fail, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    ensureModules();
    const mid = String(body.module_id || '');
    if (!BUILTIN_MODULES.find(m => m.module_id === mid)) return fail(res, '未知模块', 404);
    // 核心模块保护：首页和模块管理本身不能禁用，否则无法进入管理
    const PROTECTED = ['dashboard', 'admin-modules'];
    if (body.status === 'disabled' && PROTECTED.includes(mid)) {
      return fail(res, '「今日驾驶舱」和「模块管理」为核心模块，不可禁用');
    }
    if (body.status !== undefined) {
      if (!db.modules[mid]) db.modules[mid] = { config: {} };
      db.modules[mid].status = body.status === 'disabled' ? 'disabled' : 'enabled';
      db.modules[mid].updatedAt = new Date().toISOString().slice(0,10);
    }
    if (body.config && typeof body.config === 'object') {
      db.modules[mid].config = Object.assign(db.modules[mid].config || {}, body.config);
    }
    saveDb();
    return ok(res, db.modules[mid]);
    }, { auth: 'user', order: 1969 });

    /* [L1991] if (pathname === '/api/modules/disabled' && method === 'GET') */
    router.get('/api/modules/disabled', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ensureModules, ok } = app;
    ensureModules();
    const disabled = Object.keys(db.modules).filter(k => db.modules[k].status === 'disabled');
    return ok(res, disabled);
    }, { auth: 'user', order: 1991 });

    /* [L1999] if (pathname === '/api/changelog' && method === 'GET') */
    router.get('/api/changelog', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fs, ok } = app;
    const cp = require('child_process');
    const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
    const limit = Math.min(100, parseInt(url.searchParams.get('limit')) || 30);
    let entries = [];
    let total = 0;
    try {
      // git 可能不在系统 PATH，显式探测常见安装路径。execFileSync 不走 shell，避免 | 被当管道。
      const gitBin = process.env.GIT_BIN
        || ['C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\bin\\git.exe', 'git']
          .find(p => { try { return fs.existsSync(p); } catch (e) { return p === 'git'; } });
      const run = args => cp.execFileSync(gitBin, args, { cwd: __dirname, encoding: 'utf8', timeout: 8000, env: Object.assign({}, process.env, { PATH: 'C:\\Program Files\\Git\\bin;' + (process.env.PATH || '') }) });
      // 一次拉全量 commit 计数（不截断，避免总数错），再按 offset 切片
      const all = run(['log', '--pretty=format:%h|%s|%ad', '--date=iso-strict']);
      const lines = all.split('\n').filter(Boolean);
      total = lines.length;
      const parse = ls => ls.map(line => {
        const [hash, title, date] = line.split('|');
        let type = 'other';
        if (/^feat/i.test(title)) type = 'feat';
        else if (/^fix/i.test(title)) type = 'fix';
        else if (/^style|refactor|^perf|^docs/i.test(title)) type = 'style';
        return { type, badge: { feat: '新增', fix: '修复', style: '优化', other: '更新' }[type], title: String(title || '').replace(/^(feat|fix|style|refactor|perf|docs|chore)\s*[:：]?\s*/i, ''), date: String(date || ''), hash };
      });
      entries = parse(lines.slice(offset, offset + limit));
    } catch (e) {
      entries = [];
    }
    return ok(res, { list: entries, total, offset, limit });
    }, { auth: 'user', order: 1999 });

    /* [L2040] if (pathname === '/api/store' && method === 'GET') */
    router.get('/api/store', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { STORE_DEMO, ok, path } = app;
    const storeUrl = (db.settings && db.settings.storeUrl) || '';
    if (storeUrl) {
      try {
        const urllib = require('url');
        const u = new URL(storeUrl);
        const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'shiquan-manager' } };
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        const data = await new Promise((resolve, reject) => {
          const rq = mod.request(opts, (rs) => { let buf = ''; rs.on('data', c => buf += c); rs.on('end', () => resolve(buf)); });
          rq.on('error', reject); rq.end();
        });
        return ok(res, { source: 'remote', url: storeUrl, list: JSON.parse(data) });
      } catch (e) {
        return ok(res, { source: 'fallback', url: storeUrl, error: String(e.message), list: STORE_DEMO });
      }
    }
    return ok(res, { source: 'builtin', list: STORE_DEMO });
    }, { auth: 'user', order: 2040 });

    /* [L2061] if (pathname === '/api/push-config' && method === 'GET') */
    router.get('/api/push-config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { PUSH_CHANNELS, maskWebhook, ok, pushCfg } = app;
    const p = pushCfg();
    return ok(res, {
      enabled: !!p.enabled, channel: p.channel || 'wecom',
      hasWebhook: !!p.webhook, webhookMasked: maskWebhook(p.webhook),
      dailyReport: p.dailyReport !== false, dailyTime: p.dailyTime || '08:00',
      leadDays: p.leadDays === undefined ? 3 : +p.leadDays,
      baseUrl: p.baseUrl || '', lastSentDate: p.lastSentDate || '', lastResult: p.lastResult || '',
      itemReminders: p.itemReminders !== false, lastReminderResult: p.lastReminderResult || '',
      requirePwdChange: db.settings.requirePwdChange !== false,
      supported: PUSH_CHANNELS
    });
    }, { auth: 'user', order: 2061 });

    /* [L2073] if (pathname === '/api/push-config' && method === 'PUT') */
    router.put('/api/push-config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { PUSH_CHANNELS, PUSH_HOSTS, fail, https, ok, pushCfg, readBody, saveDb } = app;
    const body = await readBody(req);
    /* P0-2：requirePwdChange 是「首次登录强制改密」的全局开关，却被塞在
       对所有登录用户开放的推送配置接口里——普通用户能自行关掉安全策略。
       在任何字段写入之前先校验角色，避免半途 return 留下已改的内存状态。 */
    if (body.requirePwdChange !== undefined && (!user || user.role !== 'admin')) {
      return fail(res, '仅管理员可修改「首次登录强制改密」策略', 403);
    }
    const p = pushCfg();
    if (body.webhook) {
      const w = String(body.webhook).trim();
      if (!/^https:\/\//i.test(w)) return fail(res, 'Webhook 必须是 https 地址');
      let host = '';
      try { host = new URL(w).hostname; } catch (e) { return fail(res, 'Webhook 地址格式不正确'); }
      if (!PUSH_HOSTS.includes(host)) {
        return fail(res, '仅支持官方机器人地址（企业微信/飞书/钉钉/Server酱/PushPlus/Bark）');
      }
      p.webhook = w;
    }
    if (body.clearWebhook) p.webhook = '';
    if (body.channel) {
      const c = String(body.channel).slice(0, 20);
      if (!PUSH_CHANNELS.some(x => x.key === c)) return fail(res, '不支持的推送通道');
      p.channel = c;
    }
    if (body.enabled !== undefined) p.enabled = !!body.enabled;
    if (body.dailyReport !== undefined) p.dailyReport = !!body.dailyReport;
    /* P0-5：逐条到点提醒开关（默认开启），可按需只保留每日晨报 */
    if (body.itemReminders !== undefined) p.itemReminders = !!body.itemReminders;
    if (body.dailyTime !== undefined) {
      const tt = String(body.dailyTime);
      if (!/^\d{2}:\d{2}$/.test(tt)) return fail(res, '推送时间格式应为 HH:MM');
      const h = +tt.slice(0, 2), mm = +tt.slice(3, 5);
      if (h > 23 || mm > 59) return fail(res, '推送时间无效（小时 00-23，分钟 00-59）');
      p.dailyTime = tt;
    }
    if (body.leadDays !== undefined) p.leadDays = Math.max(0, Math.min(30, parseInt(body.leadDays, 10) || 0));
    if (body.baseUrl !== undefined) {
      const b = String(body.baseUrl).trim();
      if (b && !/^https?:\/\//i.test(b)) return fail(res, '访问地址需以 http(s):// 开头');
      p.baseUrl = b.slice(0, 120);
    }
    if (body.requirePwdChange !== undefined) db.settings.requirePwdChange = !!body.requirePwdChange;
    if (p.enabled && !p.webhook) return fail(res, '请先填写 Webhook 地址');
    saveDb();
    return ok(res, { enabled: !!p.enabled, hasWebhook: !!p.webhook }, '推送配置已保存');
    }, { auth: 'user', order: 2073 });

    /* [L2208] if (pathname === '/api/map-config' && method === 'GET') */
    router.get('/api/map-config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    return ok(res, db.settings.mapTileCfg || {});
    }, { auth: 'user', order: 2208 });

    /* [L2211] if (pathname === '/api/map-config' && method === 'PUT') */
    router.put('/api/map-config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, https, mapTileCache, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const tpl = String(body.urlTemplate || '').trim();
    if (!/^\{s\}/.test('') && !/^https?:\/\//i.test(tpl)) return fail(res, '地址必须以 http(s):// 开头');
    if (!tpl.includes('{x}') || !tpl.includes('{y}') || !tpl.includes('{z}')) return fail(res, '地址必须包含 {x} {y} {z} 占位符');
    try {
      const u = new URL(tpl.replace('{s}', '1').replace('{x}', 13).replace('{y}', 6).replace('{z}', 4));
      const host = u.hostname.toLowerCase();
      if (/^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(host)) return fail(res, '不允许内网地址');
      if (!/\.[a-z]{2,}$/i.test(host)) return fail(res, '地址主机名不合法');
    } catch (e) { return fail(res, '地址无法解析'); }
    db.settings.mapTileCfg = {
      preset: String(body.preset || 'custom'),
      urlTemplate: tpl,
      subs: String(body.subs || '1234').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || '1'
    };
    saveDb();
    mapTileCache.clear();   // 立即生效：旧源缓存全部失效
    return ok(res, db.settings.mapTileCfg);
    }, { auth: 'user', order: 2211 });

    /* [L4311] if (pathname === '/api/settings/config' && method === 'GET') */
    router.get('/api/settings/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { backupCfg, crypto, isAdmin, ok, saveDb } = app;
    const s = db.settings;
    const isAdm = isAdmin(req);
    // 首次访问自动生成 AppKey / AppSecret / 订阅令牌
    let needSave = false;
    if (!s.appKey) { s.appKey = crypto.randomBytes(8).toString('hex').toUpperCase(); needSave = true; }
    if (!s.appSecret) { s.appSecret = crypto.randomBytes(16).toString('hex').toUpperCase(); needSave = true; }
    if (!s.subscribeToken) { s.subscribeToken = crypto.randomBytes(16).toString('hex'); needSave = true; }
    if (needSave) saveDb();
    return ok(res, {
      allowRegistration: !!s.allowRegistration,
      themeColor: s.themeColor || 'green',
      theme: s.theme || 'light',
      defaultSpace: s.defaultSpace || '个人空间',
      remindDetect: s.remindDetect !== false,
      remindLeadHours: s.remindLeadHours || 5,
      notifyGift: s.notifyGift !== false,
      notifyExpiry: s.notifyExpiry !== false,
      notifyLoan: s.notifyLoan !== false,
      featGift: s.featGift !== false,
      featExpiry: s.featExpiry !== false,
      featAnniversary: s.featAnniversary !== false,
      featMortgage: s.featMortgage !== false,
      featVault: s.featVault !== false,
      featNotes: s.featNotes !== false,
      featTrack: s.featTrack !== false,
      mapKey: s.mapKey || '',
      mapProvider: s.mapProvider || 'tencent',
      trackAutoInterval: s.trackAutoInterval || 10,
      fpRule: (s.fpRule && typeof s.fpRule === 'object') ? { minStayMinutes: (typeof s.fpRule.minStayMinutes === 'number' ? s.fpRule.minStayMinutes : 0) } : { minStayMinutes: 0 },
      showAiFloat: s.showAiFloat !== false,
      todayWorkFold: !!s.todayWorkFold,   // v43：假期/周末工作事项折叠偏好（用户可控，默认不折叠）
      telemetry: s.telemetry !== false,   // v72：使用统计开关（/insights 页脚指引的真实入口）
      channels: s.channels || [],
      msgTemplates: s.msgTemplates || [],
      externalEnabled: !!s.externalEnabled,
      appKey: isAdm ? (s.appKey || '') : '',
      appSecret: isAdm ? (s.appSecret || '') : '',
      subscribeToken: isAdm ? (s.subscribeToken || '') : '',
      icsRange: s.icsRange || { mode: 'all', start: '', end: '' },
      storageApi: isAdm ? (s.storageApi || { endpoint: '', bucket: '', accessKey: '', secretKey: '' }) : { endpoint: '', bucket: '', accessKey: '', secretKey: '' },
      /* 备份配置（非敏感，路径不当作敏感字段剥离）；仅管理员可见 */
      backup: isAdm ? backupCfg() : undefined
    });
    }, { auth: 'user', order: 4311, adminFields: true });

    /* [L4356] if (pathname === '/api/settings/config' && method === 'PUT') */
    router.put('/api/settings/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { backupCfg, fail, isAdmin, ok, readBody, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可修改全局配置', 403);
    const body = await readBody(req);
    if (body.allowRegistration !== undefined) db.settings.allowRegistration = !!body.allowRegistration;
    if (body.themeColor) {
      db.settings.themeColor = body.themeColor;
      user.themeColor = body.themeColor;
    }
    if (body.theme !== undefined) {
      db.settings.theme = body.theme;
    }
    ['defaultSpace', 'remindDetect', 'remindLeadHours', 'notifyGift', 'notifyExpiry', 'notifyLoan',
     'featGift', 'featExpiry', 'featAnniversary', 'featMortgage', 'featVault', 'featNotes', 'featTrack', 'showAiFloat',
     'mapKey', 'mapProvider', 'trackAutoInterval',
      'channels', 'msgTemplates', 'storageApi', 'externalEnabled', 'icsRange', 'telemetry']
      .forEach(k => { if (body[k] !== undefined) db.settings[k] = body[k]; });
    // v43：今天工作折叠开关，白名单式布尔语义——仅 true / 'true' / 1 / '1' 视为开启，
    // 其余（'false'/'no'/'yes'/0/'0'/''/2/[]/{} 等）一律 false（修复旧实现 !(v===...) 对 'yes'/'no'/2/[]/{} 误判为 true）
    if (body.todayWorkFold !== undefined) {
      const v = body.todayWorkFold;
      db.settings.todayWorkFold = (v === true || v === 'true' || v === 1 || v === '1');
    }
    /* G5 足迹点亮规则：白名单合并 + 数值校验（0-1440 分钟整数；0 = 打卡即点亮） */
    if (body.fpRule && typeof body.fpRule === 'object') {
      if (!db.settings.fpRule || typeof db.settings.fpRule !== 'object') db.settings.fpRule = { minStayMinutes: 0 };
      if (body.fpRule.minStayMinutes !== undefined) {
        const n = parseInt(body.fpRule.minStayMinutes, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 1440) db.settings.fpRule.minStayMinutes = n;
      }
    }
    if (body.wechat && typeof body.wechat === 'object') {
      const nw = Object.assign({}, body.wechat);
      // 空 AppSecret 表示「不修改」，保留原值，避免清空
      if (nw.appSecret === '' || nw.appSecret === undefined) nw.appSecret = (db.settings.wechat && db.settings.wechat.appSecret) || '';
      db.settings.wechat = Object.assign(db.settings.wechat || {}, nw);
    }
    /* 备份配置：白名单式合并（不整体替换，避免覆盖 lastRunDate/lastSha 等运行时字段；
       remoteDir 是普通路径，不当作敏感字段剥离） */
    if (body.backup && typeof body.backup === 'object') {
      const c = backupCfg();
      if (body.backup.enabled !== undefined) c.enabled = !!body.backup.enabled;
      if (body.backup.remoteDir !== undefined) c.remoteDir = String(body.backup.remoteDir || '').trim();
      ['keepDays', 'keepWeeks', 'keepMonths'].forEach(k => {
        if (body.backup[k] !== undefined) { const n = parseInt(body.backup[k], 10); if (Number.isFinite(n) && n >= 0) c[k] = n; }
      });
    }
    saveDb(); return ok(res, null, '保存成功');
    }, { auth: 'user', order: 4356, role: 'admin' });

    /* [L4459] if (pathname === '/api/settings/regenerate-secret' && method === 'POST') */
    router.post('/api/settings/regenerate-secret', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { crypto, fail, isAdmin, ok, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可轮换密钥', 403);
    db.settings.appKey = db.settings.appKey || crypto.randomBytes(8).toString('hex').toUpperCase();
    db.settings.appSecret = crypto.randomBytes(16).toString('hex').toUpperCase();
    saveDb();
    return ok(res, { appKey: db.settings.appKey, appSecret: db.settings.appSecret }, '已重新生成');
    }, { auth: 'user', order: 4459, role: 'admin' });

    /* [L4467] if (pathname === '/api/settings/regenerate-subscribe' && method === 'POST') */
    router.post('/api/settings/regenerate-subscribe', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { crypto, fail, isAdmin, ok, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可轮换订阅 token', 403);
    db.settings.subscribeToken = crypto.randomBytes(16).toString('hex');
    saveDb();
    return ok(res, { subscribeToken: db.settings.subscribeToken }, '订阅链接已刷新，旧链接立即失效');
    }, { auth: 'user', order: 4467, role: 'admin' });

    /* [L4843] if (pathname === '/api/settings/export' && method === 'GET') */
    router.get('/api/settings/export', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildSafeBackupJson, fail, isAdmin, todayStr } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可导出备份', 403);
    const safe = buildSafeBackupJson();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shiquan-backup-' + todayStr() + '.json"'
    });
    return res.end(JSON.stringify(safe, null, 2));
    }, { auth: 'user', order: 4843, role: 'admin' });

    /* [L4856] if (pathname === '/api/settings/export-full' && method === 'GET') */
    router.get('/api/settings/export-full', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { APP_VERSION, DB_FILE, STORAGE_FILE, STORAGE_KIND, STORAGE_KEY_FILE, UPLOAD_DIR, buildSafeBackupJson, buildZip, checkpointStorage, fail, fileStamp, flushSaveDb, fs, isAdmin, nowStr, path, sha256, sha256Buf } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可导出完整备份', 403);
    const entries = [];
    const pushFile = (abs, zipName) => {
      try {
        const data = fs.readFileSync(abs);
        entries.push({ name: zipName, data, mtime: fs.statSync(abs).mtime });
        return data;
      } catch (e) { return null; }
    };
    flushSaveDb();          // 导出前强制落盘，确保打包的是最新数据
    checkpointStorage();    // SQLite：先 WAL checkpoint，复制出的主库才完整
    /* P0-6：旧实现永远只打包 db.json。LC_STORAGE=sqlite 时那份文件
       要么不存在、要么是陈旧的残留，导出的「完整备份」其实没有数据。 */
    if (STORAGE_KIND === 'sqlite') {
      for (const suffix of ['', '-wal', '-shm']) pushFile(STORAGE_FILE + suffix, 'db.sqlite' + suffix);
      const snap = Buffer.from(JSON.stringify(buildSafeBackupJson(), null, 2), 'utf8');
      entries.push({ name: 'db.json', data: snap, mtime: new Date() });
    } else {
      if (!pushFile(DB_FILE, 'db.json')) return fail(res, '读取 db.json 失败，无法导出', 500);
    }
    pushFile(STORAGE_KEY_FILE, '.storage-key');
    const walk = (dir, prefix) => {
      try {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(en => {
          if (en.isDirectory()) walk(path.join(dir, en.name), prefix + en.name + '/');
          else if (en.isFile()) pushFile(path.join(dir, en.name), prefix + en.name);
        });
      } catch (e) { /* 目录不存在/读取失败：跳过 */ }
    };
    walk(UPLOAD_DIR, 'uploads/');
    const manifest = {
      version: 1, kind: 'life-cockpit-full-backup',
      exportedAt: nowStr(), appVersion: APP_VERSION, schemaVersion: db.schemaVersion,
      storageKind: STORAGE_KIND,
      files: entries.map(e => ({ name: e.name, size: e.data.length, sha256: sha256Buf(e.data) }))
    };
    entries.push({ name: 'backup-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: new Date() });
    const zip = buildZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="life-cockpit-full-backup-' + fileStamp() + '.zip"',
      'Cache-Control': 'no-store'
    });
    return res.end(zip);
    }, { auth: 'user', order: 4856, role: 'admin' });

    /* [L4893] if (pathname === '/api/settings/backup-cloud' && method === 'POST') */
    router.post('/api/settings/backup-cloud', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildSafeBackupJson, cloudBackupKey, fail, isAdmin, nowStr, ok, s3PutObject, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可执行云备份', 403);
    const cfg = db.settings.storageApi || {};
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
      return fail(res, '请先在系统设置 → 对象存储 API 中填写 Endpoint / Bucket / AccessKey / SecretKey', 400);
    }
    const key = cloudBackupKey();
    const body = Buffer.from(JSON.stringify(buildSafeBackupJson(), null, 2), 'utf8');
    const r = await s3PutObject(cfg, key, body);
    if (r.ok) {
      const info = { at: nowStr(), key: key, size: body.length, result: 'ok' };
      db.settings.storageApi = db.settings.storageApi || {};
      db.settings.storageApi.lastBackup = info;
      saveDb();
      return ok(res, info, '云备份成功');
    }
    return fail(res, '云备份失败：' + r.detail, 502);
    }, { auth: 'user', order: 4893, role: 'admin' });

    /* [L4912] if (pathname === '/api/settings/import' && method === 'POST') */
    router.post('/api/settings/import', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { DATA_DIR, DB_FILE, aiSettings, buildSafeBackupJson, fail, flushSaveDb, fs, isAdmin, migrateDb, nowStr, ok, path, readBody, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可导入恢复', 403);
    const body = await readBody(req);
    const raw = body && body.data !== undefined ? body.data : body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(res, '备份内容不是有效 JSON 对象', 400);
    if (!Array.isArray(raw.users) || typeof raw.nextId !== 'number') return fail(res, '备份文件格式不正确（缺少 users 或 nextId）', 400);
    // 白名单：只接受本系统已知集合，拒绝未知集合（防误导/恶意结构）
    const IMPORT_WHITELIST = ['tasks', 'notes', 'scheduledTasks', 'anniversaries', 'expiryItems', 'vaultEntries', 'giftPersons',
      'giftRecords', 'ledgerRecords', 'familyMembers', 'mortgages', 'assets', 'healthProfiles', 'otherDebts',
      'ledgerCategories', 'giftGroups', 'giftConfigs', 'expiryCategories', 'statuses', 'tracks', 'trackPoints',
      'footprints', 'fpDiary', 'uploads', 'aiChats',
      /* 账本账户 / 场景账本 / 预算：导出（buildSafeBackupJson）包含它们，若白名单不含则导出→导入会 400，
         等于「备份无法还原」。补齐三者保证导入/导出可往返（R42 修复）。 */
      'ledgerBooks', 'ledgerBudgets', 'ledgerAccounts',
      /* R46（2026-10 实测发现）：后续版本新增的顶层集合同样会出现在导出里——
         photoPoints（照片点位）/ networthSnapshots（净资产快照）/ aiConnections（AI 多连接）为数组，
         白名单缺失导致「导出→导入」400 整包拒绝（备份无法还原），一并补齐。 */
      'photoPoints', 'networthSnapshots', 'aiConnections'];
    const META_KEYS = ['users', 'nextId', 'settings', 'aiProviders', 'vaultMaster',
      /* modules 是「对象型」顶层键（非数组），必须归入 META_KEYS 而非数组白名单，
         否则导出（含 modules）→ 导入会被「未知数据集合」整包拒绝（备份无法还原）。 */
      'modules',
      /* schemaVersion（F7）：导出走全库深拷贝必含此字段，白名单缺它会破坏「导出→导入」往返 */
      /* aiSettings（R46）：v48 AI 全局设置为对象型顶层键，导出包含它，须归 META_KEYS */
      'schemaVersion', 'aiSettings'];
    const unknownKeys = Object.keys(raw).filter(k => !IMPORT_WHITELIST.includes(k) && !META_KEYS.includes(k));
    if (unknownKeys.length) return fail(res, '备份包含未知的数据集合：' + unknownKeys.join('、'), 400);
    for (const k of IMPORT_WHITELIST) {
      if (raw[k] !== undefined && !Array.isArray(raw[k])) return fail(res, '集合 ' + k + ' 必须是数组', 400);
    }
    // 导入前本地兜底备份（带时间戳，绝不覆盖用户可能需要的现状）
    flushSaveDb();   // 备份前强制落盘，确保兜底快照包含导入前最新数据
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    try { fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'db.pre-import-' + ts + '.json')); } catch (e) { /* 尽力而为 */ }
    // 整体替换并做兼容迁移
    /* 唯一一处会替换 db 引用的路由：用 ctx.replaceDb 把 server.js 的 db 指向新对象。
       不能直接写 db = raw —— db 是从 ctx 解构的 const，赋值会抛 TypeError；
       即使改成 let 也只是改本地副本，server.js 那边仍指向旧对象。 */
    const nextDb = ctx.replaceDb(raw);
    if (nextDb.settings) nextDb.settings.lastBackup = undefined;
    try { migrateDb(); } catch (e) { /* 迁移容错 */ }
    saveDb();
    return ok(res, { importedAt: nowStr(), recordCount: nextDb.nextId }, '导入成功，数据已覆盖');
    }, { auth: 'user', order: 4912, role: 'admin' });
};
