/**
 * 生活驾驶舱（克隆版）- 零依赖 Node.js 后端
 * 启动：node server.js   （默认端口 15808）
 * 账号：admin / admin123
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRouter } = require('./src/http/router');
const { atomicWriteSync } = require('./src/core/atomic');
/* store 实例（含 json/sqlite 后端注册）已搬到 src/services/db-io.js */
const { MODULES } = require('./src/modules');
const state = require('./src/core/state');
const { newToken, newId, todayStr, validDateStr, validAmount, safeSlice, toText, nowStr, fileStamp, RICH_TAGS, RICH_ATTRS, RICH_DROP, sanitizeRichHtml, htmlToPlain, daysToNextYearly, daysToNextYearlyLunar, daysUntil, mortgageMonthlyPayment, CORE_ACTIONS, dateKeyShift, dayWriteAndTotal, monthShift, weekStartOf, greetingByHour, parseJsonLoose, wechatSubValid, fillTpl, moneyVal, maskWebhook, sigHmac, sigSha256Hex, sigUriEncode, __zipCrcTable, crc32, dosDateTime, isoWeekKey, dateAddDays, fmtBytes, round2, fpMaxStayMinutes, CN_REGION, regionCore, CITY_FLAT, PROV_FLAT, parseRegion, searchCities, haversine } = require('./src/services/utils');
const { nextRunDate, calcNextRun, decorateSchedule, scheduleRuleText, scheduledFields, dueState } = require('./src/services/schedule');
const { store, masterKey, skEnc, skDec, SECRET_SCALARS, decryptSettingsSecrets, encryptSettingsSecrets, isUsableDb, SAVE_DEBOUNCE_MS, writeDbNow, flushSaveDb, saveDb, closeStorage, checkpointStorage } = require('./src/services/db-io');
const { s3PutObject, buildSafeBackupJson, cloudBackupKey, buildZip, backupCfg, pathVolume, isSameDisk, listVolumes, dirBytes, relEntry, copyDirRecursive, copyTreeCollect, readManifest, verifyManifestFiles, listBackupDates, keepBackupDates, applyRetentionAndPrune, copyBackupToRemote, runDailyBackup, backupStatus, listBackups, verifyBackupPoint, backupTick, startBackupScheduler } = require('./src/services/backup');
const { MOOD_SET, IMG_EXT, MAX_UPLOAD_BYTES, uploadUrl, buildFootprint, buildAnnual, trackFields, pointFields, trackWithStats, removeUpload, purgeTrack,
        PHOTO_COLORS, photoPointsImport, mapTileCache } = require('./src/services/footprint');
const { defaultLedgerBookId, ledgerFields, ledgerCatName, ledgerSummaryOf, ledgerBudgetStatus, ledgerAccountBalances, computeNetWorth, ASSET_TYPES,
        ensureLedgerCategories, migrateLedgerAccountsOnce, migrateLedgerTaxonomyOnce, LEDGER_ACCOUNT_TYPES, LEDGER_BOOK_KINDS } = require('./src/services/ledger');
const { AI_PROVIDERS, AI_CONN_PRESETS, AI_CONN_MAX, AI_SCENES, aiKey16, isVisionModel, aiSettings, aiTimeoutMs, aiConnOf, aiDefaultConn, aiBadModel, aiProviderStatus, aiServerProvider, probeProvider, aiCompleteOnce, aiActiveProvider, aiVisionProvider, aiBuildContext, aiSystemPrompt } = require('./src/services/ai');
const { ACTION_LABELS, telemetryEnabled, ensureStatsDay, recordActivity, markVisit, buildUsageInsights } = require('./src/services/telemetry');
const { familyFields, anniversaryLeft, mortgageNextPayment, nearestAnniversaryOf, memberWithStats, expiryItemFields } = require('./src/services/family');
const { wxMockMode, getWxAccessToken, wxJsCode2Session, sendWechatSubscribe, sendWechatSubscribeToAll } = require('./src/services/wechat');
const { ACTION_WINDOW_DAYS, buildTodayPayload, applyQuickAdd, isTodayTask, isUpcomingTask, todayActionItems } = require('./src/services/today');
const { buildDailyBrief, convertExpiryToTodo } = require('./src/services/brief');
const { buildAskSnapshot, ruleAnswer } = require('./src/services/ask');
const { buildDailyDigest, buildInsights, aiInsightCache, aiInsightSummary } = require('./src/services/digest');
const { PUSH_CHANNELS, PUSH_HOSTS, pushCfg, buildPushMessage, sendPush, startPushScheduler, startReminderScheduler } = require('./src/services/push');
/* 模块注册表（内置清单/懒播种/商店兜底数据）在 src/services/module-registry.js：
   42 行静态数据是组装根里最与「组装」无关的一块。 */
const { BUILTIN_MODULES, STORE_DEMO, ensureModules } = require('./src/services/module-registry');
const { DB_SCHEMA_VERSION, pidAlive, lockPidIsOurServer, acquireInstanceLock, releaseInstanceLock, defaultDb, tryReadUsableDb, filesByMtimeDesc, recoverFromCorruption, loadDb, migrateDb } = require('./src/services/db-lifecycle');
/* 运行时持有者：db 会被整体替换（自愈恢复 / 导入备份），所有代码——搬进
   src/services/ 的函数与本文件自己的——一律读 rt.db，不存在第二份副本。 */
const rt = require('./src/core/runtime');
const zlib = require('zlib');
/* 无状态加密原语（哈希 / 口令 KDF / AES）在 lib/crypto.js；
   依赖 db 与密钥文件的封装（masterKey/skEnc/skDec）随 db-io 搬到 src/services/db-io.js */
const { KDF_ITER, sha256, sha256Buf, sha256File, hashPassword, verifyPassword, aesEncrypt, aesDecrypt } = require('./lib/crypto.js');

const PORT = process.env.PORT || 15808;
/* 监听地址：默认仅本机 127.0.0.1（安全默认，避免局域网直接暴露明文登录）。
 * 局域网/公网访问需显式 HOST=0.0.0.0；公网部署建议由 Nginx 反代（反代侧再设 HOST=127.0.0.1）。
 * Docker 部署在 Dockerfile/compose 中显式声明 HOST=0.0.0.0（容器端口映射必需）。 */
const HOST = process.env.HOST || '127.0.0.1';
/* 仅自动化测试用：跳过「初始密码强制修改」守卫，避免测试脚本被 403 拦死 */
const SKIP_PWD_GUARD = process.env.SKIP_PWD_GUARD === '1';
/* 路径与运行常量抽到 src/core/paths.js：db-io 与 backup 两个 service 都要用，
   复制一份就会出现「改了这边忘了那边」的漂移，而那种漂移不报错。 */
const { ROOT, PUBLIC_DIR, DATA_DIR, UPLOAD_DIR, DB_FILE, SESSION_FILE, LOCK_FILE,
        STORAGE_KEY_FILE, STORAGE_KIND, STORAGE_FILE, BACKUP_ROOT, BACKUP_AUTO_ROOT } = require('./src/core/paths');
/* 版本号解析抽到 src/core/version.js：server.js（/api/version、漂移自检）与
   src/services/backup.js（备份 manifest 的 appVersion）共用。放在本文件里，
   backup.js 就只得反向 require server.js——循环依赖，arch:deps 会红。 */
const { APP_VERSION } = require('./src/core/version');


/* 限流（登录失败退避 + 通用写接口计数）在 src/core/rate-limit.js：同一关注点
   曾被拆成两节、中间隔着 Cookie 策略，读时要来回翻；内存态重启失效与
   sessions 一致，不进备份。 */
const { clientIp, loginFails, loginThrottleFail, loginThrottleKey, loginThrottleWait, writeThrottleAllow } = require('./src/core/rate-limit');

/* Cookie 策略：HTTP/HTTPS 同源均可登录；经 Nginx/宝塔反代走 HTTPS 时自动追加 Secure
   （可用环境变量 FORCE_SECURE_COOKIE=1 强制开启）
   HttpOnly：禁止前端 JS 读取 token，降低 XSS 窃取风险；浏览器仍会在同源请求自动携带，
   服务端鉴权（getAuthUser 读 cookie）不受影响。前端登出须走 /api/auth/logout 由服务端清除。 */
function buildTokenCookie(req, token) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = proto === 'https' || process.env.FORCE_SECURE_COOKIE === '1';
  return 'token=' + token + ';path=/;max-age=86400;HttpOnly;SameSite=Lax' + (isHttps ? ';Secure' : '');
}
/* 登出时清除 token cookie：属性须与下发时一致（path/HttpOnly/SameSite/Secure），否则浏览器不认 */
function buildClearTokenCookie(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = proto === 'https' || process.env.FORCE_SECURE_COOKIE === '1';
  return 'token=;path=/;max-age=0;HttpOnly;SameSite=Lax' + (isHttps ? ';Secure' : '');
}
/* 进程启动时刻（/api/version 返回，用于快速判断是否刚重启） */
const STARTED_AT = nowStr();

/* 农历表（1900-2100）与节日推算算法在 lib/lunar.js，这里只转供 app 面——
   组装根不再持有农历数据本身。 */
const { lunar2solar, holidaysOf } = require('./lib/lunar.js');

/* 两个按既定决策留在组装根的小函数（理由见 docs/ARCHITECTURE.md §11.0）：
   saveSessions 与 auth 相邻（getAuthUser 清过期会话时就地调它）；
   ensureGiftConfigs 无 gift 服务可依附，10 行的域不值得单开模块。 */

function saveSessions() {
  // 安全收口：不落盘明文 token（token 即会话凭证，进文件=进备份/日志）。
  // 每 session 只写元数据；重启后需重新登录（属预期）。
  const meta = Object.values(rt.sessions).map(s => ({ userId: s.userId, username: s.username, expireAt: s.expireAt }));
  atomicWriteSync(SESSION_FILE, JSON.stringify(meta), 0o600);
}
// 默认人情配置
function ensureGiftConfigs() {
  if (rt.db.giftConfigs.length === 0) {
    ['春节','婚礼','生日','满月','乔迁','升学','探病','吊唁','其他'].forEach(l =>
      rt.db.giftConfigs.push({ id: newId(rt.db), type: 'EVENT_TYPE', label: l }));
    ['亲属','朋友','同事','同学','邻居','其他'].forEach(l =>
      rt.db.giftConfigs.push({ id: newId(rt.db), type: 'RELATION_TYPE', label: l }));
    saveDb();
  }
}

/* ---------------- HTTP 基础 ---------------- */
/* 响应层（gzip/ETag/304/JSON 封装/请求体）已抽到 src/http/respond.js。
   它不依赖 server.js 的初始化顺序，可被任何模块直接 import。 */
const { GZIP_MIN_BYTES, MAX_BODY_BYTES, wantsGzip, sendBuffer, sendJson, ok, fail, readBody } = require('./src/http/respond');

function getAuthUser(req) {
  let token = null;
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (m) token = m[1];
  const auth = req.headers.authorization || '';
  if (!token && auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) return null;
  // 清理过期
  const now = Date.now();
  if (rt.sessions[token] && rt.sessions[token].expireAt < now) { delete rt.sessions[token]; saveSessions(); return null; }
  // 清理其他过期会话
  for (const t of Object.keys(rt.sessions)) if (rt.sessions[t].expireAt < now) delete rt.sessions[t];
  const s = rt.sessions[token];
  if (!s) return null;
  const user = rt.db.users.find(u => u.id === s.userId);
  return user || null;
}

function isAdmin(req) { const u = getAuthUser(req); return !!(u && u.role === 'admin'); }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  /* .mjs：按需加载的 ESM 模块（public/js/quick-add.mjs）。必须单独列——
     浏览器对 type="module" 和 import() 严格校验 MIME，返回 text/plain 会直接
     报 "Failed to load module script: Expected a JavaScript module script
     but the server responded with a MIME type of ..."，而且只在控制台报错，
     页面上表现为按钮点了没反应。 */
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/* P0-3：静态服务只认这些公开扩展名。此前 serveStatic 只对 .html 做
   「未登录跳登录页」判断，于是 public/dashboard.html.bak-14850 这种备份
   文件因后缀不认识，被当作 octet-stream 匿名下载，等于把整页源码送出去。
   .json / .bak / .zip / .env 等一律拒绝，避免 data 目录文件被顺带捞走。 */
const STATIC_EXT_OK = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.woff', '.woff2'
]);

/** 图片实体文件服务（data/uploads/，文件名强校验，防目录穿越） */
function serveUpload(req, res, urlPath) {
  /* 上传件里含证件/合同扫描件等敏感图片：必须登录后才能读。
     文件名虽是 32 位随机 hex，但 URL 一旦泄漏（分享截图 / 浏览器历史 / 转发链接）
     即长期公开；原先响应还带 public,max-age=604800 允许中间层缓存，
     因此改为「会话鉴权 + private 缓存」。小程序端不使用 /uploads/，不受影响。 */
  if (!getAuthUser(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Unauthorized');
    return;
  }
  const name = path.basename(urlPath);
  if (!/^[a-f0-9]{16,64}\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Forbidden'); return;
  }
  const file = path.join(UPLOAD_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    sendStatic(req, res, file, data, MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'private, max-age=604800');
  });
}

/* 静态资源缓存策略：
   - 带 ?v=<版本> 的资源（scripts/bump-version.mjs 已统一注入）内容随版本变化 → 可长期缓存；
   - 其它（含 HTML 页面）每次协商；因为已有 ETag，命中即 304，不再重传 181KB 的页面。 */
function staticCacheControl(req, ext) {
  const versioned = /[?&]v=/.test(String((req && req.url) || ''));
  const isAsset = ['.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2'].includes(ext);
  return (versioned && isAsset) ? 'public, max-age=31536000, immutable' : 'no-cache';
}
function sendStatic(req, res, file, data, mime, cacheOverride) {
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  const ext = path.extname(file).toLowerCase();
  sendBuffer(req, res, data, {
    mime: mime || MIME[ext] || 'application/octet-stream',
    cacheControl: cacheOverride || staticCacheControl(req, ext),
    file,
    mtime: st ? st.mtimeMs : 0,
    lastModified: st ? st.mtime.toUTCString() : null
  });
}

function serveStatic(req, res, urlPath) {
  let p = urlPath.split('?')[0];
  if (p === '/') p = '/dashboard';
  let file;
  /* 评审 P3-1：移除死路由 admin-apps（白名单里有、public/admin-apps.html 不存在、站内也无入口，
     访问只会 404）。白名单保持与 public/ 下的真实页面一一对应。 */
  const routes = ['dashboard','tasks','scheduled-tasks','notes','health','report','anniversaries','gift-records','expiries','networth','vault','mortgage','family','ledger','location','footprint','general-config','settings','ai','help-center','admin-modules','admin-store','insights'];
  if (p === '/login') file = path.join(PUBLIC_DIR, 'login.html');
  else if (routes.includes(p.slice(1))) file = path.join(PUBLIC_DIR, p.slice(1) + '.html');
  else file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!STATIC_EXT_OK.has(path.extname(file).toLowerCase())) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    // 未登录访问业务页：返回一个内联跳转页（比 302 在 iframe/预览面板中更可靠）
    // offline.html 例外：SW 安装期与离线回落都必须免登录可取
    if (ext === '.html' && p !== '/login' && p !== '/offline.html') {
      const user = getAuthUser(req);
      if (!user) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>跳转中</title>'
          + '<script>localStorage.removeItem("token");location.replace("/login");</script>'
          + '</head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#64748b;">'
          + '正在跳转到登录页...<br><a href="/login" style="margin-left:8px;color:#4CAF50;">点此手动进入</a></body></html>');
        return;
      }
    }
    sendStatic(req, res, file, data, MIME[ext] || 'application/octet-stream');
  });
}

/* ---------------- API 组装与分发 ----------------
 * 改造前：一个 3,770 行的 handleApi()，198 条 if 平铺，鉴权边界是第 1433 行的一行注释。
 * 改造后：路由拆到 src/modules/*.routes.js，每条路由显式声明 auth。
 *
 * 路由表**首次请求时**才构建：那时 loadDb / loadSessions / 迁移都已完成，
 * app 里拿到的 sessions 等引用是最新的。
 *
 * 这里剩下的就是组装根的本职：buildApiApp() 把各服务域的符号收拢成 app
 * 服务面（路由体只认 app，不反向 require 服务）、getApi() 懒建路由表、
 * handleApi() 做鉴权/限流/门禁后分发。原「从 handleApi 上提的局部常量与
 * 函数」已全部各归其域（照片点→footprint、证件效期→family、资产类型→
 * ledger、模块注册表→module-registry、限流→rate-limit），vaultLocked
 * 是唯一留根的小函数（无 vault 服务，同 ensureGiftConfigs 先例）。 */

const vaultLocked = () => !!rt.db.vaultMaster && !state.vaultEncKey;

let apiRouter = null;
let apiApp = null;

function getApi() {
  if (!apiRouter) {
    apiApp = buildApiApp();
    apiRouter = createRouter();
    for (const name of MODULES) {
      require('./src/modules/' + name + '.routes')(apiRouter, apiApp);
    }
  }
  return { router: apiRouter, app: apiApp };
}

/* handler 可用的服务面（135 个符号，由切分时实测得出）。
   约束：这里只放**只读或引用稳定**的符号。凡是被 handler 写入的跨请求状态，
   必须走 ctx.state —— 解构是快照，写不回原变量（vaultEncKey 就是例子）。 */
function buildApiApp() {
  return {
    /* 响应层 */
    fail, ok, readBody,

    /* 工具 */
    crypto, fileStamp, fs, htmlToPlain, https,
    newId, newToken, nowStr, parseJsonLoose, parseRegion,
    path, round2, safeSlice, searchCities, toText,
    todayStr, validAmount, validDateStr,

    /* 存储 */
    /* 存储。sessions 传 rt.sessions 引用而非快照：路由登录/登机就是往这个
       对象里增删成员。引用稳定性由启动顺序保证——loadDb（重置 rt.sessions）
       在模块装载期就跑完，getApi() 到首个 /api/ 请求才构建 app，永远晚于它。 */
    checkpointStorage, flushSaveDb, migrateDb, saveDb, saveSessions, sessions: rt.sessions,

    /* 鉴权 / 限流 */
    buildClearTokenCookie, buildTokenCookie, getAuthUser, isAdmin, loginThrottleFail,
    loginThrottleKey, loginThrottleWait,

    /* 领域服务 */
    AI_CONN_MAX, AI_CONN_PRESETS, AI_SCENES, APP_VERSION, ASSET_TYPES,
    BUILTIN_MODULES, CITY_FLAT, DATA_DIR, DB_FILE, IMG_EXT, KDF_ITER,
    LEDGER_ACCOUNT_TYPES, LEDGER_BOOK_KINDS, MAX_UPLOAD_BYTES, PHOTO_COLORS, PUSH_CHANNELS,
    PUSH_HOSTS, SKIP_PWD_GUARD, STARTED_AT, STORAGE_KEY_FILE, STORAGE_KIND, STORAGE_FILE, STORE_DEMO,
    UPLOAD_DIR, aesDecrypt, aesEncrypt, aiActiveProvider, aiBadModel,
    aiCompleteOnce, aiConnOf, aiDefaultConn, aiInsightCache, aiInsightSummary,
    aiKey16, aiProviderStatus, aiServerProvider, aiSettings, aiSystemPrompt, aiTimeoutMs,
    aiVisionProvider, anniversaryLeft, applyQuickAdd, backupCfg, backupStatus,
    buildAnnual, buildDailyDigest, buildFootprint, buildInsights, buildPushMessage,
    ACTION_WINDOW_DAYS, buildSafeBackupJson, buildTodayPayload, buildDailyBrief, buildUsageInsights, buildZip, calcNextRun,
    convertExpiryToTodo, buildAskSnapshot, ruleAnswer, isTodayTask, isUpcomingTask, todayActionItems,
    cloudBackupKey, computeNetWorth, daysToNextYearly, daysUntil, decorateSchedule,
    defaultLedgerBookId, dueState, ensureModules, expiryItemFields, familyFields,
    hashPassword, holidaysOf, isVisionModel, ledgerAccountBalances, ledgerBudgetStatus,
    ledgerCatName, ledgerFields, ledgerSummaryOf, listBackups, listVolumes,
    loginFails, mapTileCache, maskWebhook, memberWithStats, mortgageMonthlyPayment,
    mortgageNextPayment, nearestAnniversaryOf, nextRunDate, pathVolume, photoPointsImport,
    pointFields, probeProvider, purgeTrack, pushCfg, recordActivity,
    removeUpload, runDailyBackup, s3PutObject, sanitizeRichHtml, scheduledFields,
    sendPush, sha256, sha256Buf, telemetryEnabled, trackFields,
    trackWithStats, uploadUrl, vaultLocked, verifyBackupPoint, verifyPassword,
    wechatSubValid, wxJsCode2Session,

  };
}

/* ---------------- CSRF 防护（P0-2） ----------------
 * 会话是 HttpOnly Cookie + SameSite=Lax + 24h。Lax 只挡「跨站导航携带 Cookie」，
 * 挡不住恶意页面发起的跨站写请求；而 docker-compose 默认绑 0.0.0.0，
 * 局域网内任何人都能访问这个服务，风险不是理论上的。
 *
 * 判定分两层：
 *   1) 不在 CSRF 面内 → 放行
 *      · Authorization: Bearer（小程序 / 非浏览器客户端；浏览器不会自动带这个头）
 *      · 请求里没有会话 Cookie（登录/注册等公开写接口，攻击者借不到用户身份）
 *   2) 在 CSRF 面内 → 必须满足其一
 *      · Origin（或 Referer）与 Host 同源，或在 CSRF_TRUSTED_ORIGINS 白名单里
 *      · 带自定义头 X-Requested-With: XMLHttpRequest
 *        跨站 <form> 设不了自定义头；跨站 fetch 带自定义头会触发 CORS 预检，
 *        本服务不下发任何 Access-Control-Allow-*，预检失败请求根本发不出去。
 *
 * 反代兼容：Host 被代理改写成内网地址时用 x-forwarded-host；若代理没设，
 * 用 CSRF_TRUSTED_ORIGINS 显式声明浏览器地址栏里的 Origin（见 docker-compose 注释）。
 * 已知盲区：不防「已能在同源页面里执行 JS」的 XSS —— 那是 CSP 那一层的事。
 */
function csrfGuardOk(req) {
  const h = req.headers;
  if (/^Bearer\s+\S+/i.test(String(h.authorization || ''))) return true;
  if (!/(?:^|;\s*)token=[^;]+/.test(String(h.cookie || ''))) return true;
  if (String(h['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest') return true;

  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  let originHost = '';
  try { originHost = new URL(String(h.origin || h.referer || '')).host.toLowerCase(); } catch (e) { return false; }
  if (!originHost || !host) return false;
  if (originHost === host) return true;
  const trusted = String(process.env.CSRF_TRUSTED_ORIGINS || '').split(',').map(s => {
    try { return new URL(s.trim()).host.toLowerCase(); } catch (e) { return ''; }
  }).filter(Boolean);
  return trusted.includes(originHost);
}

async function handleApi(req, res, pathname) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const method = req.method;
  const api = getApi();
  const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const ctx = {
    req, res, q, url, method, pathname, m: null,
    user: null, uid: null, db: rt.db, app: api.app, state,
    /* 唯一的 db 引用替换入口（导入备份用）。必须走 rt.setDb：
       本地 db 持有者已随本文件消除（全部读 rt.db），此方法保持原名是为了
       不动 src/modules/settings.routes.js 的调用点。 */
    replaceDb(v) { return rt.setDb(v); }
  };

  /* 防护放在路由解析之前：不该依赖「这个路径存不存在」来决定要不要防 CSRF。
     未知写路径同样是攻击面，而且先挡掉能避免探测。 */
  if (isWrite && !csrfGuardOk(req)) return fail(res, '请求来源未通过校验（疑似跨站请求），请刷新页面后重试', 403);

  const route = api.router.resolve(ctx);

  if (!route) {
    /* 与原实现一致：未知 /api/ 路径先过鉴权，未登录回 401 而不是 404，
       避免向未授权方暴露"哪些接口存在"。 */
    if (!getAuthUser(req)) return fail(res, '未登录或登录已过期', 401);
    if (isWrite && !writeThrottleAllow(clientIp(req))) return fail(res, '操作过于频繁，请稍后再试', 429);
    return fail(res, '接口不存在: ' + method + ' ' + pathname, 404);
  }

  if (route.auth === 'public') {
    /* 公开路由也可能带登录态（如 /api/calendar.ics 支持 token 或 session），
       所以仍解析用户，但不强制。 */
    ctx.user = getAuthUser(req);
    ctx.uid = ctx.user ? ctx.user.id : null;
  } else {
    const user = getAuthUser(req);
    if (!user) return fail(res, '未登录或登录已过期', 401);
    ctx.user = user;
    ctx.uid = user.id;
    /* 写接口通用限流（仅对已登录写操作生效，不影响读与登录） */
    if (isWrite && !writeThrottleAllow(clientIp(req))) return fail(res, '操作过于频繁，请稍后再试', 429);
    /* 安全门禁：账号仍是出厂密码时，除「查看自己 / 修改密码」外一律拒绝 */
    if (!SKIP_PWD_GUARD && rt.db.settings.requirePwdChange !== false && user.mustChangePassword) {
      const allowed = pathname === '/api/users/me' || pathname === '/api/users/change-password';
      if (!allowed) return fail(res, '请先修改初始密码后再使用', 403);
    }
  }

  /* P0-2：router 里声明的 auth:'admin' / role:'admin' 过去只是元数据，
     handleApi 从不消费——20 条管理员接口的门禁全靠各 handler 自觉写
     isAdmin(req)，漏写一条就是静默提权。这里做统一兜底校验。 */
  if (route.auth === 'admin' || route.role === 'admin') {
    if (!ctx.user || ctx.user.role !== 'admin') {
      return fail(res, '仅管理员可执行此操作', 403);
    }
  }

  await route.handler(ctx);
}

/* ---------------- 服务器 ---------------- */
/* F7：先取单实例锁再触库（loadDb 首次运行会写 db.json；若另一实例存活，必须在其写入前退出） */
acquireInstanceLock();

/* P0-7：优雅停服令牌。Windows 的 taskkill 无法给 Node 发 SIGTERM，
   官方停服脚本改为 POST /__lc_shutdown，让进程自己走完落盘流程。
   令牌每次启动重新生成、只写本机 0600 文件，并限定 loopback 访问。 */
const STOP_TOKEN = crypto.randomBytes(24).toString('hex');
try {
  atomicWriteSync(path.join(DATA_DIR, '.stop-token'), STOP_TOKEN, 0o600);
} catch (e) {
  console.error('[停服] ⚠️ 无法写入 data/.stop-token，优雅停服脚本将不可用：' + (e && e.message ? e.message : e));
}

loadDb();
ensureGiftConfigs();
ensureLedgerCategories();
/* 账户实体迁移：备份 → 预置账户 → 历史流水回填账户 → 收支总额校验（幂等） */
migrateLedgerAccountsOnce();
/* 二级分类 + 场景账本迁移：备份 → 补层级/预置分类 → 预置账本 → 流水归属默认账本（幂等） */
migrateLedgerTaxonomyOnce();

/* ---------------- 安全响应头 v2（F4 修复：HSTS + CSP 分阶段） ----------------
 * HSTS：仅当请求经 HTTPS（x-forwarded-proto=https 或 FORCE_SECURE_COOKIE=1）时下发，
 *       避免纯 HTTP 本地访问被浏览器缓存 HSTS 后无法回退。
 * CSP（阶段 1，保守）：default-src 'self' + 白名单。
 *   - 'unsafe-inline' 暂保留：现有 38 处内联 <script>（阶段 2 计划：内联外置 + nonce/hash 后移除）；
 *   - 白名单已覆盖实测外部加载：map.qq.com（腾讯地图 SDK，footprint 页）、瓦片 *.is.autonavi.com /
 *     tile.openstreetmap.org、天气 api.open-meteo.com（前端 fetch）；推送/AI/对象存储均为后端出站，不受 CSP 约束；
 *   - 站点无 <base>/<object>/<embed>/<iframe>，object-src 'none' + frame-ancestors 'self' 无副作用。
 * 回退/观察：CSP_REPORT_ONLY=1 → 只发 Content-Security-Policy-Report-Only（观察不拦截）；CSP_DISABLE=1 → 完全关闭。 */
function reqIsHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || process.env.FORCE_SECURE_COOKIE === '1';
}
const CSP_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' https://map.qq.com https://apikey.map.qq.com https://confinfo.map.qq.com https://overseactrl.map.qq.com https://vectorsdk.map.qq.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://map.qq.com https://lbs.qq.com https://*.is.autonavi.com https://tile.openstreetmap.org https://mapapi.qq.com https://pr.map.qq.com https://mapstyle.qpic.cn https://*.map.gtimg.com https://*.qpic.cn; connect-src 'self' https://api.open-meteo.com https://map.qq.com https://lbs.qq.com https://*.is.autonavi.com https://tile.openstreetmap.org https://vectorsdk.map.qq.com https://pr.map.qq.com https://mapapi.qq.com https://mapstyle.qpic.cn https://*.map.gtimg.com https://*.qpic.cn; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; worker-src 'self' blob:";

const server = http.createServer((req, res) => {
  /* 全局安全响应头：对所有响应（API / 静态 / 上传）生效。
     用 setHeader 设默认头，后续各 writeHead 显式指定的 Content-Type 等会正常覆盖，互不冲突。 */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  if (process.env.CSP_DISABLE !== '1') {
    res.setHeader(process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', CSP_POLICY);
  }
  if (reqIsHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  /* 本机优雅停服端点（P0-7）：三重限制 = loopback + POST + 一次性令牌。
     先回响应再在下一个 tick 执行关闭，避免客户端拿到 ECONNRESET。 */
  if (pathname === '/__lc_shutdown') {
    const ip = String(req.socket.remoteAddress || '');
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const token = String(req.headers['x-lc-stop-token'] || '');
    if (req.method !== 'POST' || !isLocal || !STOP_TOKEN || token !== STOP_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 200, message: '数据保存中，服务即将停止' }));
    setImmediate(() => shutdown('HTTP 停服指令'));
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch(e => {
      console.error(e);
      if (e && e.isPayloadTooLarge) {
        return fail(res, '请求体过大，已拒绝写入（上限 12MB）', 413);
      }
      /* 落盘失败（磁盘满/无权限/rename 失败）单独可识别：内存已改、磁盘未落，
         必须直说，避免用户以为"没保存成功"却实际已生效（反之亦然）。 */
      if (e && e.isPersistError) {
        return fail(res, '数据已修改但落盘失败，本次改动未写入磁盘，请检查磁盘空间/权限后重试', 500);
      }
      fail(res, '服务器内部错误', 500);
    });
    return;
  }
  if (pathname.startsWith('/uploads/')) { serveUpload(req, res, pathname); return; }
  serveStatic(req, res, pathname);
});

/* P0-7：单一停服流程，顺序不能换：
   ① 停止接受新连接并等在途请求跑完  ② 强制落盘（清掉 200ms 防抖窗口）
   ③ flush + 关闭 SQLite/WAL        ④ 释放实例锁与停服令牌  ⑤ 退出
   db-lifecycle.js 已不再抢注信号钩子，stop-service.bat 也不再 taskkill /f。
   退出码 75 = 「优雅停服」，供 start.bat 识别后停止自动重启循环。 */
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[停服] ' + reason + '：等待在途请求完成…');
  const forceTimer = setTimeout(() => {
    console.warn('[停服] 等待在途请求超时，执行强制退出');
    process.exit(75);
  }, 8000);
  forceTimer.unref();
  await new Promise(resolve => {
    try { server.close(resolve); } catch (e) { resolve(); }
    /* 关掉空闲 keep-alive 连接，但不等在途请求；Node 22 支持 */
    try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (e) { /* 忽略 */ }
  });
  try { flushSaveDb(); console.log('[停服] 数据已落盘'); }
  catch (e) { console.error('[停服] ⚠️ 落盘失败：' + (e && e.message ? e.message : e)); }
  try { closeStorage(); } catch (e) { /* closeStorage 内部已兜底 */ }
  try { releaseInstanceLock(); } catch (e) { /* exit 钩子仍会兜底 */ }
  try { fs.unlinkSync(path.join(DATA_DIR, '.stop-token')); } catch (e) { /* 已清理 */ }
  console.log('[停服] 已安全退出');
  clearTimeout(forceTimer);
  process.exit(75);
}

/* exit 钩子只在异常退出 / 未走 shutdown 的场合兜底；closeStorage 已幂等 */
process.on('exit', closeStorage);
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

server.listen(PORT, HOST, () => {
  console.log('==========================================');
  console.log('  生活驾驶舱（克隆版）已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  if (HOST === '0.0.0.0') console.log('  局域网访问: http://<本机IP>:' + PORT);
  else console.log('  监听地址:   ' + HOST + '（仅可由反向代理访问）');
  console.log('  默认账号:   admin（首次登录会强制修改初始密码）');
  console.log('  数据目录:   ' + DATA_DIR);
  console.log('  运行版本:   v' + APP_VERSION + '（启动于 ' + STARTED_AT + '）');
  if (SKIP_PWD_GUARD) console.log('  ⚠ 已通过 SKIP_PWD_GUARD=1 关闭初始密码守卫（仅限自动化测试）');
  console.log('==========================================');
  /* 版本号漂移自检：common.js 的 APP_VERSION 必须与 package.json 一致 */
  checkVersionDrift();
  startPushScheduler();
  startReminderScheduler();
  startBackupScheduler();
});
/**
 * 版本漂移自检：读取 public/js/common.js 的 APP_VERSION 与 package.json 比对，
 * 不一致则醒目提示（说明有人改了版本却没跑 bump-version）。
 */
function checkVersionDrift() {
  try {
    const p = path.join(PUBLIC_DIR, 'js', 'common.js');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/var\s+APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== APP_VERSION) {
      console.warn('⚠️ 版本号漂移：common.js=' + m[1] + ' package.json=' + APP_VERSION + '，请执行 node scripts/bump-version.mjs');
    }
  } catch (e) { /* 文件缺失等忽略 */ }
}
