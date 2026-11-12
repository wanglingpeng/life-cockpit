/**
 * 加密原语模块（从 server.js 抽出，#4 拆分第二步）
 * 只包含无状态纯函数：哈希 / 口令 KDF / AES 加解密。
 * 依赖 db 与密钥文件路径的封装（masterKey / skEnc / skDec / settings 加解密）
 * 仍留在 server.js —— 它们需要访问 db.settings 与 data/.storage-key，不属于纯原语。
 */
const crypto = require('crypto');
const fs = require('fs');

/* ---------------- 哈希 ---------------- */
function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
/* 对 Buffer / 文件内容求 SHA-256（备份 manifest 校验用） */
function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(file) { return sha256Buf(fs.readFileSync(file)); }

/* 口令 KDF：PBKDF2-SHA256，迭代次数与保险库 vaultMaster 一致（600000）。
   2026-10 安全评审（F2）：120000 次已偏弱，按 OWASP 建议提升至 600000。
   存储格式自带迭代数 'pbkdf2:<iter>:<saltHex>:<hashHex>'，旧 120000 次哈希仍按串内 iter 正常校验，无需迁移。
   旧 64 位 hex（sha256(pwd+salt)）兼容校验并惰性升级 */
const KDF_ITER = 600000;
function hashPassword(pwd, salt) {
  const dk = crypto.pbkdf2Sync(String(pwd), String(salt), KDF_ITER, 32, 'sha256').toString('hex');
  return 'pbkdf2:' + KDF_ITER + ':' + salt + ':' + dk;
}
function verifyPassword(user, pwd) {
  const stored = String(user.passwordHash || '');
  if (stored.startsWith('pbkdf2:')) {
    const parts = stored.split(':');
    if (parts.length !== 4) return false;
    try {
      const dk = crypto.pbkdf2Sync(String(pwd), parts[2], +parts[1] || KDF_ITER, 32, 'sha256').toString('hex');
      return dk === parts[3];
    } catch (e) { return false; }
  }
  // 旧格式：sha256(pwd+salt)，64 位 hex
  if (/^[0-9a-f]{64}$/.test(stored)) return sha256(String(pwd) + user.salt) === stored;
  return false;
}

/* ---- 敏感加密 v2：AES-256-GCM（认证加密，F1 修复） ----
 * 原 AES-128-CBC 无完整性认证、密钥截取输入前 16 字节，已不达 2026 安全基线。
 * 新密钥：对任意 key 输入 SHA-256 派生固定 32 字节（同输入同输出，调用方无需改动）；
 * 新密文格式 'gcm:<ivHex>:<tagHex>:<dataHex>'：12 字节随机 IV + 认证 tag，篡改即解密失败。
 * 兼容：解密自动识别旧格式 'iv:data'（AES-128-CBC + 16 字节截断规则），老数据无感可读。 */
function legacyAesKeyBuf(key) { return Buffer.from(String(key), 'utf8').subarray(0, 16); }
function aesKeyBuf(key) { return crypto.createHash('sha256').update(String(key)).digest(); }
function aesEncrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKeyBuf(key), iv);
  const enc = Buffer.concat([c.update(Buffer.from(String(text), 'utf8')), c.final()]);
  return 'gcm:' + iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex');
}
function aesDecrypt(enc, key) {
  try {
    const s = String(enc);
    if (s.startsWith('gcm:')) {
      const parts = s.split(':');
      if (parts.length !== 4) return '';
      const d = crypto.createDecipheriv('aes-256-gcm', aesKeyBuf(key), Buffer.from(parts[1], 'hex'));
      d.setAuthTag(Buffer.from(parts[2], 'hex'));
      return Buffer.concat([d.update(Buffer.from(parts[3], 'hex')), d.final()]).toString('utf8');
    }
    /* 旧格式 v1（aes-128-cbc）：沿用 16 字节截断规则解密，老数据兼容 */
    const [ivHex, dataHex] = s.split(':');
    const d = crypto.createDecipheriv('aes-128-cbc', legacyAesKeyBuf(key), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}

module.exports = { KDF_ITER, sha256, sha256Buf, sha256File, hashPassword, verifyPassword, aesEncrypt, aesDecrypt };
