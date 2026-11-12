'use strict';
/* backup —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L4405] if (pathname === '/api/backup/status' && method === 'GET') */
    router.get('/api/backup/status', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { backupStatus, fail, isAdmin, ok } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可查看备份状态', 403);
    return ok(res, backupStatus());
    }, { auth: 'user', order: 4405, role: 'admin' });

    /* [L4409] if (pathname === '/api/backup/run' && method === 'POST') */
    router.post('/api/backup/run', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, isAdmin, ok, readBody, runDailyBackup } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可执行备份', 403);
    const body = await readBody(req);
    /* 默认整点重做（force:true）；显式传 {force:false} 走幂等跳过（供联调/校验同点是否已完成） */
    const force = (body && body.force === false) ? false : true;
    const r = runDailyBackup({ force: force, trigger: 'manual' });
    return ok(res, r, r.ok ? (r.skipped ? '当天已有有效备份，已跳过' : '备份完成') : ('备份未完成：' + (r.error || (r.remote && r.remote.detail) || '未知原因')));
    }, { auth: 'user', order: 4409, role: 'admin' });

    /* [L4417] if (pathname === '/api/backup/list' && method === 'GET') */
    router.get('/api/backup/list', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, isAdmin, listBackups, ok } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可查看备份列表', 403);
    return ok(res, listBackups());
    }, { auth: 'user', order: 4417, role: 'admin' });

    /* [L4421] if (pathname === '/api/backup/verify' && method === 'POST') */
    router.post('/api/backup/verify', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, isAdmin, ok, readBody, verifyBackupPoint } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可校验备份', 403);
    const body = await readBody(req);
    const date = String(body.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, '请提供合法的备份日期（YYYY-MM-DD）', 400);
    const r = verifyBackupPoint(date);
    return ok(res, r, r.ok ? '校验通过' : (r.error || '校验发现异常'));
    }, { auth: 'user', order: 4421, role: 'admin' });

    /* [L4429] if (pathname === '/api/backup/config' && method === 'POST') */
    router.post('/api/backup/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { backupCfg, backupStatus, fail, isAdmin, ok, readBody, saveDb } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可修改备份配置', 403);
    const body = await readBody(req);
    const c = backupCfg();
    if (body.enabled !== undefined) c.enabled = !!body.enabled;
    if (body.remoteDir !== undefined) c.remoteDir = String(body.remoteDir || '').trim();
    ['keepDays', 'keepWeeks', 'keepMonths'].forEach(k => {
      if (body[k] !== undefined) { const n = parseInt(body[k], 10); if (Number.isFinite(n) && n >= 0) c[k] = n; }
    });
    saveDb();
    return ok(res, backupStatus(), '备份配置已保存');
    }, { auth: 'user', order: 4429, role: 'admin' });

    /* [L4443] if (pathname === '/api/backup/volumes' && method === 'GET') */
    router.get('/api/backup/volumes', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { DATA_DIR, fail, isAdmin, listVolumes, ok, pathVolume } = app;
    if (!isAdmin(req)) return fail(res, '仅管理员可查看备份位置', 403);
    const vols = listVolumes();
    /* 候选 = 非同卷 且 可读；按可用空间倒序（大的排前面，减少「填了才发现放不下」） */
    const candidates = vols.filter(v => !v.sameDisk && v.readable)
      .sort((a, b) => (b.freeBytes || 0) - (a.freeBytes || 0));
    return ok(res, {
      dataDir: DATA_DIR,
      dataVolume: pathVolume(DATA_DIR),
      volumes: vols,
      candidates,
      /* 必须诚实说明本机第二块盘的边界：它只防「盘坏」，不防整机丢失 */
      sameMachineCaveat: '注意：同一台电脑里的另一块盘，只能防「这块盘坏掉」，防不了整机丢失、被盗、火灾水浸。要防这些，请填 U 盘 / 移动硬盘 / 网络共享（NAS）/ 云盘同步目录。'
    });
    }, { auth: 'user', order: 4443, role: 'admin' });
};
