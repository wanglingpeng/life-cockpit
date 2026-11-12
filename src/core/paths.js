/* ---------------- 路径与运行常量 ----------------
 *
 * 为什么单独一个文件：这些常量原本散在 server.js 顶部，抽 service 时
 * （src/services/db-io.js 要算 store 路径，src/services/backup.js 要算
 * 备份目录）两边都需要。复制一份就会出现「改了这边忘了那边」的漂移，
 * 而这种漂移的表现是「备份写到了别的目录」——不报错，只是数据没备份。
 *
 * 这里只放**不依赖运行时状态**的路径推导，全部在 require 时求值。
 */
const path = require('path');

/* 注意 ROOT 不能写 __dirname：本文件在 src/core/ 下，__dirname 会解析成
   src/core，DATA_DIR 就变成 src/core/data —— 服务会在错误位置建一个空库，
   而真实数据目录被晾在一边，症状是「数据全丢了但没有任何报错」。
   src/core → 项目根 是两级。 */
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const LOCK_FILE = path.join(DATA_DIR, '.instance-lock');
const STORAGE_KEY_FILE = path.join(DATA_DIR, '.storage-key');
const BACKUP_ROOT = path.join(DATA_DIR, 'backup');
const BACKUP_AUTO_ROOT = path.join(BACKUP_ROOT, 'auto');

/* 存储后端选择。默认 json（与既有用户数据格式一致），LC_STORAGE=sqlite 或
   启动参数 --sqlite 可切。两个后端实现同一接口（src/storage/index.js）。 */
const STORAGE_KIND = String(
  process.env.LC_STORAGE || (process.argv.includes('--sqlite') ? 'sqlite' : 'json')
).toLowerCase() === 'sqlite' ? 'sqlite' : 'json';

const STORAGE_FILE = STORAGE_KIND === 'sqlite'
  ? path.join(DATA_DIR, 'db.sqlite')
  : DB_FILE;

module.exports = {
  ROOT, PUBLIC_DIR, DATA_DIR, UPLOAD_DIR, DB_FILE, SESSION_FILE,
  LOCK_FILE, STORAGE_KEY_FILE, BACKUP_ROOT, BACKUP_AUTO_ROOT,
  STORAGE_KIND, STORAGE_FILE
};
