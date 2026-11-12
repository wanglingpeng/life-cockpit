# 运维与安全手册（Life Cockpit / 生活驾驶舱）

> 适用版本：**v1.48.54+**
> 本文件为交付物的运维速查。部署/使用请以本文件 + `README.md` 为准。

---

## 1. 本次安全修复速览（P0 级）

| 编号 | 问题 | 修复 |
|------|------|------|
| P0-1 | `applyQuickAdd` 因变量遮蔽静默吞掉失败项、且 `newId` 必抛 | 消除遮蔽、返回 `{created, failed}`、失败项如实上报 |
| P0-2 | 路由声明的 `auth/role:admin` 仅是元数据，提权链可绕过 | `handleApi` 统一消费 `route.auth/role`；微信默认关闭 MOCK；密码重置需 admin；`requirePwdChange` 受 admin 保护 |
| P0-3 | Service Worker 缓存私有路径、`/uploads` 附件与 `.bak` 可被匿名读取 | SW 仅缓存公开资源且跳过私有路径；静态服务限扩展名白名单；附件强制登录 + `private` 缓存 |
| P0-5 | 只有 08:00 晨报定时器，事务/周期事项的 `remindTime` 从不触发 | 新增 `startReminderScheduler` + `collectDueReminders` 纯函数，到点逐条推送 |
| P0-6 | SQLite 模式下「备份」永远只复制空的 db.json（假备份） | `runDailyBackup` 按存储类型复制 `db.sqlite`(+wal+shm) + JSON 快照并 checkpoint；导出同样带上 db.sqlite |
| P0-7 | `stop-service.bat` 用 `taskkill /f` 强杀，跳过 200ms 防抖丢失数据 | 统一优雅停服：`POST /__lc_shutdown`（loopback + 令牌）→ 落盘 → 关存储 → 退 75；脚本不再强杀 |

> P0-4（同属评审整改项）已随 P0-3 的静态/缓存策略一并处理。

---

## 2. 部署与启动

- **零运行时依赖**：Node.js ≥ 22 即可，`拷贝目录即运行`，无需 `npm install`。
- **首次启动**：会以 `admin / admin123` 生成初始管理员，并强制首次登录修改密码（可用 `SKIP_PWD_GUARD=1` 在自动化测试中临时关闭该守卫）。
- **启动方式**：
  - 生产：`start.bat`（内置「崩溃/异常自动重启」循环）。
  - 手动：`node server.js`（或 `node server.js --sqlite` 启用 SQLite 后端）。
  - 绑定地址默认 `127.0.0.1`；如需暴露到局域网，请置于反向代理（Nginx/Caddy）之后并设置 `HOST=0.0.0.0`，**不要直接裸奔公网**。

---

## 3. 优雅停服（重要，对应 P0-7）

> ⚠️ **切勿使用 `taskkill /f` 强杀**。强杀会跳过 200ms 防抖落盘窗口，丢失最近写入。

正确做法（任选其一）：

1. **推荐**：运行 `stop-service.bat`，它会读取 `data/.stop-token` 并向 `127.0.0.1:<PORT>/__lc_shutdown` 发送 `POST`（带 `X-LC-Stop-Token` 头），随后轮询端口释放。
2. **手动**：在服务窗口按 `Ctrl+C`（触发 `SIGINT`，同样走优雅落盘）。
3. **API**：`curl -X POST http://127.0.0.1:<PORT>/__lc_shutdown -H "X-LC-Stop-Token: <data/.stop-token 内容>"`。

停服流程顺序：`server.close()` → `flushSaveDb()`（清掉防抖窗口）→ `closeStorage()`（SQLite 关句柄）→ 释放实例锁与停服令牌 → `process.exit(75)`。
退出码 **75 = 优雅停服**，`start.bat` 据此**停止自动重启循环**（避免停服后被立刻拉起）。

---

## 4. 数据备份（对应 P0-6）

- **自动备份**：每日首次启动后约 20 秒 + 之后每 10 分钟触发一次，落到 `data/backup/auto/<YYYY-MM-DD>/`，含 `manifest.json`（逐文件 sha256 校验）与保留策略（日 7 + 周 4 + 月 6，硬上限 24 目录）。
- **SQLite 模式**：备份点**包含真实数据**——`db.sqlite` 及其 `-wal`/`-shm` 文件 + 一份可读 `db.json` 快照，并先做 WAL checkpoint。旧实现只复制 `db.json`（SQLite 下为空库）属于「假备份」，现已修复。
- **手动导出**：`GET /api/settings/export-full` 返回 zip，其中**包含 `db.sqlite`**（若启用 SQLite）。
- **异地备份**：在设置中配置 `remoteDir`，且**必须与数据不同盘**（同盘会被判为无效并给出人话说明）。

---

## 5. 存储后端

- 默认 **JSON**（`data/db.json`），零迁移成本，兼容既有用户数据。
- **SQLite**（Node 22 内置 `node:sqlite`，仍零外部依赖）：启动时 `LC_STORAGE=sqlite` 或加参数 `--sqlite`。
- **在线迁移**：`node scripts/migrate-storage.js --to=sqlite`（或 `--to=json`），复用统一存储接口，不碰业务逻辑。

---

## 6. 安全模型速查

- **管理员门禁**：所有 `auth:'admin'`/`role:'admin'` 路由统一由 `handleApi` 在分发前校验，普通用户一律 `403 仅管理员可执行此操作`。不要再靠各 handler 内 `isAdmin(req)` 自觉判断。
- **微信登录**：默认走真实 `code2session` 校验；仅当 `MOCK_WECHAT=1` 才回落到模拟（用于本地联调），**生产务必保持关闭**。
- **静态资源**：仅白名单扩展名可匿名访问（`.html/.css/.js/.png` 等）；`.bak/.json/.zip/.env` 等一律 `404`，杜绝源码/备份被顺带下载。
- **Service Worker**：仅对公开资源（`/css /js /icons /fonts /avatars`）做缓存优先；`/uploads /data /backup /backups /exports` 等私有路径直接放行到网络，不进缓存；响应头带 `Cache-Control: private/no-store` 的也不会被 SW 缓存。
- **限流 IP 信任**：默认只信 `socket.remoteAddress`；仅当 `TRUST_PROXY=1` 才采信 `X-Forwarded-For` 首段（并校验为合法 IP），避免前置代理下被伪造 IP 绕过限流。

---

## 7. 质量门禁（CI / 交付前自检）

```bash
npm test            # 回归测试（P0 修复的行为级 + 结构性断言），0 用例即失败
npm run check       # 全链路：测试 + 架构闸门（零外部依赖 / 鉴权护栏 / 路由清单 / schema 漂移）
npm run arch:deps   # 单独检查：是否引入了非 node: 内置的外部依赖（违反零依赖承诺）
npm run storage:migrate -- --to=sqlite   # 存储后端迁移
```

`scripts/` 下工具均为**零依赖、只读分析/运维**用途，不修改业务代码。

---

## 8. 排障

- **端口被占用（exit 78）**：已有实例在运行。先优雅停服旧实例，再启动；不要同机起多个实例（实例锁会拒绝）。
- **启动后无数据**：检查 `data/db.json` / `data/db.sqlite` 权限与磁盘空间；确认未被 `taskkill /f` 中断过写入。
- **推送不到**：确认 `push.webhook` 为官方机器人 **https** 地址（接口仅允许白名单主机）；到点提醒需 `itemReminders` 开启且任务 `remindTime` 命中当前分钟。
- **备份恢复**：用 `verifyBackupPoint` 校验备份点完整性与「可恢复性」（结构校验），再从该目录恢复。
