'use strict';
/* footprint —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

module.exports = function register(router, app) {


    /* [L2179] if (pathname === '/api/map-tile' && method === 'GET') */
    router.get('/api/map-tile', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { mapTileCache } = app;
    const z = parseInt(q.get('z') || '0', 10), x = parseInt(q.get('x') || '0', 10), y = parseInt(q.get('y') || '0', 10);
    if (!(z >= 3 && z <= 18) || x < 0 || y < 0 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
      res.writeHead(400); return res.end('bad tile');
    }
    const key = z + '/' + x + '/' + y;
    const hit = mapTileCache.get(key);
    if (hit) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(hit);
    }
    const cfg = db.settings.mapTileCfg || {};
    const subs = String(cfg.subs || '1234');
    const sub = subs.length ? subs[(x + y) % subs.length] : '1';
    const turl = String(cfg.urlTemplate || '')
      .replace('{s}', sub).replace('{x}', x).replace('{y}', y).replace('{z}', z);
    try {
      const r = await fetch(turl, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (mapTileCache.size > 500) mapTileCache.clear();
      mapTileCache.set(key, buf);
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502); return res.end('upstream fail');
    }
    }, { auth: 'user', order: 2179 });

    /* [L3783] if (pathname === '/api/tracks/stats' && method === 'GET') */
    router.get('/api/tracks/stats', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, trackWithStats } = app;
    const items = db.tracks.map(t => trackWithStats(t, false));
    const pts = db.trackPoints;
    const dates = [...new Set(db.tracks.map(t => t.date).filter(Boolean))];
    const placeCount = {};
    pts.forEach(p => { const k = (p.name || '').trim(); if (k) placeCount[k] = (placeCount[k] || 0) + 1; });
    const byMonthMap = {};
    items.forEach(t => {
      const mk = (t.date || '').slice(0, 7); if (!mk) return;
      const o = byMonthMap[mk] || (byMonthMap[mk] = { month: mk, trackCount: 0, pointCount: 0, distance: 0 });
      o.trackCount++; o.pointCount += t.pointCount; o.distance += t.distance;
    });
    const moodMap = {};
    items.forEach(t => { if (t.mood) moodMap[t.mood] = (moodMap[t.mood] || 0) + 1; });
    const sportMap = {};
    items.forEach(t => {
      const s = t.sport || '';
      if (!s) return;
      const o = sportMap[s] || (sportMap[s] = { sport: s, count: 0, distance: 0 });
      o.count++; o.distance += t.distance || 0;
    });
    const sortedDates = dates.slice().sort();
    return ok(res, {
      trackCount: items.length,
      pointCount: pts.length,
      photoCount: pts.reduce((s, p) => s + (p.photoIds || []).length, 0),
      totalDistance: items.reduce((s, t) => s + t.distance, 0),
      dayCount: dates.length,
      manualPoints: pts.filter(p => p.source !== 'auto').length,
      autoPoints: pts.filter(p => p.source === 'auto').length,
      doingCount: items.filter(t => t.status === 'doing').length,
      firstDate: sortedDates[0] || '',
      lastDate: sortedDates[sortedDates.length - 1] || '',
      topPlaces: Object.keys(placeCount).map(k => ({ name: k, count: placeCount[k] })).sort((a, b) => b.count - a.count).slice(0, 8),
      byMonth: Object.values(byMonthMap).sort((a, b) => a.month.localeCompare(b.month)).slice(-12),
      byMood: Object.keys(moodMap).map(k => ({ mood: k, count: moodMap[k] })).sort((a, b) => b.count - a.count),
      bySport: Object.values(sportMap).sort((a, b) => b.distance - a.distance)
    });
    }, { auth: 'user', order: 3783 });

    /* [L3815] if (pathname === '/api/tracks/all-points' && method === 'GET') */
    router.get('/api/tracks/all-points', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, uploadUrl } = app;
    let tracks = db.tracks.slice();
    const memberId = q.get('memberId'), mood = q.get('mood'), from = q.get('from'), to = q.get('to');
    if (memberId) tracks = tracks.filter(t => (t.memberIds || []).includes(+memberId));
    if (mood) tracks = tracks.filter(t => t.mood === mood);
    if (from) tracks = tracks.filter(t => (t.date || '') >= from);
    if (to) tracks = tracks.filter(t => (t.date || '') <= to);
    const map = {}; tracks.forEach(t => { map[t.id] = t; });
    let pts = db.trackPoints.filter(p => map[p.trackId]);
    const limit = parseInt(q.get('limit'), 10);
    if (limit > 0) {
      // 按时间倒序取最近 N 点（供概览只看最新打卡）
      pts = pts.slice().sort((a, b) => (b.time || '').localeCompare(a.time || '')).slice(0, limit);
    } else {
      pts = pts.sort((a, b) => (a.time || '').localeCompare(b.time || '')).slice(0, 2000);
    }
    return ok(res, pts.map(p => ({
      id: p.id, trackId: p.trackId, trackTitle: map[p.trackId].title, date: map[p.trackId].date,
      lat: p.lat, lng: p.lng, name: p.name, time: p.time, mood: p.mood || map[p.trackId].mood,
      address: p.address || '', province: p.province || '', city: p.city || '', district: p.district || '',
      remark: p.remark || '', source: p.source || 'manual',
      photoIds: p.photoIds || [], photoUrls: (p.photoIds || []).map(uploadUrl)
    })));
    }, { auth: 'user', order: 3815 });

    /* [L3840] if (pathname === '/api/footprint' && method === 'GET') */
    router.get('/api/footprint', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildFootprint, ok } = app;
    return ok(res, buildFootprint());
    }, { auth: 'user', order: 3840 });

    /* [L3843] if (pathname === '/api/footprint/annual' && method === 'GET') */
    router.get('/api/footprint/annual', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildAnnual, ok } = app;
    return ok(res, buildAnnual(q.get('year')));
    }, { auth: 'user', order: 3843 });

    /* [L3846] if (pathname === '/api/footprint/cities' && method === 'GET') */
    router.get('/api/footprint/cities', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { buildFootprint, ok, searchCities } = app;
    const lit = {}; buildFootprint().cities.forEach(c => { lit[c.city] = 1; });
    return ok(res, searchCities(q.get('kw')).map(c => Object.assign({}, c, { lit: !!lit[c.city] })));
    }, { auth: 'user', order: 3846 });

    /* [L3850] if (pathname === '/api/footprint/manual' && method === 'POST') */
    router.post('/api/footprint/manual', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { CITY_FLAT, fail, newId, nowStr, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const city = String(body.city || '').trim();
    if (!city) return fail(res, '请选择城市');
    if (db.footprints.some(f => f.city === city)) return fail(res, '该城市已在足迹中');
    const known = CITY_FLAT.find(c => c.city === city);
    const province = String(body.province || (known ? known.province : '')).trim();
    const f = {
      id: newId(db), city: city, province: province,
      firstDate: String(body.firstDate || '').slice(0, 10), remark: String(body.remark || ''),
      createdAt: nowStr()
    };
    db.footprints.push(f); saveDb();
    return ok(res, f, '已点亮「' + city + '」');
    }, { auth: 'user', order: 3850 });

    /* [L3871] if (pathname === '/api/fp-diary' && method === 'GET') */
    router.get('/api/fp-diary', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, uploadUrl } = app;
    const list = db.fpDiary.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
    return ok(res, list.map(d => Object.assign({}, d, { photoUrls: (d.photoIds || []).map(uploadUrl) })));
    }, { auth: 'user', order: 3871 });

    /* [L3875] if (pathname === '/api/fp-diary' && method === 'POST') */
    router.post('/api/fp-diary', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { newId, nowStr, ok, readBody, safeSlice, saveDb, uploadUrl } = app;
    const body = await readBody(req);
    const d = {
      id: newId(db),
      date: String(body.date || '').slice(0, 10) || nowStr().slice(0, 10),
      mood: safeSlice(String(body.mood || '😀'), 8),
      text: safeSlice(String(body.text || ''), 500),
      photoIds: Array.isArray(body.photoIds) ? body.photoIds.map(Number).filter(n => n > 0) : [],
      createdAt: nowStr()
    };
    db.fpDiary.push(d); saveDb();
    return ok(res, Object.assign({}, d, { photoUrls: d.photoIds.map(uploadUrl) }), '已记录心情');
    }, { auth: 'user', order: 3875 });

    /* [L3907] if (pathname === '/api/footprint/reparse' && method === 'POST') */
    router.post('/api/footprint/reparse', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, parseRegion, saveDb } = app;
    let n = 0;
    db.trackPoints.forEach(p => {
      const r = parseRegion(p.address, p.name);
      if (r.city && (p.city !== r.city || p.province !== r.province)) { p.city = r.city; p.province = r.province; n++; }
    });
    if (n) saveDb();
    return ok(res, { updated: n }, n ? ('已重新识别 ' + n + ' 个打卡点') : '没有需要更新的地点');
    }, { auth: 'user', order: 3907 });

    /* [L3920] if (pathname === '/api/footprint/export' && method === 'GET') */
    router.get('/api/footprint/export', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
    const format = q.get('format') === 'gpx' ? 'gpx' : 'csv';
    const pts = db.trackPoints.slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || a.id - b.id);
    const toUnix = t => { const d = new Date(String(t || '').replace(' ', 'T')); return isNaN(d) ? '' : Math.floor(d.getTime() / 1000); };
    const stamp = Math.floor(Date.now() / 1000);
    const escCsv = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const escXml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let body, ctype, fname;
    if (format === 'csv') {
      const head = ['时间戳', '纬度', '经度', '地点', '地址', '省', '市', '区', '心情', '天气', '备注'];
      const rows = pts.map(p => [toUnix(p.time), p.lat, p.lng, p.name, p.address, p.province, p.city, p.district, p.mood, p.weather, p.remark].map(escCsv).join(','));
      body = '\uFEFF' + head.join(',') + '\r\n' + rows.join('\r\n') + (rows.length ? '\r\n' : '');
      ctype = 'text/csv; charset=utf-8';
      fname = stamp + '.csv';
    } else {
      const trkpts = pts.map(p => {
        const d = new Date(String(p.time || '').replace(' ', 'T'));
        const time = isNaN(d) ? '' : '<time>' + escXml(d.toISOString()) + '</time>';
        const name = p.name ? '<name>' + escXml(p.name) + '</name>' : '';
        return '      <trkpt lat="' + (+p.lat || 0) + '" lng="' + (+p.lng || 0) + '">' + (time || name ? time + name : '') + '</trkpt>';
      });
      body = '<?xml version="1.0" encoding="UTF-8"?>\r\n'
        + '<gpx version="1.1" creator="life-cockpit" xmlns="http://www.topografix.com/GPX/1/1">\r\n'
        + '  <trk>\r\n    <name>足迹导出</name>\r\n    <trkseg>\r\n' + trkpts.join('\r\n') + '\r\n    </trkseg>\r\n  </trk>\r\n</gpx>\r\n';
      ctype = 'application/gpx+xml; charset=utf-8';
      fname = stamp + '.gpx';
    }
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Disposition': 'attachment; filename="' + fname + '"',
      'Cache-Control': 'no-store'
    });
    return res.end(body);
    }, { auth: 'user', order: 3920 });

    /* [L3958] if (pathname === '/api/footprint/import' && method === 'POST') */
    router.post('/api/footprint/import', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, parseRegion, pointFields, readBody, safeSlice, saveDb, todayStr, trackFields } = app;
    const body = await readBody(req);
    const arr = Array.isArray(body.points) ? body.points : [];
    if (!arr.length) return fail(res, '没有可导入的打卡点', 400);
    if (arr.length > 5000) return fail(res, '单次最多导入 5000 个打卡点', 400);
    const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const secOf = t => { const d = new Date(String(t || '').replace(' ', 'T')); return isNaN(d) ? 0 : Math.floor(d.getTime() / 1000); };
    /* 预处理：坐标开区间校验 + 时间归一（缺时间用「该点日期 00:00:00」，保证重复导入去重稳定） */
    const groups = {};   // date -> pointFields 白名单对象数组
    let invalid = 0;
    for (const it of arr) {
      const lat = +it.lat, lng = +it.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(lat > -90 && lat < 90) || !(lng > -180 && lng < 180)) { invalid++; continue; }
      let time = String(it.time || '').trim();
      if (!TIME_RE.test(time)) {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(time) ? time : todayStr();
        time = d + ' 00:00:00';
      }
      const f = pointFields({
        lat, lng,
        name: safeSlice(String(it.name || ''), 100),
        address: safeSlice(String(it.address || ''), 200),
        time, province: String(it.province || '').slice(0, 50), city: String(it.city || '').slice(0, 50),
        district: String(it.district || '').slice(0, 50),
        mood: safeSlice(String(it.mood || ''), 20), weather: String(it.weather || '').slice(0, 20),
        remark: safeSlice(String(it.remark || ''), 300),
        source: 'manual'
      }, null);
      const date = f.time.slice(0, 10);
      (groups[date] = groups[date] || []).push(f);
    }
    /* 全量去重 + 建行程 + 入库 */
    let imported = 0, skipped = 0, tracksCreated = 0;
    for (const date of Object.keys(groups).sort()) {
      /* 同日期复用「导入」行程，避免重复导入制造空壳行程 */
      let track = db.tracks.find(t => t.date === date && String(t.title || '').endsWith('· 导入'));
      if (!track) {
        const md = date.split('-');
        const f = trackFields({ title: (+md[1]) + '月' + (+md[2]) + '日 · 导入', date, status: 'done' }, null);
        track = Object.assign({ id: newId(db), createdAt: nowStr(), updatedAt: nowStr() }, f);
        db.tracks.push(track);
        tracksCreated++;
      }
      for (const f of groups[date]) {
        const sec = secOf(f.time);
        const dup = db.trackPoints.some(x => x.lat === f.lat && x.lng === f.lng && Math.abs(secOf(x.time) - sec) <= 60);
        if (dup) { skipped++; continue; }
        /* 与单点创建一致：无 city 时用 parseRegion（地址+名称）补省市 */
        if (!f.city) {
          const r = parseRegion(f.address, f.name);
          if (r.city || r.province) { f.province = r.province; f.city = r.city; }
        }
        db.trackPoints.push(Object.assign({ id: newId(db), trackId: track.id }, f));
        imported++;
      }
      /* 自动补齐行程起止时间（与单点创建逻辑一致） */
      const allPts = db.trackPoints.filter(x => x.trackId === track.id).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      if (allPts.length) {
        track.startTime = (allPts[0].time || '').slice(11, 16);
        track.endTime = (allPts[allPts.length - 1].time || '').slice(11, 16);
      }
      track.updatedAt = nowStr();
    }
    if (!imported && !skipped) return fail(res, '没有有效打卡点（坐标越界 ' + invalid + ' 个）', 400);
    saveDb();
    return ok(res, { imported, skipped, tracksCreated, invalid },
      '导入完成：新增 ' + imported + ' 个' + (skipped ? '，跳过重复 ' + skipped + ' 个' : '') + (invalid ? '，无效坐标 ' + invalid + ' 个' : '') + (tracksCreated ? '，新建行程 ' + tracksCreated + ' 个' : ''));
    }, { auth: 'user', order: 3958 });

    /* [L4062] if (pathname === '/api/photo-points' && method === 'GET') */
    router.get('/api/photo-points', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const list = db.photoPoints.slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')) || b.id - a.id);
    return ok(res, { list, cfg: db.settings.footprintPhotoCfg });
    }, { auth: 'user', order: 4062 });

    /* [L4066] if ((pathname === '/api/photo-points/import' || pathname === '/api/photo-points/import-file') && method === 'POST') */
    router.when(function (ctx) { const { pathname, method } = ctx; return (pathname === '/api/photo-points/import' || pathname === '/api/photo-points/import-file') && method === 'POST'; }, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, ok, photoPointsImport, readBody, saveDb } = app;
    const body = await readBody(req);
    const arr = Array.isArray(body.points) ? body.points : [];
    if (!arr.length) return fail(res, '没有可导入的照片点位', 400);
    if (arr.length > 500) return fail(res, '单次最多导入 500 条照片点位', 400);
    const r = photoPointsImport(arr);
    if (!r.added && !r.skipped) return fail(res, '没有有效照片点位（' + r.invalid + ' 条无效）', 400);
    saveDb();
    return ok(res, { added: r.added, skipped: r.skipped, invalid: r.invalid, total: db.photoPoints.length },
      '导入完成：新增 ' + r.added + ' 条' + (r.skipped ? '，跳过重复/超限 ' + r.skipped + ' 条' : '') + (r.invalid ? '，无效 ' + r.invalid + ' 条' : ''));
    }, { auth: 'user', order: 4066 });

    /* [L4077] if (pathname === '/api/photo-points/cfg' && method === 'PUT') */
    router.put('/api/photo-points/cfg', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { PHOTO_COLORS, fail, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const cfg = db.settings.footprintPhotoCfg;
    if (body.visible !== undefined) cfg.visible = !!body.visible;
    if (body.color !== undefined) {
      if (!PHOTO_COLORS.includes(body.color)) return fail(res, '不支持的颜色', 400);
      cfg.color = body.color;
    }
    saveDb();
    return ok(res, cfg, '照片显示配置已保存');
    }, { auth: 'user', order: 4077 });

    /* [L4088] if (pathname === '/api/photo-points/export' && method === 'GET') */
    router.get('/api/photo-points/export', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { nowStr, todayStr } = app;
    const pts = db.photoPoints.slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || a.id - b.id);
    const body = JSON.stringify({ version: 1, exportedAt: nowStr(), points: pts.map(p => ({ lat: p.lat, lng: p.lng, name: p.name, time: p.time, thumb: p.thumb })) }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="photo-points-' + todayStr().replace(/-/g, '') + '.json"',
      'Cache-Control': 'no-store'
    });
    return res.end(body);
    }, { auth: 'user', order: 4088 });

    /* [L4098] if (pathname === '/api/photo-points/clear' && method === 'POST') */
    router.post('/api/photo-points/clear', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, saveDb } = app;
    const n = db.photoPoints.length;
    db.photoPoints = [];
    saveDb();
    return ok(res, { cleared: n }, '已清空 ' + n + ' 条照片点位');
    }, { auth: 'user', order: 4098 });

    /* [L4117] if (pathname === '/api/footprint/share-import' && method === 'POST') */
    router.post('/api/footprint/share-import', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { nowStr, saveDb } = app;
    const ctype = String(req.headers['content-type'] || '');
    const bm = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!/multipart\/form-data/i.test(ctype) || !bm) return fail(res, '需要 multipart/form-data 上传', 400);
    const MAX_SHARE_BYTES = 2 * 1024 * 1024;
    const raw = await new Promise(resolve => {
      const chunks = [];
      let size = 0, over = false;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_SHARE_BYTES + 64 * 1024) { over = true; chunks.length = 0; return; }
        if (!over) chunks.push(c);
      });
      req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });
    if (!raw || raw.length > MAX_SHARE_BYTES) {
      res.writeHead(302, { Location: '/footprint?import-pending=too-large' });
      return res.end();
    }
    /* 零依赖 multipart 解析：按 boundary 切分，取 name="file" 的 part 内容与文件名 */
    const boundary = Buffer.from('--' + (bm[1] || bm[2]).trim());
    let content = '', filename = '';
    let pos = raw.indexOf(boundary);
    while (pos >= 0 && !content) {
      const headStart = pos + boundary.length;
      if (raw.slice(headStart, headStart + 2).toString() === '--') break;   // 结束哨兵
      const partStart = raw.indexOf(Buffer.from('\r\n\r\n'), headStart);
      if (partStart < 0) break;
      const head = raw.slice(headStart, partStart).toString('utf8');
      const next = raw.indexOf(boundary, partStart);
      if (next < 0) break;
      const data = raw.slice(partStart + 4, next - 2);   // 去掉 part 末尾 \r\n
      if (/name="file"/i.test(head)) {
        const fm = head.match(/filename="([^"]*)"/i);
        if (fm) { try { filename = decodeURIComponent(fm[1]); } catch (e) { filename = fm[1]; } filename = filename.split(/[\\/]/).pop().slice(0, 120); }
        content = data.toString('utf8');
      }
      pos = next;
    }
    if (!content.trim()) {
      res.writeHead(302, { Location: '/footprint?import-pending=empty' });
      return res.end();
    }
    db.settings.footprintImportPending = { content: content.slice(0, MAX_SHARE_BYTES), filename, at: nowStr() };
    saveDb();
    res.writeHead(302, { Location: '/footprint?import-pending=1' });
    return res.end();
    }, { auth: 'user', order: 4117 });

    /* [L4167] if (pathname === '/api/footprint/import-pending' && method === 'GET') */
    router.get('/api/footprint/import-pending', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, saveDb } = app;
    const p = db.settings.footprintImportPending || null;
    if (db.settings.footprintImportPending) { delete db.settings.footprintImportPending; saveDb(); }
    return ok(res, p || { content: '', filename: '', at: '' });
    }, { auth: 'user', order: 4167 });

    /* [L4174] if (pathname === '/api/geo' && method === 'GET') */
    router.get('/api/geo', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { https, ok } = app;
    let done = false;
    const send = obj => { if (done) return; done = true; try { ok(res, obj); } catch (e) {} };
    try {
      https.get('https://ipapi.co/json/', (r) => {
        let buf = '';
        r.on('data', c => buf += c);
        r.on('end', () => {
          try {
            const j = JSON.parse(buf);
            if (j && j.latitude) send({ city: j.city || '', lat: j.latitude, lon: j.longitude });
            else send({ city: '', lat: null, lon: null, error: 'no-data' });
          } catch (e) { send({ city: '', lat: null, lon: null, error: 'parse' }); }
        });
      }).on('error', () => send({ city: '', lat: null, lon: null, error: 'net' }));
      setTimeout(() => send({ city: '', lat: null, lon: null, error: 'timeout' }), 5000);
    } catch (e) { send({ city: '', lat: null, lon: null, error: 'exc' }); }
    return;
    }, { auth: 'user', order: 4174 });

    /* [L4195] if (pathname === '/api/uploads' && method === 'POST') */
    router.post('/api/uploads', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { IMG_EXT, MAX_UPLOAD_BYTES, UPLOAD_DIR, crypto, fail, fs, newId, nowStr, ok, path, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const m = String(body.data || '').match(/^data:([\w/+.-]+);base64,([\s\S]+)$/);
    const mime = (m ? m[1] : String(body.mime || '')).toLowerCase();
    const b64 = m ? m[2] : String(body.data || '');
    if (!IMG_EXT[mime]) return fail(res, '仅支持 JPG / PNG / GIF / WEBP / BMP 图片');
    if (!b64) return fail(res, '图片数据为空');
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return fail(res, '图片数据解析失败'); }
    if (!buf.length) return fail(res, '图片数据为空');
    if (buf.length > MAX_UPLOAD_BYTES) return fail(res, '单张图片不能超过 6MB，请压缩后再上传');
    const file = crypto.randomBytes(16).toString('hex') + IMG_EXT[mime];
    try { fs.writeFileSync(path.join(UPLOAD_DIR, file), buf); } catch (e) { return fail(res, '图片写入失败，请检查 data/uploads 目录权限', 500); }
    const rec = {
      id: newId(db), name: safeSlice(String(body.name || '图片'), 80), mime, size: buf.length, file,
      createdAt: nowStr(), ownerType: String(body.ownerType || 'track'), ownerId: body.ownerId ? +body.ownerId : null
    };
    db.uploads.push(rec); saveDb();
    return ok(res, { id: rec.id, url: '/uploads/' + file, size: rec.size }, '上传成功');
    }, { auth: 'user', order: 4195 });

    /* [L4220] if (pathname === '/api/tracks' && method === 'GET') */
    router.get('/api/tracks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok, trackWithStats } = app;
    let list = db.tracks.slice();
    const year = q.get('year'), month = q.get('month'), from = q.get('from'), to = q.get('to');
    const memberId = q.get('memberId'), mood = q.get('mood'), status = q.get('status');
    const kw = (q.get('keyword') || '').trim().toLowerCase();
    if (year) list = list.filter(t => (t.date || '').startsWith(year));
    if (month) list = list.filter(t => (t.date || '').startsWith(month));
    if (from) list = list.filter(t => (t.date || '') >= from);
    if (to) list = list.filter(t => (t.date || '') <= to);
    if (memberId) list = list.filter(t => (t.memberIds || []).includes(+memberId));
    if (mood) list = list.filter(t => t.mood === mood);
    if (status) list = list.filter(t => (t.status || 'done') === status);
    let out = list.map(t => trackWithStats(t, false));
    if (kw) out = out.filter(t => {
      const pts = db.trackPoints.filter(p => p.trackId === t.id);
      return (t.title + ' ' + (t.remark || '') + ' ' + pts.map(p => (p.name || '') + (p.address || '') + (p.remark || '')).join(' '))
        .toLowerCase().includes(kw);
    });
    out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
    return ok(res, out);
    }, { auth: 'user', order: 4220 });

    /* [L4241] if (pathname === '/api/tracks' && method === 'POST') */
    router.post('/api/tracks', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { fail, newId, nowStr, ok, readBody, saveDb, trackFields, trackWithStats } = app;
    const body = await readBody(req);
    const f = trackFields(body, null);
    if (!f.date) return fail(res, '日期不能为空');
    const t = Object.assign({ id: newId(db), createdAt: nowStr(), updatedAt: nowStr() }, f);
    db.tracks.push(t); saveDb();
    return ok(res, trackWithStats(t, true), '行程已创建');
    }, { auth: 'user', order: 4241 });

    /* [L3865] if ((m = pathname.match(/^\/api\/footprint\/manual\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/footprint\/manual\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, saveDb } = app;
    if (!db.footprints.some(f => f.id === +m[1])) return fail(res, '记录不存在', 404);
    db.footprints = db.footprints.filter(f => f.id !== +m[1]); saveDb();
    return ok(res, null, '已取消点亮');
    }, { auth: 'user', order: 3865, method: 'DELETE' });

    /* [L3888] if ((m = pathname.match(/^\/api\/fp-diary\/(\d+)$/))) */
    router.match(/^\/api\/fp-diary\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, nowStr, ok, readBody, removeUpload, safeSlice, saveDb, uploadUrl } = app;
    const d = db.fpDiary.find(x => x.id === +m[1]);
    if (!d) return fail(res, '随笔不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.date !== undefined) d.date = String(body.date).slice(0, 10);
      if (body.mood !== undefined) d.mood = safeSlice(String(body.mood), 8);
      if (body.text !== undefined) d.text = safeSlice(String(body.text), 500);
      if (body.photoIds !== undefined) d.photoIds = Array.isArray(body.photoIds) ? body.photoIds.map(Number).filter(n => n > 0) : [];
      d.updatedAt = nowStr(); saveDb();
      return ok(res, Object.assign({}, d, { photoUrls: (d.photoIds || []).map(uploadUrl) }), '已保存');
    }
    if (method === 'DELETE') {
      (d.photoIds || []).forEach(removeUpload);
      db.fpDiary = db.fpDiary.filter(x => x.id !== d.id); saveDb();
      return ok(res, null, '已删除随笔');
    }
    }, { auth: 'user', order: 3888 });

    /* [L4105] if (photoDelM && method === 'DELETE') */
    router.when(function (ctx) {
      const { pathname, method } = ctx;
      const state = ctx.state;
      const photoDelM = pathname.match(/^\/api\/photo-points\/(\d+)$/);
      if (!photoDelM) return false;
      ctx.m = photoDelM;
      return photoDelM && method === 'DELETE';
    }, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, saveDb } = app;
    const id = +m[1];
    const idx = db.photoPoints.findIndex(p => p.id === id);
    if (idx < 0) return fail(res, '照片点位不存在', 404);
    db.photoPoints.splice(idx, 1);
    saveDb();
    return ok(res, { id }, '已删除');
    }, { auth: 'user', order: 4105 });

    /* [L4215] if ((m = pathname.match(/^\/api\/uploads\/(\d+)$/)) && method === 'DELETE') */
    router.match(/^\/api\/uploads\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, removeUpload, saveDb } = app;
    if (!removeUpload(+m[1])) return fail(res, '图片不存在', 404);
    saveDb(); return ok(res, null, '已删除');
    }, { auth: 'user', order: 4215, method: 'DELETE' });

    /* [L4249] if ((m = pathname.match(/^\/api\/tracks\/(\d+)$/))) */
    router.match(/^\/api\/tracks\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, nowStr, ok, purgeTrack, readBody, saveDb, trackFields, trackWithStats } = app;
    const t = db.tracks.find(x => x.id === +m[1]);
    if (!t) return fail(res, '行程不存在', 404);
    if (method === 'GET') return ok(res, trackWithStats(t, true));
    if (method === 'PUT') {
      const body = await readBody(req);
      Object.assign(t, trackFields(body, t));
      t.updatedAt = nowStr();
      saveDb(); return ok(res, trackWithStats(t, true), '已保存');
    }
    if (method === 'DELETE') {
      purgeTrack(t.id); saveDb();
      return ok(res, null, '行程及其打卡点、照片已删除');
    }
    }, { auth: 'user', order: 4249 });

    /* [L4265] if ((m = pathname.match(/^\/api\/tracks\/(\d+)\/points$/)) && method === 'POST') */
    router.match(/^\/api\/tracks\/(\d+)\/points$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, newId, nowStr, ok, parseRegion, pointFields, readBody, saveDb, uploadUrl } = app;
    const t = db.tracks.find(x => x.id === +m[1]);
    if (!t) return fail(res, '行程不存在', 404);
    const body = await readBody(req);
    const f = pointFields(body, null);
    if (!f.lat || !f.lng) return fail(res, '请先在地图上选点或使用定位获取坐标');
    // 严格开区间：纬度 (-90,90)、经度 (-180,180)，边界值 90/180 拒绝
    if (!(f.lat > -90 && f.lat < 90) || !(f.lng > -180 && f.lng < 180)) return fail(res, '坐标超出有效范围（纬度 -90~90，经度 -180~180，不含边界）');
    if (!f.name) f.name = '未命名地点';
    if (!f.time) f.time = nowStr();
    if (!f.city) { const r = parseRegion(f.address, f.name); if (r.city || r.province) { f.province = r.province; f.city = r.city; } }
    const p = Object.assign({ id: newId(db), trackId: t.id }, f);
    db.trackPoints.push(p);
    // 自动补齐行程起止时间
    const allPts = db.trackPoints.filter(x => x.trackId === t.id).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (allPts.length) {
      t.startTime = (allPts[0].time || '').slice(11, 16);
      t.endTime = (allPts[allPts.length - 1].time || '').slice(11, 16);
    }
    t.updatedAt = nowStr();
    saveDb();
    return ok(res, Object.assign({}, p, { photoUrls: (p.photoIds || []).map(uploadUrl) }), '打卡点已记录');
    }, { auth: 'user', order: 4265, method: 'POST' });

    /* [L4288] if ((m = pathname.match(/^\/api\/tracks\/(\d+)\/points\/(\d+)$/))) */
    router.match(/^\/api\/tracks\/(\d+)\/points\/(\d+)$/, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, nowStr, ok, parseRegion, pointFields, readBody, removeUpload, saveDb, uploadUrl } = app;
    const t = db.tracks.find(x => x.id === +m[1]);
    const p = db.trackPoints.find(x => x.id === +m[2] && x.trackId === +m[1]);
    if (!t || !p) return fail(res, '打卡点不存在', 404);
    if (method === 'PUT') {
      const body = await readBody(req);
      const before = (p.photoIds || []).slice();
      Object.assign(p, pointFields(body, p));
      if (!p.city) { const r = parseRegion(p.address, p.name); if (r.city || r.province) { p.province = r.province; p.city = r.city; } }
      before.filter(id => !(p.photoIds || []).includes(id)).forEach(removeUpload);
      t.updatedAt = nowStr();
      saveDb();
      return ok(res, Object.assign({}, p, { photoUrls: (p.photoIds || []).map(uploadUrl) }), '已保存');
    }
    if (method === 'DELETE') {
      (p.photoIds || []).forEach(removeUpload);
      db.trackPoints = db.trackPoints.filter(x => x.id !== p.id);
      t.updatedAt = nowStr();
      saveDb(); return ok(res, null, '打卡点已删除');
    }
    }, { auth: 'user', order: 4288 });
};
