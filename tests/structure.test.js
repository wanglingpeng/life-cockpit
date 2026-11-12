/* P0 结构性回归（读取源码断言关键安全修复已落地，避免“改坏了都不知道”）。
 * 这些检查不依赖运行时，毫秒级，作为质量门禁的静态护栏。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('P0-2 服务端存在统一管理员门禁（router 的 auth/role 不再只是元数据）', () => {
  const s = read('server.js');
  assert.ok(/route\.auth\s*===\s*'admin'\s*\|\|\s*route\.role\s*===\s*'admin'/.test(s),
    'handleApi 必须消费 route.auth/role 做统一校验');
  assert.ok(/仅管理员可执行此操作/.test(s), '拒绝信息存在');
});

test('P0-2 密码重置接口为管理员专属且经 hashPassword', () => {
  const s = read('src/modules/auth.routes.js');
  assert.ok(/hashPassword/.test(s), '重置用 hashPassword 落库');
  assert.ok(/role:\s*'admin'/.test(s), '重置接口声明 admin');
});

test('P0-3 静态服务仅放行白名单扩展名，.bak/.json 等不可匿名下载', () => {
  const s = read('server.js');
  assert.ok(/STATIC_EXT_OK/.test(s), '存在扩展名白名单');
  const m = s.match(/const STATIC_EXT_OK = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '白名单集合可解析');
  assert.ok(!/\.bak/.test(m[1]), '.bak 不在白名单');
  assert.ok(!/\.json/.test(m[1]), '.json 不在白名单');
});

test('P0-3 Service Worker 不缓存私有路径（uploads/data/backup）', () => {
  const s = read('public/sw.js');
  assert.ok(/PRIVATE_PATH_RE/.test(s), '存在私有路径正则');
  assert.ok(/cacheable/.test(s), '存在缓存可性判定');
  assert.ok(/\/uploads/.test(s), 'uploads 被判为私有');
});

test('P0-6 SQLite 备份复制真实数据文件 + checkpoint，而非只复制 db.json', () => {
  const s = read('src/services/backup.js');
  assert.ok(/STORAGE_KIND\s*===\s*'sqlite'/.test(s), '按存储类型分支');
  assert.ok(/checkpointStorage\(\)/.test(s), '复制前 WAL checkpoint');
  assert.ok(/for \(const suffix of \['', '-wal', '-shm'\]\)/.test(s), '复制 db.sqlite(+wal+shm)');
});

test('P0-7 优雅停服：loopback+令牌端点、统一 shutdown、退出码 75', () => {
  const s = read('server.js');
  assert.ok(/\/__lc_shutdown/.test(s), '停服端点存在');
  assert.ok(/x-lc-stop-token/.test(s), '令牌头校验');
  assert.ok(/process\.exit\(75\)/.test(s), '退出码 75');
  assert.ok(/releaseInstanceLock\(\)/.test(s), '释放实例锁');
  assert.ok(/flushSaveDb\(\)/.test(s), '停服前落盘');
  assert.ok(/const isLocal = ip === '127\.0\.0\.1' \|\| ip === '::1' \|\| ip === '::ffff:127\.0\.0\.1'/.test(s),
    '停服端点限定 loopback（127.0.0.1 / ::1 / ::ffff:127.0.0.1）');
});

test('P0-7 停服脚本领走 POST /__lc_shutdown，不再 taskkill /f', () => {
  const s = read('stop-service.bat');
  assert.ok(/__lc_shutdown/.test(s), '脚本调用停服端点');
  assert.ok(!/taskkill \/f/.test(s), '不得强杀');
});
