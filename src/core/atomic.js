'use strict';
/* 原子写：写临时文件 → fsync → rename。
 *
 * 从 server.js 原样抽出（行为零变化），因为存储后端（JSON / SQLite 导入导出）都要用
 * 同一份实现，而它们不能反向依赖 server.js。
 *
 * 为什么必须原子：直接写到目标文件，若中途崩溃/断电/磁盘满，会留下"半个 db.json"，
 * 下次启动解析失败就是一次数据事故。rename 在同一文件系统内是原子的。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicWriteSync(file, data, mode) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const dir = path.dirname(file);
  /* 临时名以 .tmp 结尾且带 pid+随机串：既便于清理识别，又避免多进程撞名。
     测试断言「data/ 下无 *.tmp 遗留」，因此正常路径必须在 finally 前 rename 掉或删除。 */
  const tmp = path.join(dir, path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let fd = -1;
  try {
    fd = fs.openSync(tmp, 'w', mode || 0o600);
    /* 单次 write 可能只写一部分，必须循环直到 buf 全部落盘 */
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    /* fsync：确保内核缓冲写入磁盘。个别文件系统/虚拟盘不支持，失败不应导致保存失败 */
    try { fs.fsyncSync(fd); } catch (e) { /* 忽略：部分文件系统不支持 fsync */ }
    fs.closeSync(fd); fd = -1;
    fs.renameSync(tmp, file);
  } catch (e) {
    /* 任何异常都要保证 fd 关闭并清理残留 tmp，避免句柄泄漏与垃圾文件 */
    try { if (fd >= 0) fs.closeSync(fd); } catch (e2) { /* 忽略 */ }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    throw e;
  }
}

module.exports = { atomicWriteSync };
