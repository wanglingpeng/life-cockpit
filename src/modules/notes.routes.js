'use strict';
/* notes —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2330] if (pathname === '/api/notes' && method === 'GET') */
    router.get('/api/notes', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { htmlToPlain, ok, safeSlice } = app;
    let list = db.notes.slice();
    const keyword = q.get('keyword'), start = q.get('startDate'), end = q.get('endDate');
    const tag = q.get('tag');
    if (keyword) list = list.filter(n => (n.title || '').includes(keyword) || (n.content || '').includes(keyword) || htmlToPlain(n.content || '').includes(keyword));
    if (start) list = list.filter(n => n.createdAt.slice(0, 10) >= start);
    if (end) list = list.filter(n => n.createdAt.slice(0, 10) <= end);
    if (tag) list = list.filter(n => (n.tags || []).includes(tag));
    list.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || b.createdAt.localeCompare(a.createdAt));
    const page = +(q.get('page') || 1), size = +(q.get('size') || 10);
    const total = list.length;
    // 列表只回摘要，避免把整篇富文本正文都传给前端
    const items = list.slice((page - 1) * size, page * size).map(n => ({
      id: n.id, title: n.title, pinned: !!n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt,
      format: n.format || 'text', tags: n.tags || [],
      excerpt: safeSlice(n.format === 'html' ? htmlToPlain(n.content || '') : (n.content || ''), 120)
    }));
    return ok(res, { items, total, page, size });
    }, { auth: 'user', order: 2330 });

    /* [L2349] if (pathname === '/api/notes/tags' && method === 'GET') */
    router.get('/api/notes/tags', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const map = {};
    db.notes.forEach(n => (n.tags || []).forEach(t => { map[t] = (map[t] || 0) + 1; }));
    const tags = Object.keys(map).map(t => ({ name: t, count: map[t] })).sort((a, b) => b.count - a.count);
    return ok(res, tags);
    }, { auth: 'user', order: 2349 });

    /* [L2355] if (pathname === '/api/notes' && method === 'POST') */
    router.post('/api/notes', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, readBody, sanitizeRichHtml, saveDb } = app;
    const body = await readBody(req);
    if (!body.title && !body.content) return fail(res, '标题和内容不能都为空');
    const now = nowStr();
    const isHtml = body.format === 'html';
    const note = {
      id: newId(db), title: body.title || '',
      content: isHtml ? sanitizeRichHtml(body.content || '') : (body.content || ''),
      format: isHtml ? 'html' : 'text',
      tags: [...new Set((Array.isArray(body.tags) ? body.tags : []).map(t => String(t || '').trim().slice(0, 12)).filter(Boolean))].slice(0, 8),
      pinned: !!body.pinned,
      createdAt: now, updatedAt: now
    };
    db.notes.push(note); saveDb();
    return ok(res, note, '保存成功');
    }, { auth: 'user', order: 2355 });

    /* [L2371] if ((m = pathname.match(/^\/api\/notes\/(\d+)$/))) */
    router.match(/^\/api\/notes\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, nowStr, ok, readBody, sanitizeRichHtml, saveDb } = app;
    const note = db.notes.find(n => n.id === +m[1]);
    if (!note) return fail(res, '笔记不存在', 404);
    if (method === 'GET') return ok(res, note);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.title !== undefined) note.title = body.title;
      if (body.pinned !== undefined) note.pinned = !!body.pinned;
      if (body.tags !== undefined) note.tags = [...new Set((Array.isArray(body.tags) ? body.tags : []).map(t => String(t || '').trim().slice(0, 12)).filter(Boolean))].slice(0, 8);
      if (body.content !== undefined) {
        const isHtml = body.format === 'html' || (body.format === undefined && note.format === 'html');
        note.content = isHtml ? sanitizeRichHtml(body.content) : body.content;
        note.format = isHtml ? 'html' : 'text';
      }
      note.updatedAt = nowStr();
      saveDb(); return ok(res, note, '更新成功');
    }
    if (method === 'DELETE') {
      db.notes = db.notes.filter(n => n.id !== note.id); saveDb();
      return ok(res, null, '删除成功');
    }
    }, { auth: 'user', order: 2371 });
};
