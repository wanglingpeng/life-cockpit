/* 位置轨迹日记：轨迹/打卡点/心情的字段整形、统计富化与照片文件管理。
 *
 * 与备份、账本那些领域的区别：这里全部是「读 db 数组 → 整形 → 返回
 * 视图对象」的纯函数加两个文件操作（removeUpload / purgeTrack），
 * 没有跨域调用，所以它可以第一个做到「零 server.js 常驻依赖」——
 * 所有外部符号（haversine / CITY_FLAT / todayStr / UPLOAD_DIR）都来自
 * 已抽好的 service 与 core，这正是后续领域应该达到的样子。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）：导入备份会
 * 整体替换 db，缓存快照会让轨迹统计读到旧库。
 *
 * 从 server.js 抽出（原「位置轨迹日记 辅助」区，含该区头上的照片
 * 上传常量 MOOD_SET / IMG_EXT / MAX_UPLOAD_BYTES / uploadUrl——
 * 它们只被 footprint 与 dashboard 两组路由经 app 上下文使用）。 */
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../core/paths');
const rt = require('../core/runtime');
const { CITY_FLAT, CN_REGION, fpMaxStayMinutes, haversine, newId, nowStr, safeSlice, todayStr } = require('./utils');

/* ---------------- 位置轨迹日记 辅助 ---------------- */
const MOOD_SET = ['😀', '😊', '😌', '🤩', '🥳', '😐', '😕', '😢', '😴', '😤', '🥰', '🤒'];

const IMG_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

function uploadUrl(id) {
  if (!id) return '';
  const u = rt.db.uploads.find(x => x.id === +id);
  return u ? '/uploads/' + u.file : '';
}

function buildFootprint() {
  const trackMap = {};
  rt.db.tracks.forEach(t => { trackMap[t.id] = t; });
  const byCity = {};
  const points = [];
  rt.db.trackPoints.forEach(p => {
    const city = p.city || '';
    const t = trackMap[p.trackId];
    const date = (p.time || '').slice(0, 10) || (t && t.date) || '';
    if (p.lat && p.lng) points.push({ lat: p.lat, lng: p.lng, city: city, date: date, name: p.name || '' });
    if (!city) return;
    const o = byCity[city] || (byCity[city] = {
      city: city, province: p.province || '', firstDate: '', lastDate: '',
      dates: {}, times: [], pointCount: 0, photoCount: 0, coverUrl: '', trackCount: 0, manual: false
    });
    if (!o.province && p.province) o.province = p.province;
    if (date) {
      if (!o.firstDate || date < o.firstDate) o.firstDate = date;
      if (!o.lastDate || date > o.lastDate) o.lastDate = date;
      o.dates[date] = 1;
    }
    if (p.time) o.times.push(p.time);
    o.pointCount++;
    o.photoCount += (p.photoIds || []).length;
    if (!o.coverUrl && (p.photoIds || []).length) o.coverUrl = uploadUrl(p.photoIds[0]);
  });
  // 行程计数（按城市去重统计去过的行程）
  rt.db.tracks.forEach(t => {
    const citySet = {};
    rt.db.trackPoints.filter(p => p.trackId === t.id && p.city).forEach(p => { citySet[p.city] = 1; });
    Object.keys(citySet).forEach(c => { if (byCity[c]) byCity[c].trackCount++; });
  });
  // 手动点亮的城市
  rt.db.footprints.forEach(f => {
    if (!f.city) return;
    const o = byCity[f.city] || (byCity[f.city] = {
      city: f.city, province: f.province || '', firstDate: '', lastDate: '',
      dates: {}, times: [], pointCount: 0, photoCount: 0, coverUrl: '', trackCount: 0, manual: false
    });
    o.manual = true;
    if (f.province && !o.province) o.province = f.province;
    if (f.firstDate && (!o.firstDate || f.firstDate < o.firstDate)) o.firstDate = f.firstDate;
    if (f.remark) o.remark = f.remark;
    if (f.id) o.manualId = f.id;
  });
  /* G5 点亮规则：minStayMinutes>0 时，自动点亮需「最长单段停留」达到阈值；手动点亮不受影响。
     未达标城市不进点亮集合（不影响 points 光点与统计口径）。 */
  const minStay = (rt.db.settings.fpRule && rt.db.settings.fpRule.minStayMinutes) || 0;
  const cities = Object.values(byCity)
    .filter(o => o.manual || !minStay || fpMaxStayMinutes(o.times) >= minStay)
    .map(o => Object.assign({}, o, {
      dayCount: Object.keys(o.dates).length, dates: undefined, times: undefined
    }));
  cities.sort((a, b) => (b.firstDate || '').localeCompare(a.firstDate || ''));
  // 省份覆盖
  const provMap = {};
  cities.forEach(c => {
    if (!c.province) return;
    const o = provMap[c.province] || (provMap[c.province] = { province: c.province, cityCount: 0, pointCount: 0, firstDate: '' });
    o.cityCount++; o.pointCount += c.pointCount;
    if (c.firstDate && (!o.firstDate || c.firstDate < o.firstDate)) o.firstDate = c.firstDate;
  });
  const provinces = Object.values(provMap).sort((a, b) => b.cityCount - a.cityCount);
  const totalDistance = rt.db.tracks.reduce((s, t) => s + trackWithStats(t, false).distance, 0);
  const photoCount = rt.db.trackPoints.reduce((s, p) => s + (p.photoIds || []).length, 0);
  const dayCount = new Set(rt.db.tracks.map(t => t.date).filter(Boolean)).size;
  const ACH = [
    { key: 'first', icon: '🌱', name: '初次远行', desc: '点亮第 1 座城市', cur: cities.length, need: 1 },
    { key: 'c5', icon: '🏙', name: '城市漫游者', desc: '点亮 5 座城市', cur: cities.length, need: 5 },
    { key: 'c10', icon: '🧭', name: '行者无疆', desc: '点亮 10 座城市', cur: cities.length, need: 10 },
    { key: 'c20', icon: '🗺', name: '大江南北', desc: '点亮 20 座城市', cur: cities.length, need: 20 },
    { key: 'c30', icon: '🏔', name: '万里江山', desc: '点亮 30 座城市', cur: cities.length, need: 30 },
    { key: 'p5', icon: '🏛', name: '纵横四方', desc: '点亮 5 个省份', cur: provinces.length, need: 5 },
    { key: 'pt50', icon: '📍', name: '打卡达人', desc: '打卡点累计 50 个', cur: rt.db.trackPoints.length, need: 50 },
    { key: 'ph30', icon: '📷', name: '影像记录者', desc: '照片累计 30 张', cur: photoCount, need: 30 },
    { key: 'km1000', icon: '🚗', name: '千里之行', desc: '累计里程 1000 公里', cur: Math.round(totalDistance / 1000), need: 1000 },
    { key: 'd100', icon: '📅', name: '坚持记录', desc: '记录天数累计 100 天', cur: dayCount, need: 100 }
  ].map(a => ({ key: a.key, icon: a.icon, name: a.name, desc: a.desc, done: a.cur >= a.need, cur: a.cur, need: a.need }));
  return {
    cities: cities,
    provinces: provinces,
    litCityCount: cities.length,
    litProvinceCount: provinces.length,
    provinceTotal: CN_REGION.length,
    cityTotal: CITY_FLAT.length,
    manualCount: rt.db.footprints.length,
    achievements: ACH,
    doneAchievements: ACH.filter(a => a.done).length,
    points: points.slice(0, 3000),
    stats: {
      trackCount: rt.db.tracks.length, pointCount: rt.db.trackPoints.length,
      photoCount: photoCount, totalDistance: Math.round(totalDistance), dayCount: dayCount
    }
  };
}

/** 年度足迹报告 */
function buildAnnual(year) {
  /* year='all'：全部年份汇总（前端年报「全部年份」选项），不做年份过滤 */
  const isAll = String(year) === 'all';
  const y = isAll ? 'all' : String(year || new Date().getFullYear());
  const tracks = isAll ? rt.db.tracks.slice() : rt.db.tracks.filter(t => (t.date || '').startsWith(y));
  const ids = {}; tracks.forEach(t => { ids[t.id] = t; });
  const pts = rt.db.trackPoints.filter(p => ids[p.trackId]);
  const cities = {}, provs = {}, places = {}, moods = {}, byMonth = {};
  let distance = 0, photos = 0;
  tracks.forEach(t => {
    const st = trackWithStats(t, false);
    distance += st.distance; photos += st.photoCount;
    const mk = (t.date || '').slice(0, 7);
    if (mk) { const o = byMonth[mk] || (byMonth[mk] = { month: mk, trackCount: 0, pointCount: 0, distance: 0 }); o.trackCount++; o.pointCount += st.pointCount; o.distance += st.distance; }
    if (t.mood) moods[t.mood] = (moods[t.mood] || 0) + 1;
  });
  pts.forEach(p => {
    if (p.city) { cities[p.city] = (cities[p.city] || 0) + 1; if (p.province) provs[p.province] = (provs[p.province] || 0) + 1; }
    const n = (p.name || '').trim(); if (n) places[n] = (places[n] || 0) + 1;
  });
  // 本年首次到访的城市（按全年数据判断）
  const all = buildFootprint().cities;
  /* isAll 时全年份汇总：所有城市的首次到访均在范围内，newCities 即全量城市 */
  const newCities = (isAll ? all : all.filter(c => (c.firstDate || '').startsWith(y))).map(c => ({ city: c.city, province: c.province, firstDate: c.firstDate }));
  const top = (obj, key, n) => Object.keys(obj).map(k => ({ name: k, count: obj[k] })).sort((a, b) => b.count - a.count).slice(0, n);
  return {
    year: y,
    trackCount: tracks.length,
    pointCount: pts.length,
    photoCount: photos,
    distance: Math.round(distance),
    cityCount: Object.keys(cities).length,
    provinceCount: Object.keys(provs).length,
    newCities: newCities,
    cities: top(cities, 'city', 50),
    provinces: top(provs, 'province', 40),
    topPlaces: top(places, 'place', 10),
    byMood: top(moods, 'mood', 12),
    byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
    latest: tracks.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 12)
      .map(t => ({ id: t.id, title: t.title, date: t.date, pointCount: trackWithStats(t, false).pointCount, mood: t.mood || '' })),
    isCurrent: y === String(new Date().getFullYear())
  };
}

function trackFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  const date = pick('date', todayStr()) || todayStr();
  return {
    title: String(pick('title', '') || '').trim() || (date + ' 行程'),
    date: date,
    startTime: pick('startTime', '') || '',
    endTime: pick('endTime', '') || '',
    mood: pick('mood', '') || '',
    weather: pick('weather', '') || '',
    memberIds: Array.isArray(body.memberIds)
      ? body.memberIds.filter(x => x).map(Number).slice(0, 20)
      : (isNew ? [] : (cur.memberIds || [])),
    status: pick('status', 'done') === 'doing' ? 'doing' : 'done',
    sport: String(pick('sport', '') || '').slice(0, 12),
    remark: pick('remark', '') || ''
  };
}

function pointFields(body, base) {
  const isNew = !base;
  const cur = base || {};
  const pick = (k, def) => (body[k] !== undefined ? body[k] : (isNew ? def : cur[k]));
  return {
    lat: +pick('lat', 0) || 0,
    lng: +pick('lng', 0) || 0,
    name: String(pick('name', '') || '').trim(),
    address: pick('address', '') || '',
    province: pick('province', '') || '',
    city: pick('city', '') || '',
    district: pick('district', '') || '',
    time: pick('time', '') || '',
    source: pick('source', 'manual') === 'auto' ? 'auto' : 'manual',
    mood: pick('mood', '') || '',
    weather: pick('weather', '') || '',
    remark: pick('remark', '') || '',
    photoIds: Array.isArray(body.photoIds)
      ? body.photoIds.filter(x => x).map(Number).slice(0, 30)
      : (isNew ? [] : (cur.photoIds || []))
  };
}

/** 行程统计：打卡点数 / 里程 / 照片 / 起止点 / 自动采点数 */
function trackWithStats(t, withPoints) {
  const pts = rt.db.trackPoints.filter(p => p.trackId === t.id)
    .sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.id - b.id);
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1], pts[i]);
  const photoIds = pts.reduce((s, p) => s.concat(p.photoIds || []), []);
  const out = Object.assign({}, t, {
    pointCount: pts.length,
    distance: Math.round(dist),
    photoCount: photoIds.length,
    coverUrl: uploadUrl(photoIds[0]),
    autoCount: pts.filter(p => p.source === 'auto').length,
    firstPoint: pts[0] ? { name: pts[0].name || '', lat: pts[0].lat, lng: pts[0].lng } : null,
    lastPoint: pts.length ? { name: pts[pts.length - 1].name || '', lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng } : null
  });
  if (withPoints) out.points = pts.map(p => Object.assign({}, p, { photoUrls: (p.photoIds || []).map(uploadUrl) }));
  return out;
}

function removeUpload(id) {
  const u = rt.db.uploads.find(x => x.id === +id);
  if (!u) return false;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, u.file)); } catch (e) { /* 文件可能已被清理 */ }
  rt.db.uploads = rt.db.uploads.filter(x => x.id !== u.id);
  return true;
}

/** 删除行程时级联清理打卡点与照片 */
function purgeTrack(trackId) {
  const pts = rt.db.trackPoints.filter(p => p.trackId === trackId);
  pts.forEach(p => (p.photoIds || []).forEach(removeUpload));
  rt.db.trackPoints = rt.db.trackPoints.filter(p => p.trackId !== trackId);
  rt.db.tracks = rt.db.tracks.filter(t => t.id !== trackId);
}

/* ---------------- 照片打卡点（photoPoints） ----------------
 * 从 server.js「从 handleApi 上提的局部常量与函数」区搬入。为什么属于这里：
 * photoPoints 与 trackPoints 是同一批地理数据的两种形态（停留点 vs 轨迹），
 * 消费方也只有 footprint.routes.js；归一规则（坐标范围/时间格式/缩略图
 * 上限）是「一条照片点长什么样」的定义，与 pointFields 对打卡点的定义同构。
 *
 * 上限为什么是硬规则：thumb 是 base64 直塞 db.json 的，PHOTO_MAX 保护总体积、
 * THUMB_MAX 保护单条——超限的 thumb 直接丢弃而不是报错，因为导入场景下
 * 「大部分点进来、个别点丢图」远比「整批导入失败」更接近用户预期。 */
const PHOTO_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#a855f7', '#64748b'];

const PHOTO_MAX = 2000;            // 总量上限（thumb 为 base64，保护 db.json 体积）

const THUMB_MAX = 12 * 1024;       // 单条缩略图 dataURL 上限

const PHOTO_TIME_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

function photoPointNorm(it) {
  if (!it || typeof it !== 'object') return null;
  const lat = +it.lat, lng = +it.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(lat > -90 && lat < 90) || !(lng > -180 && lng < 180)) return null;
  let time = String(it.time || '').trim();
  if (!PHOTO_TIME_RE.test(time)) time = '';
  let thumb = String(it.thumb || '');
  if (thumb && (!thumb.startsWith('data:image/jpeg;base64,') || thumb.length > THUMB_MAX)) thumb = '';
  return { lat, lng, name: safeSlice(String(it.name || ''), 50), time, thumb };
}

function photoPointsImport(arr) {
  let added = 0, skipped = 0, invalid = 0;
  const seen = {};
  rt.db.photoPoints.forEach(p => { seen[p.lat + ',' + p.lng + ',' + (p.time || '')] = 1; });
  for (const it of arr) {
    const f = photoPointNorm(it);
    if (!f) { invalid++; continue; }
    const key = f.lat + ',' + f.lng + ',' + f.time;
    if (seen[key]) { skipped++; continue; }
    if (rt.db.photoPoints.length >= PHOTO_MAX) { skipped++; continue; }
    seen[key] = 1;
    rt.db.photoPoints.push(Object.assign({ id: newId(rt.db), createdAt: nowStr() }, f));
    added++;
  }
  return { added, skipped, invalid };
}

/* 在线底图瓦片内存缓存（key: z/x/y → PNG Buffer）。
 * 主消费者是 footprint.routes.js（出站代理瓦片）；settings.routes.js 在
 * 切换瓦片源时 clear()——缓存归属填它的域，设置侧只做失效，不持有。 */
const mapTileCache = new Map();

module.exports = {
  IMG_EXT,
  MAX_UPLOAD_BYTES,
  MOOD_SET,
  PHOTO_COLORS,
  PHOTO_MAX,
  THUMB_MAX,
  PHOTO_TIME_RE,
  buildAnnual,
  buildFootprint,
  mapTileCache,
  photoPointNorm,
  photoPointsImport,
  pointFields,
  purgeTrack,
  removeUpload,
  trackFields,
  trackWithStats,
  uploadUrl,
};
