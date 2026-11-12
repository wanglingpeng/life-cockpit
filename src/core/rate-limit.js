/* 限流：登录失败退避 + 通用写接口计数。
 *
 * 为什么是一个模块而不是两个：两者是同一个关注点（按客户端 IP 维度保护
 * 服务），拆成两节散在 server.js 里时，「新增一类限流该放哪、窗口常量
 * 叫什么名」每次都要重新决定一遍；合起来则策略清单是一眼看得完的。
 * 为什么不进一步统一成「一个通用引擎 + 两份配置」：两种策略的语义本质
 * 不同——登录是指数退避锁（lockUntil，返回剩余等待秒数），写接口是滑动
 * 窗口计数（只判放行）。硬套一个引擎会让「登录锁定时长翻倍」和「写限额
 * 调整」互相成为对方的回归风险，而收益只是少写一个 Map。
 *
 * 内存态、重启失效（与 sessions 一致，个人单机可接受）：限流状态不进
 * 备份、不落盘，重启后攻击者与正常用户回到同一起点。
 *
 * 从 server.js 搬入（原「登录失败限流」+「通用写接口限流」两节，中间隔着
 * Cookie 策略等无关代码——同一关注点被物理隔离，读时要来回翻）。 */

/* ---------------- 登录失败限流（防暴力破解） ----------------
 * 维度：用户名 + 客户端 IP。窗口 15 分钟；连续失败满 5 次起指数退避
 * （第 6 次锁 1s、第 7 次 2s、第 8 次 4s…最长 15 分钟），登录成功即清零。
 * 起因：评审实测连续 12 次错误口令均 20–27ms 通过，无任何退避或锁定。 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FREE_FAILS = 5;
const LOGIN_MAX_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAP_CAP = 1000;                 // 内存上限：超限时清已出窗口的记录
const loginFails = new Map();               // key -> {count, firstAt, lockUntil}

/* P0-2：默认绝不信任 x-forwarded-for。自托管单机部署前面没有可信反向代理，
   客户端只要随手伪造一个 XFF 头就能每次换一个「IP」，登录爆破退避与写接口
   限流会同时失效。只有显式 TRUST_PROXY=1（确实在反代后面）才采信首段，
   并校验它看起来像 IP，避免任意字符串直接成为限流 key。 */
function clientIp(req) {
  const direct = (req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress) : 'unknown';
  if (process.env.TRUST_PROXY !== '1') return direct;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (/^[0-9a-fA-F:.]+$/.test(xff) && xff.length <= 45) ? xff : direct;
}

function loginThrottleKey(req, username) {
  return String(username || '-').toLowerCase() + '|' + clientIp(req);
}

/** 返回剩余锁定秒数；0 表示可以继续尝试 */
function loginThrottleWait(key) {
  const e = loginFails.get(key);
  if (!e) return 0;
  const now = Date.now();
  if (now - e.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(key); return 0; }
  return e.lockUntil > now ? Math.ceil((e.lockUntil - now) / 1000) : 0;
}

/** 记一次失败并按需加锁，返回 {count, waitS} */
function loginThrottleFail(key) {
  const now = Date.now();
  let e = loginFails.get(key);
  if (!e || now - e.firstAt > LOGIN_WINDOW_MS) e = { count: 0, firstAt: now, lockUntil: 0 };
  e.count++;
  if (e.count >= LOGIN_FREE_FAILS) {
    const step = e.count - LOGIN_FREE_FAILS;               // 0,1,2…
    e.lockUntil = now + Math.min(LOGIN_MAX_LOCK_MS, 1000 * Math.pow(2, step));
  }
  loginFails.set(key, e);
  if (loginFails.size > LOGIN_MAP_CAP) {
    for (const [k, v] of loginFails) if (now - v.firstAt > LOGIN_WINDOW_MS) loginFails.delete(k);
  }
  return { count: e.count, waitS: e.lockUntil > now ? Math.ceil((e.lockUntil - now) / 1000) : 0 };
}

/* ---------------- 通用写接口限流（F3 修复） ----------------
 * 维度：客户端 IP；窗口 1 分钟；上限 300 次写操作/分（个人/家庭用量远低于此）。
 * 覆盖 POST/PUT/DELETE/PATCH；登录接口仍由上面的指数退避独立管控——
 * 两套策略刻意不串门：登录限流按「用户名+IP」防的是单账号爆破，
 * 写限流按 IP 防的是批量刷写，key 维度不同，合并会让其中一种失去意义。 */
const WRITE_LIMIT_WINDOW_MS = 60 * 1000;
const WRITE_LIMIT_MAX = 300;
const WRITE_MAP_CAP = 2000;
const writeHits = new Map();                // ip -> {count, firstAt}

function writeThrottleAllow(ip) {
  const now = Date.now();
  let e = writeHits.get(ip);
  if (!e || now - e.firstAt > WRITE_LIMIT_WINDOW_MS) e = { count: 0, firstAt: now };
  e.count++;
  writeHits.set(ip, e);
  if (writeHits.size > WRITE_MAP_CAP) {
    for (const [k, v] of writeHits) if (now - v.firstAt > WRITE_LIMIT_WINDOW_MS) writeHits.delete(k);
  }
  return e.count <= WRITE_LIMIT_MAX;
}

module.exports = {
  clientIp,
  loginFails,
  loginThrottleFail,
  loginThrottleKey,
  loginThrottleWait,
  writeThrottleAllow,
};
