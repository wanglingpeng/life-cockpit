/* 备份系统：本地备份 + 云备份（S3 兼容对象存储）+ 保留策略 + 校验 + 定时调度。
 *
 * 为什么是一个模块而不是按「本地/云/调度」再切：这三层共享同一份
 * manifest 契约（buildSafeBackupJson 产内容、runDailyBackup 落盘、
 * verifyManifestFiles 校验），且 backupTick 的互斥（_backupRunning）
 * 横跨本地与云两条路径。切开就会出现「互斥只护住了本地那条」——
 * 而这种 bug 只在云端备份进行中又触发一次本地备份时才现形。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）：备份运行时
 * 「导入备份」会整体替换 db，缓存快照会让备份配置读到旧库。
 *
 * 从 server.js 抽出（原「家人档案 / 家庭账本 辅助」区末段的备份段 +
 * 云备份辅助函数）。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { atomicWriteSync } = require('../core/atomic');
const { BACKUP_AUTO_ROOT, DATA_DIR, DB_FILE, STORAGE_KEY_FILE, STORAGE_KIND, STORAGE_FILE, UPLOAD_DIR } = require('../core/paths');
const rt = require('../core/runtime');
const { APP_VERSION } = require('../core/version');
const { checkpointStorage, flushSaveDb, saveDb, isUsableDb } = require('./db-io');
const { sha256, sha256Buf, sha256File } = require('../../lib/crypto.js');
const { dateAddDays, fmtBytes, isoWeekKey, nowStr, todayStr, fileStamp, crc32, dosDateTime, sigHmac, sigSha256Hex, sigUriEncode } = require('./utils');

/**
 * 构造并发送一次 S3/MinIO PUT Object（SigV4）。
 * cfg: { endpoint, bucket, accessKey, secretKey, region? }
 * 返回 Promise<{ok, status?, detail}>
 */
function s3PutObject(cfg, key, bodyBuffer) {
  return new Promise((resolve) => {
    try {
      const endpoint = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
      const bucket = String(cfg.bucket || '').trim();
      const accessKey = String(cfg.accessKey || '').trim();
      const secretKey = String(cfg.secretKey || '').trim();
      if (!endpoint || !bucket || !accessKey || !secretKey) {
        return resolve({ ok: false, detail: '对象存储配置不完整' });
      }
      let u;
      try { u = new URL(endpoint); } catch (e) { return resolve({ ok: false, detail: 'Endpoint 无效: ' + endpoint }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, detail: 'Endpoint 需 http(s) 协议' });

      const region = String(cfg.region || 'us-east-1').trim() || 'us-east-1';
      const service = 's3';
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');  // YYYYMMDDTHHMMSSZ
      const dateStamp = amzDate.slice(0, 8);
      const host = u.host; // 含端口
      const canonicalUri = '/' + sigUriEncode(bucket) + '/' + sigUriEncode(key);
      const payloadHash = sigSha256Hex(bodyBuffer.toString('utf8'));

      // CanonicalRequest：method + uri + query(空) + 头 + 签名头 + 载荷哈希
      const canonicalHeaders =
        'host:' + host + '\n' +
        'x-amz-content-sha256:' + payloadHash + '\n' +
        'x-amz-date:' + amzDate + '\n';
      const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
      const canonicalRequest = [
        'PUT', canonicalUri, '',
        canonicalHeaders, signedHeaders, payloadHash
      ].join('\n');

      const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
      const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope,
        sigSha256Hex(canonicalRequest)
      ].join('\n');

      const kDate = sigHmac('AWS4' + secretKey, dateStamp);
      const kRegion = sigHmac(kDate, region);
      const kService = sigHmac(kRegion, service);
      const kSigning = sigHmac(kService, 'aws4_request');
      const signature = sigHmac(kSigning, stringToSign).toString('hex');

      const auth = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

      const headers = {
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': auth,
        'Content-Length': bodyBuffer.length
      };
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: canonicalUri,
        method: 'PUT',
        headers
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; if (raw.length > 300) raw = raw.slice(0, 300); });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, status: res.statusCode, detail: ok ? '已上传' : (raw || 'HTTP ' + res.statusCode) });
        });
      });
      req.on('error', e => resolve({ ok: false, detail: (e && e.message) || String(e) }));
      req.setTimeout(20000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, detail: '上传超时（20s）' }); });
      req.end(bodyBuffer);
    } catch (e) { resolve({ ok: false, detail: (e && e.message) || String(e) }); }
  });
}

/** 构建不含敏感信息的备份 JSON（与导出一致，供云端备份使用） */
function buildSafeBackupJson() {
  const safe = JSON.parse(JSON.stringify(rt.db));
  // R15：保留 users 的 passwordHash + salt —— 导出→导入后仍能正常登录（此前删除导致恢复后全员登不上）
  if (safe.vaultMaster) delete safe.vaultMaster; // 保险库主密码信封不可跨库迁移
  delete safe.aiProviders;                       // AI Key 加密信封不可迁移
  /* 埋点为本机运营数据，不进备份；同时保证「导出→导入」可往返
     （旧库仍可能残留 activityStats/visitLog 字段，必须剥离，否则导入侧白名单会 400） */
  delete safe.activityStats;
  delete safe.visitLog;
  if (safe.settings) {
    delete safe.settings.aiKey;
    delete safe.settings.aiEndpoint;
    delete safe.settings.aiSecretKey;
    delete safe.settings.appSecret;    // R13：剥离第三方密钥明文
    if (safe.settings.wechat) delete safe.settings.wechat.appSecret; // 微信 AppSecret 不随备份迁移
    delete safe.settings.subscribeToken;
    delete safe.settings.mapKey;
    delete safe.settings.storageApi;   // 含 secretKey
  }
  return safe;
}

/** 生成云备份对象名：life-cockpit-backup-YYYYMMDD-HHmmss.json */
function cloudBackupKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'life-cockpit-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
}

/** entries: [{name, data(Buffer), mtime}] → zip Buffer */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const crc = crc32(data);
    let method = 0, out = data;                    // 0=store
    try {
      const z = zlib.deflateRawSync(data, { level: 6 });
      if (z.length < data.length) { method = 8; out = z; }
    } catch (err) { /* 压缩失败 → store 兑底 */ }
    const dt = dosDateTime(e.mtime);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);               // local file header
    lh.writeUInt16LE(20, 4);                       // version needed
    lh.writeUInt16LE(0x0800, 6);                   // 文件名 UTF-8 标志
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dt.time, 10);
    lh.writeUInt16LE(dt.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(out.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                       // extra len
    parts.push(lh, nameBuf, out);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);               // central directory header
    ch.writeUInt16LE(20, 4);                       // version made by
    ch.writeUInt16LE(20, 6);                       // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dt.time, 12);
    ch.writeUInt16LE(dt.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(out.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);                       // extra
    ch.writeUInt16LE(0, 32);                       // comment
    ch.writeUInt16LE(0, 34);                       // disk start
    ch.writeUInt16LE(0, 36);                       // internal attrs
    ch.writeUInt32LE(0, 38);                       // external attrs
    ch.writeUInt32LE(offset, 42);                  // 本地头偏移
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + out.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);               // EOCD
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                       // comment len
  return Buffer.concat(parts.concat([cd, eocd]));
}

/* ==================== 每日自动备份（完整还原点） ====================
 * 备份单元 = 完整还原点，而非 buildSafeBackupJson() 那种「数据可携带导出」：
 *   - buildSafeBackupJson() 会剥离 settings 密钥 / vaultMaster / aiProviders / activityStats，
 *     用来做「换机器迁移」可以，但拿它当还原点会丢密钥信封与埋点，恢复后密钥全都解不开。
 *   - 因此此处直接原样复制 db.json + .storage-key + uploads/，并逐个算 SHA-256 存入 manifest，
 *     回读校验一致后才算成功。缺 .storage-key，settings 里的密文密钥将永远无法解密。
 */
/** 备份配置读取（补默认值，与 pushCfg 同风格） */
function backupCfg() {
  if (!rt.db.settings.backup || typeof rt.db.settings.backup !== 'object') rt.db.settings.backup = {};
  const c = rt.db.settings.backup;
  const def = {
    enabled: true, remoteDir: '', keepDays: 7, keepWeeks: 4, keepMonths: 6, maxDirs: 24,
    lastRunDate: '', lastResult: '', lastDir: '', lastSha: ''
  };
  Object.keys(def).forEach(k => { if (c[k] === undefined) c[k] = def[k]; });
  return c;
}

/**
 * 路径所属「卷」的纯函数判定（不做任何文件系统访问，便于断言/测试）。
 * Windows：取盘符（c: / d:）；POSIX：取挂载点首段（/、/mnt 等）。
 * @param {string} p 路径
 * @returns {string} 卷标识
 */
function pathVolume(p) {
  const abs = path.resolve(String(p || ''));
  if (process.platform === 'win32') {
    const m = abs.match(/^([a-zA-Z]:)/);
    return m ? m[1].toLowerCase() : abs.toLowerCase();
  }
  const parts = abs.split(path.sep).filter(Boolean);
  return '/' + (parts[0] || '');
}

/**
 * 判断两个路径是否在同一块盘/同一挂载点。纯函数：只依据路径字符串。
 * @returns {boolean}
 */
function isSameDisk(a, b) {
  if (!a || !b) return false;
  return pathVolume(a) === pathVolume(b);
}

/**
 * 枚举本机「可作异地备份目标」的卷。**只读**：绝不向任何位置写入探测文件。
 * 理由：探测可写性必须在目标盘建临时文件，属于副作用（在用户盘上凭空多出文件）；
 * 而真实可写性会由第一次异地复制原样暴露（copyBackupToRemote 返回失败原因），
 * 不需要提前试写。因此此处只报「存在 / 可读 / 容量 / 是否与数据同卷」。
 * Windows 依次探测 C:–Z: 盘符；POSIX 探测 /mnt、/media、/Volumes、/srv 下的一级子目录。
 * @returns {Array<{path:string,volume:string,readable:boolean,totalBytes:number,freeBytes:number,sameDisk:boolean,writable:null}>}
 */
function listVolumes() {
  const dataVol = pathVolume(DATA_DIR);
  const out = [];
  const push = p => {
    let readable = false, totalBytes = -1, freeBytes = -1;
    try { fs.readdirSync(p); readable = true; } catch (e) { /* 无介质 / 无权限 */ }
    try { const s = fs.statfsSync(p); totalBytes = s.blocks * s.bsize; freeBytes = s.bavail * s.bsize; } catch (e) { /* 忽略 */ }
    const vol = pathVolume(p);
    out.push({ path: p, volume: vol, readable, totalBytes, freeBytes, sameDisk: vol === dataVol, writable: null });
  };
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) {              /* C: – Z:（A:/B: 为保留软驱，不探） */
      const root = String.fromCharCode(c) + ':\\';
      try { if (!fs.existsSync(root)) continue; } catch (e) { continue; }
      push(root);
    }
  } else {
    ['/mnt', '/media', '/Volumes', '/srv'].forEach(base => {
      try {
        if (!fs.existsSync(base)) return;
        fs.readdirSync(base, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .forEach(e => push(path.join(base, e.name)));
      } catch (e) { /* 忽略 */ }
    });
  }
  return out;
}

/** 递归统计目录占用字节数（失败返回已累计值） */
function dirBytes(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += dirBytes(p);
      else n += fs.statSync(p).size;
    }
  } catch (e) { /* 忽略 */ }
  return n;
}

/** 生成 manifest 条目：相对 root 的正斜杠路径 + size + sha256 */
function relEntry(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const buf = fs.readFileSync(file);
  return { path: rel, size: buf.length, sha256: sha256Buf(buf) };
}

/** 递归复制目录（覆盖同名），用于异地副本 */
function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 递归复制目录并顺带收集 manifest 条目（out 累积） */
function copyTreeCollect(src, dst, root, out) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTreeCollect(s, d, root, out);
    else { fs.copyFileSync(s, d); out.push(relEntry(root, d)); }
  }
}

/** 读取备份点 manifest；缺失或结构不对返回 null */
function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (m && Array.isArray(m.files)) return m;
  } catch (e) { /* 忽略 */ }
  return null;
}

/**
 * 重算备份点内每个文件 sha256/size 与 manifest 比对。
 * @param {boolean} [checkExtra] 是否同时检测「目录里多出的未登记文件」。
 *   写盘后的即时回读（runDailyBackup）必须传 false —— 那一刻只关心「我刚写的文件对不对」，
 *   目录里可能有别的既有文件（不归本次备份管），不能因此把整次备份判失败。
 *   对外校验接口（/api/backup/verify、listBackups）传 true，用于抓「被塞入的额外文件」。
 */
function verifyManifestFiles(dir, manifest, checkExtra) {
  const mismatches = [];
  const listed = new Set();
  (manifest.files || []).forEach(f => {
    listed.add(f.path);
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) { mismatches.push({ path: f.path, reason: '缺失' }); return; }
    const buf = fs.readFileSync(p);
    if (buf.length !== f.size) mismatches.push({ path: f.path, reason: '大小不一致', expect: f.size, actual: buf.length });
    const real = sha256Buf(buf);
    if (real !== f.sha256) mismatches.push({ path: f.path, reason: 'sha256 不一致', expect: f.sha256, actual: real });
  });
  /* 反向遍历：备份目录里存在但 manifest 未登记的文件（篡改/多写）也算不一致，
     否则「悄悄塞进一个文件」会被漏报。manifest.json 自身除外。 */
  if (checkExtra) {
    try {
      const walk = (d, base) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          const rel = base ? base + '/' + e.name : e.name;
          if (e.isDirectory()) walk(p, rel);
          else if (rel !== 'manifest.json' && !listed.has(rel)) mismatches.push({ path: rel, reason: '未登记文件' });
        }
      };
      walk(dir, '');
    } catch (e) { /* 忽略读取异常 */ }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** 列出已有的备份日期目录（升序） */
function listBackupDates() {
  try {
    if (!fs.existsSync(BACKUP_AUTO_ROOT)) return [];
    return fs.readdirSync(BACKUP_AUTO_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort();
  } catch (e) { return []; }
}

/**
 * 保留策略（纯函数）：默认 日 7 + 周 4 + 月 6，硬上限 24 个目录。
 * 最近 keepDays 个自然日全留；更早的按 ISO 周每周只留最新一个（最多 keepWeeks 个周副本）；
 * 再按 YYYY-MM 每月只留最新一个（最多 keepMonths 个月副本）；最后按 maxDirs 截断（最旧优先删）。
 * 注：周层每 ISO 周至多 1 份；周层与月层合并不重复占周，唯一例外是跨月边界的 ISO 周
 * （两层各取最新一个，可能落在同一周）。
 * @param {string[]} dates 'YYYY-MM-DD' 数组
 * @param {{keepDays:number,keepWeeks:number,keepMonths:number,maxDirs:number,ref?:string}} opts
 * @returns {Set<string>} 需要保留的日期集合
 */
function keepBackupDates(dates, opts) {
  const keepDays = Math.max(0, opts.keepDays | 0);
  const keepWeeks = Math.max(0, opts.keepWeeks | 0);
  const keepMonths = Math.max(0, opts.keepMonths | 0);
  const maxDirs = Math.max(1, opts.maxDirs | 0);
  const ref = opts.ref || todayStr();
  const sorted = dates.slice().sort(); // 升序
  const keep = new Set();
  /* ① 最近 keepDays 个自然日（含 ref 当天）全留 */
  const dailyCut = dateAddDays(ref, -(keepDays - 1));
  sorted.filter(d => d >= dailyCut).forEach(d => keep.add(d));
  /* 更早的候选（升序） */
  const older = sorted.filter(d => d < dailyCut);
  /* ② 按 ISO 周：从新到旧取 keepWeeks 个「周」，每个周只留最新一个 */
  const byWeek = new Map();
  older.forEach(d => { const k = isoWeekKey(d); if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(d); });
  const weekKeysDesc = [...byWeek.keys()].sort().reverse();
  const keptWeekKeys = weekKeysDesc.slice(0, keepWeeks);
  keptWeekKeys.forEach(k => { const a = byWeek.get(k); keep.add(a[a.length - 1]); });
  /* ③ 再更早（严格早于最老的周副本）：按 YYYY-MM 每月只留最新一个，最多 keepMonths 个月。
     周层与月层是两条独立轴、各自取「最新一个」，因此**不重复占周**——但有一条边界例外：
     跨月边界的那个 ISO 周可能被两层各留一份（例如 2026-W36 = 08-31 + 09-06：
     08/31 是 8 月最新、09/06 是 9 月最新，同处一周）。这是「每月只留最新一个」的必然结果，
     总量仍 ≤ keepDays+keepWeeks+keepMonths ≤ 硬上限，不影响体积控制。 */
  const oldestKeptWeek = keptWeekKeys.length ? keptWeekKeys[keptWeekKeys.length - 1] : null;
  const monthCands = oldestKeptWeek ? older.filter(d => isoWeekKey(d) < oldestKeptWeek) : older;
  const byMonth = new Map();
  monthCands.forEach(d => { const k = d.slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(d); });
  const monthKeysDesc = [...byMonth.keys()].sort().reverse();
  monthKeysDesc.slice(0, keepMonths).forEach(k => { const a = byMonth.get(k); keep.add(a[a.length - 1]); });
  /* ④ 硬上限：超出则删最旧的 */
  if (keep.size > maxDirs) {
    [...keep].sort().slice(0, keep.size - maxDirs).forEach(d => keep.delete(d));
  }
  return keep;
}

/** 应用保留策略并删除被淘汰的目录，返回被删日期列表 */
function applyRetentionAndPrune(cfg) {
  const dates = listBackupDates();
  const keep = keepBackupDates(dates, cfg);
  const pruned = [];
  dates.forEach(d => {
    if (keep.has(d)) return;
    try { fs.rmSync(path.join(BACKUP_AUTO_ROOT, d), { recursive: true, force: true }); pruned.push(d); }
    catch (e) { /* 删除失败不致命 */ }
  });
  return pruned;
}

/** 异地复制：返回 {ok, dir, detail}；未配置/同盘都算「不 ok」并给出人话说明 */
function copyBackupToRemote(dayDir, cfg) {
  const dest = String(cfg.remoteDir || '').trim();
  if (!dest) {
    return { ok: false, dir: '', detail: '未配置异地目录——当前备份与 db.json 同盘，等同没有异地副本' };
  }
  const destAbs = path.resolve(dest);
  if (isSameDisk(destAbs, DATA_DIR)) {
    return { ok: false, dir: destAbs, detail: '异地目录与数据同盘（' + pathVolume(DATA_DIR) + '），磁盘损坏会同时丢失' };
  }
  try {
    const target = path.join(destAbs, path.basename(dayDir));
    copyDirRecursive(dayDir, target);
    return { ok: true, dir: target, detail: '已复制到 ' + target };
  } catch (e) {
    return { ok: false, dir: destAbs, detail: '异地复制失败：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 执行一次每日备份。
 * @param {{force?:boolean, trigger?:string}} [opts]
 * @returns {{ok:boolean,dir:string,bytes:number,fileCount:number,verified:boolean,remote:object,pruned:string[],skipped:boolean,error:string}}
 */
function runDailyBackup(opts) {
  opts = opts || {};
  const cfg = backupCfg();
  const today = todayStr();
  const dayDir = path.join(BACKUP_AUTO_ROOT, today);
  const report = {
    ok: false, dir: dayDir, bytes: 0, fileCount: 0, verified: false,
    remote: { ok: false, dir: cfg.remoteDir || '', detail: '' }, pruned: [], skipped: false, error: ''
  };
  try {
    if (!cfg.enabled && !opts.force) {
      report.skipped = true;
      report.remote.detail = '自动备份已关闭';
      return report;
    }
    /* 幂等：当天目录已存在且 manifest 校验通过 → 直接返回 skipped */
    if (fs.existsSync(dayDir) && !opts.force) {
      const m0 = readManifest(dayDir);
      if (m0 && verifyManifestFiles(dayDir, m0).ok) {
        report.ok = true; report.skipped = true;
        report.fileCount = m0.files.length;
        report.bytes = m0.files.reduce((s, f) => s + (f.size || 0), 0);
        report.verified = true;
        return report;
      }
    }
    /* force 重做：旧目录整体改名保留（绝不删除）。
       后缀拼到「秒+毫秒+随机」——避免同秒内连续 force 时改名撞名失败，
       若改名失败则直接报错中止（宁可本次备份失败，也绝不原地覆盖旧快照）。 */
    if (fs.existsSync(dayDir) && opts.force) {
      let renamed = false, lastErr = null;
      for (let i = 0; i < 5 && !renamed; i++) {
        const bak = dayDir + '.bak-' + fileStamp().slice(-6) + String(new Date().getMilliseconds()).padStart(3, '0') + crypto.randomBytes(2).toString('hex');
        try { fs.renameSync(dayDir, bak); renamed = true; }
        catch (e) { lastErr = e; }
      }
      if (!renamed) throw new Error('重做备份前无法保留旧目录（改名失败）：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
    }
    fs.mkdirSync(dayDir, { recursive: true });
    const files = [];
    /* 主数据文件（原样）。
       P0-6：旧实现永远只复制 db.json。LC_STORAGE=sqlite 时真实数据在
       db.sqlite，备份点里一份用户数据都没有，manifest 却照样全绿——
       这是最危险的「假备份」：直到真的要恢复才发现是空的。 */
    flushSaveDb();          // 先把防抖窗口里的写入落盘
    checkpointStorage();    // SQLite：WAL checkpoint 后复制主库才完整
    if (STORAGE_KIND === 'sqlite') {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = STORAGE_FILE + suffix;
        if (!fs.existsSync(src)) continue;
        const dst = path.join(dayDir, path.basename(STORAGE_FILE) + suffix);
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, 0o600); } catch (e) { /* Windows 忽略 */ }
        files.push(relEntry(dayDir, dst));
      }
      /* 附带可读 JSON 快照：verifyBackupPoint 与「导入备份」都以 db.json
         为准，SQLite 备份点也必须能通过这两道既有校验。 */
      const snap = path.join(dayDir, 'db.json');
      atomicWriteSync(snap, JSON.stringify(buildSafeBackupJson(), null, 2), 0o600);
      files.push(relEntry(dayDir, snap));
    } else if (fs.existsSync(DB_FILE)) {
      const dst = path.join(dayDir, 'db.json');
      fs.copyFileSync(DB_FILE, dst);
      try { fs.chmodSync(dst, 0o600); } catch (e) { /* Windows 忽略 */ }
      files.push(relEntry(dayDir, dst));
    }
    /* .storage-key（原样，0600）—— 缺它则 settings 里密文密钥永远解不开 */
    if (fs.existsSync(STORAGE_KEY_FILE)) {
      const dst = path.join(dayDir, '.storage-key');
      fs.copyFileSync(STORAGE_KEY_FILE, dst);
      try { fs.chmodSync(dst, 0o600); } catch (e) { /* Windows 忽略 */ }
      files.push(relEntry(dayDir, dst));
    }
    /* uploads/（递归；当前为空也要能正确处理） */
    if (fs.existsSync(UPLOAD_DIR)) {
      copyTreeCollect(UPLOAD_DIR, path.join(dayDir, 'uploads'), dayDir, files);
    }
    /* manifest.json */
    const manifest = { version: 1, createdAt: nowStr(), appVersion: APP_VERSION, storageKind: STORAGE_KIND, files };
    const manifestPath = path.join(dayDir, 'manifest.json');
    atomicWriteSync(manifestPath, JSON.stringify(manifest, null, 2), 0o600);
    /* 回读校验：重算并比对，不一致则整体失败并清理当天目录 */
    const v = verifyManifestFiles(dayDir, manifest);
    if (!v.ok) {
      try { fs.rmSync(dayDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      report.error = '备份回读校验失败：' + v.mismatches.map(x => x.path + '(' + x.reason + ')').join('; ');
      cfg.lastRunDate = today;
      cfg.lastResult = 'fail ' + report.error.slice(0, 120);
      saveDb();
      return report;
    }
    report.ok = true;
    report.verified = true;
    report.fileCount = files.length;
    report.bytes = files.reduce((s, f) => s + (f.size || 0), 0);
    /* 保留策略 */
    report.pruned = applyRetentionAndPrune(cfg);
    /* 异地复制 */
    report.remote = copyBackupToRemote(dayDir, cfg);
    /* 记账 */
    cfg.lastRunDate = today;
    cfg.lastDir = dayDir;
    cfg.lastSha = sha256File(manifestPath);
    const remoteTag = report.remote.ok ? '异地:已复制' : (cfg.remoteDir ? '异地:失败/' + (report.remote.detail || '') : '异地:未配置');
    cfg.lastResult = 'ok · ' + report.fileCount + ' 个文件 · ' + fmtBytes(report.bytes) + ' · ' + remoteTag +
      (report.pruned.length ? (' · 清理 ' + report.pruned.length + ' 个旧备份') : '');
    saveDb();
    console.log('[备份] 完成 ' + dayDir + '（' + report.fileCount + ' 文件 / ' + report.bytes + ' B，异地 ' + (report.remote.ok ? 'ok' : 'no') + (report.pruned.length ? '，清理 ' + report.pruned.join(',') : '') + '）');
  } catch (e) {
    /* 任何异常都不许打断服务，失败也记 lastResult */
    report.ok = false;
    report.error = (e && e.message) ? e.message : String(e);
    cfg.lastRunDate = today;
    cfg.lastResult = 'fail ' + report.error.slice(0, 120) + (report.remote.detail ? (' · ' + report.remote.detail.slice(0, 60)) : '');
    try { saveDb(); } catch (e2) { /* 忽略 */ }
    console.error('[备份] 失败：', report.error);
  }
  return report;
}

/** 备份状态（供设置页/接口） */
function backupStatus() {
  const c = backupCfg();
  const dirs = listBackupDates();
  let totalBytes = 0;
  dirs.forEach(d => { totalBytes += dirBytes(path.join(BACKUP_AUTO_ROOT, d)); });
  return {
    enabled: !!c.enabled,
    remoteDir: c.remoteDir || '',
    sameDisk: c.remoteDir ? isSameDisk(c.remoteDir, DATA_DIR) : true,
    lastRunDate: c.lastRunDate || '',
    lastResult: c.lastResult || '',
    lastDir: c.lastDir || '',
    dirCount: dirs.length,
    totalBytes,
    retention: { keepDays: c.keepDays, keepWeeks: c.keepWeeks, keepMonths: c.keepMonths, maxDirs: c.maxDirs }
  };
}

/** 备份点列表（日期倒序，verified 由重算 sha256 得出） */
function listBackups() {
  const dirs = listBackupDates().reverse();
  return dirs.map(date => {
    const dir = path.join(BACKUP_AUTO_ROOT, date);
    const m = readManifest(dir);
    let bytes = 0, fileCount = 0, verified = false, createdAt = '';
    if (m) {
      createdAt = m.createdAt || '';
      fileCount = m.files.length;
      bytes = m.files.reduce((s, f) => s + (f.size || 0), 0);
      verified = verifyManifestFiles(dir, m, true).ok;
    }
    return { date, dir, bytes, fileCount, verified, createdAt };
  });
}

/**
 * 校验某个备份点。
 * 分两层：① 完整性（manifest 的 sha256/size 全对 + 无未登记文件）；
 *        ② 可恢复性（结构性判定，复用恢复路径同一个 isUsableDb）——
 * 「校验通过 ≠ 可恢复」是备份最不该给的假保证：db.json 若为 `{}`/缺 users/缺 nextId，
 * 完整性可能全绿，但真恢复时 tryReadUsableDb 会拒绝。这里把同一判据前置。
 */
function verifyBackupPoint(date) {
  const dir = path.join(BACKUP_AUTO_ROOT, date);
  if (!fs.existsSync(dir)) return { ok: false, mismatches: [], error: '备份点不存在' };
  const m = readManifest(dir);
  if (!m) return { ok: false, mismatches: [], error: '缺少或损坏 manifest.json' };
  const r = verifyManifestFiles(dir, m, true);
  if (!r.ok) return { ok: false, mismatches: r.mismatches };
  /* ② 结构性可恢复判定（与 loadDb→recoverFromCorruption→tryReadUsableDb 同一判据） */
  const dbEntry = (m.files || []).find(f => f.path === 'db.json');
  if (!dbEntry) return { ok: false, mismatches: [], reason: '结构不可恢复', error: '备份点未包含 db.json，无法恢复' };
  let parsed = null, ok2 = true;
  try { parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')); }
  catch (e) { ok2 = false; }
  if (!ok2 || !isUsableDb(parsed)) {
    return { ok: false, mismatches: [], reason: '结构不可恢复', error: '备份点 db.json 不是可恢复的库结构（缺少 users 数组或数字 nextId）' };
  }
  return { ok: true, mismatches: [] };
}

/** 每日备份调度器：每 10 分钟 tick 一次 + 启动后约 20 秒补跑一次（沿用 push 调度风格） */
let _backupRunning = false;

function backupTick(trigger) {
  if (_backupRunning) return;
  const cfg = backupCfg();
  if (!cfg.enabled) return;
  const today = todayStr();
  if (cfg.lastRunDate === today && fs.existsSync(path.join(BACKUP_AUTO_ROOT, today))) return;
  _backupRunning = true;
  try {
    const r = runDailyBackup({ trigger: trigger, force: false });
    if (!r.skipped) console.log('[备份调度] ' + trigger + ' → ' + JSON.stringify({ ok: r.ok, dir: r.dir, files: r.fileCount, remote: !!(r.remote && r.remote.ok), pruned: r.pruned.length }));
  } finally { _backupRunning = false; }
}

function startBackupScheduler() {
  /* 启动后延时补跑一次：进程可能错过当天 0 点档，起来后立刻补上（若当天未备份） */
  setTimeout(() => { try { backupTick('startup'); } catch (e) { /* 忽略 */ } }, 20000);
  setInterval(() => { try { backupTick('interval'); } catch (e) { /* 忽略 */ } }, 10 * 60 * 1000);
}

module.exports = {
  applyRetentionAndPrune,
  backupCfg,
  backupStatus,
  backupTick,
  buildSafeBackupJson,
  buildZip,
  cloudBackupKey,
  copyBackupToRemote,
  copyDirRecursive,
  copyTreeCollect,
  dirBytes,
  isSameDisk,
  keepBackupDates,
  listBackupDates,
  listBackups,
  listVolumes,
  pathVolume,
  readManifest,
  relEntry,
  runDailyBackup,
  s3PutObject,
  startBackupScheduler,
  verifyBackupPoint,
  verifyManifestFiles,
};
