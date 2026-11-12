/* ---------------- 运行时持有者 ----------------
 *
 * 为什么需要它：`server.js` 的 `db` 在运行期会被**整体替换**——
 *   1. loadDb() 的自愈路径（库损坏 → 用恢复出的对象顶上）
 *   2. 导入备份（handleApi 里的 ctx.replaceDb）
 * 谁在 require 时抓一次 `db`、之后缓存起来，替换后拿到的就是失效对象。
 * 典型症状：备份明明导入成功了，某模块却仍在读旧库，界面「看起来导入了却没生效」。
 *
 * `sessions` 在列的理由同源但方向相反：它是**被跨模块共享的可变状态**——
 * loadDb() 重置它（sessions.json 历史明文一律不读回）、auth 解析读写它、
 * 路由经 app 上下文增删它。loadDb 搬进 src/services/db-lifecycle.js 后，
 * 重置动作必须落到一个双方都够得着的地方，否则要么 db-lifecycle 反向
 * require server.js（arch:deps 直接红），要么把 sessions 劈成两半。
 *
 * 约束：
 *   - 只放**会被替换**的引用（db / sessions）或**跨模块共享的可变状态**。
 *     `apiApp` 只构造一次且无人替换，不进来，避免把 rt 变成全局垃圾桶。
 *   - 替换必须走 `setDb()`，不允许直接写 `rt.db`，否则漂移无从排查。
 *   - 不变量守护：tests/invariants.test.js 的「导入备份后模块必须读到新库」
 *     断言 rt.db 替换生效；sessions 的不变量由构造保证——server.js 与路由
 *     都不再持有本地副本，全部读 rt.sessions，不存在第二个可漂移的引用。
 *
 * 这个文件不依赖 server.js 的任何初始化顺序，可被任何模块直接 import。
 */
const rt = {
  db: null,

  /** 会话表：token -> {userId, username, expireAt}。重启即失效（不读回 sessions.json）。 */
  sessions: {},

  /** 唯一的 db 替换入口。调用后 rt.db 与所有读取方指向同一对象。 */
  setDb(v) {
    this.db = v;
    return v;
  }
};

module.exports = rt;
