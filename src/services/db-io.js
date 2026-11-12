/* db 落盘与密钥管理。
 *
 * 两块内容之所以必须在一起：writeDbNow() 落盘前要 encryptSettingsSecrets()
 * 把敏感字段加密、落盘后还原，而加密要用 masterKey()/skEnc()。拆开就会出现
 * 「落盘忘了加密」这种静默泄露，所以它们是一个不可分的事务单元。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）：db 会被整体替换
 * （自愈恢复 / 导入备份），缓存快照会让替换后仍读到旧库。
 *
 * 从 server.js 抽出（原「数据存储」区的落盘段与密钥段）。 */
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('../storage');
require('../storage/json');
require('../storage/sqlite');
const { STORAGE_KIND, STORAGE_FILE, STORAGE_KEY_FILE } = require('../core/paths');
const rt = require('../core/runtime');
const { aesEncrypt, aesDecrypt } = require('../../lib/crypto.js');

const store = createStore({ kind: STORAGE_KIND, file: STORAGE_FILE });

let _masterKey = null;

function masterKey() {
  if (_masterKey) return _masterKey;
  try {
    if (fs.existsSync(STORAGE_KEY_FILE)) {
      const k = fs.readFileSync(STORAGE_KEY_FILE, 'utf8').trim();
      if (k && k.length >= 32) { _masterKey = k; return k; }
    }
  } catch (e) { /* 忽略 */ }
  _masterKey = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(STORAGE_KEY_FILE, _masterKey, { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
  return _masterKey;
}

/* 用 masterKey 对 settings 敏感字段做 AES 加密；密文统一带 enc: 前缀（已加密则原样返回） */
function skEnc(v) {
  if (v === undefined || v === null || v === '') return v;
  if (typeof v === 'string' && v.startsWith('enc:')) return v;
  const plain = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return 'enc:' + aesEncrypt(plain, masterKey());
}

/* 解密；非 enc: 前缀视为明文原样返回（兼容旧库），解密失败也原样返回（避免误伤/清空） */
function skDec(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:')) return v;
  const dec = aesDecrypt(v.slice(4), masterKey());
  return dec === '' ? v : dec;
}

/* 需要加密落盘的 settings 标量敏感字段 */
const SECRET_SCALARS = ['appKey', 'appSecret', 'subscribeToken', 'mapKey', 'aiKey', 'aiSecretKey'];

/* loadDb 之后调用：把 settings 敏感字段从密文还原为内存明文 */
function decryptSettingsSecrets() {
  const s = rt.db.settings; if (!s || typeof s !== 'object') return;
  let needEnc = false;
  /* 空串敏感字段（如 settings.aiKey='' / push.webhook=''）本就不会被加密落盘（见 encryptSettingsSecrets），
     不能判为「仍有明文」——否则每次启动都会触发一次无意义的全量写盘。 */
  SECRET_SCALARS.forEach(k => {
    if (typeof s[k] === 'string') { if (s[k] !== '' && !String(s[k]).startsWith('enc:')) needEnc = true; s[k] = skDec(s[k]); }
  });
  if (s.storageApi && typeof s.storageApi === 'object') {
    ['accessKey', 'secretKey'].forEach(k => {
      if (typeof s.storageApi[k] === 'string') { if (s.storageApi[k] !== '' && !String(s.storageApi[k]).startsWith('enc:')) needEnc = true; s.storageApi[k] = skDec(s.storageApi[k]); }
    });
  }
  if (s.push && typeof s.push.webhook === 'string') {
    if (s.push.webhook !== '' && !String(s.push.webhook).startsWith('enc:')) needEnc = true;
    s.push.webhook = skDec(s.push.webhook);
  }
  /* 检测到仍有明文敏感字段 → 立即触发一次加密落盘迁移（内存保持明文，saveDb 内部加密写盘） */
  if (needEnc) saveDb();
}

/* saveDb 前调用：把内存明文替换为密文落盘，返回写盘后恢复内存明文的函数 */
function encryptSettingsSecrets() {
  const s = rt.db.settings; if (!s || typeof s !== 'object') return function () {};
  const orig = {};
  SECRET_SCALARS.forEach(k => { if (s[k] !== undefined && s[k] !== '') { orig[k] = s[k]; s[k] = skEnc(s[k]); } });
  if (s.storageApi && typeof s.storageApi === 'object') {
    ['accessKey', 'secretKey'].forEach(k => { const o = 'sa.' + k; if (s.storageApi[k] !== undefined && s.storageApi[k] !== '') { orig[o] = s.storageApi[k]; s.storageApi[k] = skEnc(s.storageApi[k]); } });
  }
  if (s.push && typeof s.push.webhook === 'string' && s.push.webhook !== '') { orig['push.webhook'] = s.push.webhook; s.push.webhook = skEnc(s.push.webhook); }
  return function restore() {
    SECRET_SCALARS.forEach(k => { if (k in orig) s[k] = orig[k]; });
    if (s.storageApi && typeof s.storageApi === 'object') { ['accessKey', 'secretKey'].forEach(k => { const o = 'sa.' + k; if (o in orig) s.storageApi[k] = orig[o]; }); }
    if ('push.webhook' in orig) s.push.webhook = orig['push.webhook'];
  };
}

/** 判断一个已解析对象是否是一份「可用的库」（含 users 数组 + 数字 nextId） */
function isUsableDb(o) {
  return !!o && typeof o === 'object' && Array.isArray(o.users) && typeof o.nextId === 'number';
}

/* ---- 落盘防抖 ----
 * 旧实现：每次 saveDb() 都同步整文件重写（JSON.stringify(db,null,2) + 原子写），
 *   高频操作（批量导入 / AI 追加 / 连续勾选待办）会瞬间放大成数十次全量写。
 * 新实现：saveDb() 仅安排一次 200ms 内的合并落盘；关键路径 / 进程退出 / 导出备份前
 *   用 flushSaveDb() 立即落盘，保证磁盘一致。
 * 取舍：引入「崩溃最多丢 200ms 写入」窗口，对个人单用户应用可接受；优雅退出与导出前均强制 flush。 */
const SAVE_DEBOUNCE_MS = 200;

let _saveTimer = null;

function writeDbNow() {
  const restore = encryptSettingsSecrets();
  /* 原子性由后端保证：
     - json：写临时文件 → fsync → rename（杜绝「半个 db.json」）
     - sqlite：单事务提交 + WAL（不会留下半份数据） */
  try { store.save(rt.db); }
  catch (e) { if (e && typeof e === 'object') e.isPersistError = true; throw e; }
  finally { restore(); }
}

/* 同步立即落盘：关键路径（转账/支付/登录态变更）、进程退出、导出/备份前必须保证落盘 */
function flushSaveDb() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  writeDbNow();
}

/* 防抖落盘：绝大多数 saveDb() 调用走这里，将窗口内的多次变更合并为一次磁盘写入 */
function saveDb() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; writeDbNow(); }, SAVE_DEBOUNCE_MS);
}

/* 只读一致性刷盘：SQLite 必须先把 WAL 合并回主库，之后复制 db.sqlite
   才是一份完整可恢复的数据；备份/导出在复制文件前都要调它。 */
function checkpointStorage() {
  try { store.flush(); } catch (e) { /* 尽力而为 */ }
}

/* 退出前把存储缓冲落盘并关闭句柄。加幂等标志是因为 shutdown() 会显式
   调用一次，process.on('exit') 还会兜底再调一次，重复 close 会抛错。 */
let _storageClosed = false;
function closeStorage() {
  if (_storageClosed) return;
  _storageClosed = true;
  try { store.flush(); store.close(); } catch (e) { /* 尽力而为 */ }
}

module.exports = {
  SAVE_DEBOUNCE_MS,
  SECRET_SCALARS,
  checkpointStorage,
  closeStorage,
  decryptSettingsSecrets,
  encryptSettingsSecrets,
  flushSaveDb,
  isUsableDb,
  masterKey,
  saveDb,
  skDec,
  skEnc,
  store,
  writeDbNow,
};
