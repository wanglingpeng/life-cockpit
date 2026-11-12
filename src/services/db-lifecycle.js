/* 库生命周期：单实例锁、加载/自愈、结构迁移。data/db.json 这个文件的一生。
 *
 * 三个环节不可分的理由：
 *   锁（acquireInstanceLock）→ 触库（loadDb）→ 迁移（migrateDb）是同一条
 *   因果链上的三步。先取锁再触库，是因为 loadDb 首次运行会写 db.json，
 *   若另一实例存活，必须在它写入前退出——两个进程共用同一 data/ 会
 *   「各自整读→各自整写」互相覆盖，最后写赢、先写的静默丢失。自愈
 *   （recoverFromCorruption）只可能在触库时发生，迁移只可能在库就位后
 *   发生。拆成三个模块就会出现「有人绕过锁直接 loadDb」或「迁移跑了
 *   自善后的半成品库」——各自符合自己的假设，合起来丢数据。
 *
 * dbRecovered 是本模块内部状态（置位于自愈、读位于 loadDb 末尾），
 *   按 internal 不导出：导出去就是一份永远为 false 的快照。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）：导入备份会
 * 整体替换 db，缓存快照会让迁移读到旧库。
 *
 * 从 server.js 抽出（原「F7：库结构版本 + 单实例锁」区，server.js 最后
 * 一个成建制领域）。前置两步已先行落地：sessions 收进 rt、server.js 不再
 * 持有本地 db——否则 loadDb 搬来这里后只能调 rt.setDb，与 server.js 的
 * 本地副本立刻漂移。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteSync } = require('../core/atomic');
const { DATA_DIR, UPLOAD_DIR, DB_FILE, SESSION_FILE, LOCK_FILE, BACKUP_ROOT, BACKUP_AUTO_ROOT } = require('../core/paths');
const rt = require('../core/runtime');
const { store, saveDb, isUsableDb, decryptSettingsSecrets } = require('./db-io');
const { fileStamp, nowStr, parseRegion } = require('./utils');
const { sha256 } = require('../../lib/crypto.js');
const { AI_PROVIDERS } = require('./ai');

let dbRecovered = false;

/* ---------------- F7：库结构版本 + 单实例锁 ----------------
 * schemaVersion：库结构版本锚点（当前 1）。未来破坏性结构变更时在 migrateDb 里按版本阶梯迁移；
 *   旧库/导入库缺字段 → migrateDb 幂等回填，语义不变。
 * 单实例锁：两个进程共用同一 data/ 会「各自整读→各自整写」互相覆盖 db.json（最后写赢，先写的静默丢失）。
 *   data/.instance-lock 记录持锁 PID；启动发现持锁进程仍存活且确为本服务 → 拒绝启动保护数据。
 *   陈旧锁判定（防误杀）：PID 不合法 / PID==自己（持号者已死，号被我们复用）/ PID 已死 /
 *   Linux 容器下 /proc/<pid>/cmdline 不含 server.js（容器 PID 空间小、复用频繁，必须精确确认）。
 *   锁写入失败（如只读文件系统）不阻断启动，仅告警。 */
const DB_SCHEMA_VERSION = 1;

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); } // EPERM=进程存在但无权限，视为存活
}

function lockPidIsOurServer(pid) {
  /* Linux/Docker：读 /proc/<pid>/cmdline 精确确认是本服务进程（容器 PID 复用高发，仅存活判断会误杀） */
  try {
    const cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    return cmdline.indexOf('server.js') !== -1;
  } catch (e) { /* 非 Linux 或进程已不存在 */ }
  /* Windows/macOS：本机桌面场景 PID 复用概率极低，存活判断即可 */
  return pidAlive(pid);
}

function acquireInstanceLock() {
  let held = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
      let pid = NaN;
      try { pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8') || '').trim()); } catch (e) { /* 内容损坏视为陈旧 */ }
      const stale = !Number.isFinite(pid) || pid <= 0 || pid === process.pid || !lockPidIsOurServer(pid);
      if (!stale) {
        console.error('[实例锁] ⚠️ 检测到另一实例正在运行（PID ' + pid + '）。两个进程共用同一 data/ 会互相覆盖 db.json 造成数据丢失，为保护数据本次启动已退出。');
        console.error('[实例锁] 若确认另一实例已关闭仍见此提示，可删除 data/.instance-lock 后重试。');
        /* 退出码 78（EX_CONFIG 惯例）：供 start.bat 识别「实例锁拒绝」——
           带自动重启的启动器遇此码必须停机，否则会陷入「拉起→被锁拒绝」无限循环刷日志 */
        process.exit(78);
      }
      /* 陈旧锁：直接覆盖 */
    }
    atomicWriteSync(LOCK_FILE, String(process.pid), 0o600);
    held = true;
  } catch (e) {
    console.error('[实例锁] ⚠️ 实例锁写入失败（' + (e && e.message ? e.message : e) + '），将继续启动；请勿让多个实例共用 data/ 目录。');
  }
  if (!held) return;
  /* P0-7：这里只保留 exit 兜底删锁。SIGINT/SIGTERM 的统一关闭流程由
     server.js 的 shutdown() 负责（先 server.close() 等在途请求跑完 →
     flushSaveDb() → closeStorage() → 删锁）。旧实现在此另注册一组信号
     钩子并直接 process.exit(0)，因为注册在先会抢先终止进程，server.js
     那半套清理根本没机会执行，200ms 防抖窗口里的写入就确定性丢失。 */
  process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 已被清理 */ } });
}

/** 供 server.js 优雅停服流程显式释放实例锁（exit 钩子仍作兜底） */
function releaseInstanceLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 已被清理 */ }
}

function defaultDb() {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    schemaVersion: DB_SCHEMA_VERSION,
    nextId: 1000,
    users: [{ id: 1, username: 'admin', salt, passwordHash: sha256('admin123' + salt), role: 'admin', themeColor: 'green' }],
    statuses: [
      { id: 1, name: '待处理', color: '#f59e0b' },
      { id: 2, name: '进行中', color: '#3b82f6' },
      { id: 3, name: '已完成', color: '#10b981' }
    ],
    tasks: [],            // {id,title,date,remindTime,statusId,color,pinned,remark,client,nextAction,createdAt}
                          // client=项目/客户(≤40，工作判定优先真值来源) nextAction=下一步动作(≤80)
    notes: [],            // {id,title,content,format,pinned,createdAt,updatedAt}
    anniversaries: [],    // {id,title,date,type:'count-up'|'count-down',repeat:'yearly'|'once',lunar:bool,color,remark,memberId} lunar=true 时 date 的月日按农历换算
    // 周期调度引擎：ruleType=daily|weekly|monthly|yearly|interval
    // interval 模式：intervalValue + intervalUnit(day|week|month|year)，基准为 lastDoneAt（无则 startDate/创建日）
    scheduledTasks: [],   // {id,name,ruleType,ruleValue,remindTime,enabled,lastRun,nextRun,category,lastDoneAt,intervalValue,intervalUnit,doneCount,startDate,remark}
    giftPersons: [],      // {id,name,groupId,remark,memberId}
    giftGroups: [],       // {id,name}
    giftRecords: [],      // {id,personId,relation,eventType,direction:'in'|'out',amount,date,remark,memberId}
    giftConfigs: [],      // {id,type:'EVENT_TYPE'|'RELATION_TYPE',label}
    expiryCategories: [], // {id,name,color}
    // 家庭档案库（原效期管理）：新增 位置 / 保修到期 / 编号 / 附件
    expiryItems: [],      // {id,name,categoryId,qty,expiryDate,location,warrantyUntil,serialNo,attachments:[],memberId,remindLeadDays,remark} remindLeadDays=条目级提前提醒天数(null=用全局)
    // 保险库扩展：支持证件号 / 保单号 / 会员卡号（敏感值走 AES）
    vaultEntries: [],     // {id,title,kind,username,passwordEnc,secretEnc,holder,expireDate,memberId,url,remark}
    vaultMaster: null,    // {hash,salt,encKey}
    // 家人档案
    familyMembers: [],    // {id,name,relation,emoji,color,birthday,phone,remark,createdAt}
    // 家庭账本
    ledgerCategories: [], // {id,name,icon,kind:'expense'|'income',parentId(一级为 null),sort,archived,builtin}
    ledgerBooks: [],      // 场景账本 {id,name,icon,color,kind,memberIds,archived,sort,builtin}
    // 月度预算（迭代 3）：{id,month:'YYYY-MM',categoryId(null=总预算),amount,createdAt}
    // 分类预算只挂一级支出分类；spent 永远实时推导，不落盘
    ledgerBudgets: [],
    // 账户实体（余额一律由流水实时推导，不落盘）
    ledgerAccounts: [],   // {id,name,type:'cash'|'debit'|'credit'|'ewallet'|'investment',initialBalance,includeInNetWorth,icon,color,remark,builtin}
    ledgerRecords: [],    // {id,date,kind:'expense'|'income'|'transfer',categoryId,amount,method,memberId,remark,source}
                          //   转账额外携带 toAccountId；所有记录可带 accountId（转账时 accountId=转出方）
    // 位置轨迹日记
    tracks: [],           // {id,title,date,startTime,endTime,mood,weather,memberIds:[],status:'doing'|'done',remark,createdAt,updatedAt}
    trackPoints: [],      // {id,trackId,lat,lng,name,address,province,city,district,time,source:'manual'|'auto',mood,weather,remark,photoIds:[]}
    uploads: [],          // {id,name,mime,size,file,createdAt,ownerType,ownerId}  图片实体文件存 data/uploads/
    footprints: [],       // 手动点亮的城市 {id,province,city,firstDate,remark,createdAt}
    fpDiary: [],          // 足迹随笔（心情寄语）{id,date,mood,text,photoIds:[],createdAt}
    // 照片数据（独立于轨迹）：扫描照片 EXIF GPS 得到的拍摄点位，单独一层显示在足迹地图上，
    // 不生成轨迹、不参与城市聚合与时间轴回放。thumb 为 96px JPEG dataURL（约 4-6KB），上限 2000 条。
    photoPoints: [],      // {id,lat,lng,name,time,thumb,createdAt}
    settings: { allowRegistration: false, themeColor: 'green', aiEndpoint: '', aiKey: '', mapKey: '', mapProvider: 'tencent', trackAutoInterval: 10, featTrack: true, telemetry: true, todayWorkFold: false },
    mortgages: [],        // {id,name,principal,annualRate,years,method:'equal-payment'|'equal-principal',startDate,createdAt}
    // 家底总览：资产清单（存款/理财/现金/其他，用于净资产核算）
    assets: [],           // {id,name,type:'deposit'|'fund'|'cash'|'other',amount,note,createdAt}
    otherDebts: [],       // 其他负债（信用卡/借款等）{id,name,amount,note,createdAt}
    // 健康档案：每位家庭成员一份 {memberId,chronic[],allergies[],medications[],checkups[],notes}
    // chronic:{name,note} medications:{name,dose,freq,remind} checkups:{name,nextDate,freqMonths}
    healthProfiles: [],
    // 埋点/使用洞察（本机运营数据，不进备份导出）：只统计「次数」与「平台」，不采集内容
    // activityStats: { byDate: { 'YYYY-MM-DD': { actions: {'key':count}, platforms:{mobile,desktop,tablet} } } }
    activityStats: { byDate: {} },
    // visitLog: { 'YYYY-MM-DD': true } 记录有访问行为的日期（供连续活跃/活跃率推导）
    visitLog: {}
  };
}

/** 尝试解析一个候选备份文件；成功且结构可用则返回对象，否则返回 null */
function tryReadUsableDb(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isUsableDb(o) ? o : null;
  } catch (e) { return null; }
}

/** 列出目录下匹配前缀的文件，按 mtime 倒序 */
function filesByMtimeDesc(dir, prefixRe) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => prefixRe.test(f))
      .map(f => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map(x => x.p);
  } catch (e) { return []; }
}

/**
 * 库损坏自愈：绝不静默清库。
 * 顺序：① 把损坏文件改名留证 ② 最新自动备份 → 迁移前备份 → db.backup-* ③ 全部失败才用空库。
 * 恢复成功后由 loadDb 末尾**立即原子写回** db.json（堵住「恢复仅存内存→未落盘即崩溃→
 * 重启发现 db.json 缺失→回退空库」的数据丢失窗口；证据文件 db.corrupt-* 不受影响）。
 * @param {Error} parseErr JSON 解析错误
 * @returns {object} 恢复出的库对象（或 defaultDb()）
 */
function recoverFromCorruption(parseErr) {
  /* ① 保留现场证据：损坏文件改名，绝不直接覆盖（否则数据不可逆丢失） */
  const corruptPath = path.join(DATA_DIR, 'db.corrupt-' + fileStamp() + '.json');
  try {
    fs.renameSync(DB_FILE, corruptPath);
    console.error('[数据库] ⚠️ db.json 解析失败，已保留损坏文件为证据：' + corruptPath + '（原因：' + (parseErr && parseErr.message) + '）');
  } catch (e) {
    console.error('[数据库] ⚠️ db.json 解析失败，且保留损坏文件副本失败：' + e.message);
  }
  /* ② 依次尝试恢复来源 */
  const candidates = [];
  /* 2a. 最新可用的每日自动备份（按日期目录倒序） */
  try {
    if (fs.existsSync(BACKUP_AUTO_ROOT)) {
      fs.readdirSync(BACKUP_AUTO_ROOT)
        .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
        .sort().reverse()
        .forEach(n => candidates.push(path.join(BACKUP_AUTO_ROOT, n, 'db.json')));
    }
  } catch (e) { /* 忽略 */ }
  /* 2b. 迁移前备份 db-before-* / db-pre-*（按 mtime 倒序） */
  filesByMtimeDesc(BACKUP_ROOT, /^db-(before|pre)-.*\.json$/).forEach(p => candidates.push(p));
  /* 2c. 根目录下 db.backup-*.json（历史手工备份惯例） */
  filesByMtimeDesc(DATA_DIR, /^db\.backup-.*\.json$/).forEach(p => candidates.push(p));

  for (const src of candidates) {
    const o = tryReadUsableDb(src);
    if (o) {
      dbRecovered = true;
      console.error('[数据库] ✅ 已从备份恢复：' + src + '（users=' + o.users.length + '，nextId=' + o.nextId + '）');
      return o;
    }
  }
  /* ③ 全部失败：醒目警告后用空库（不可逆，必须有人为介入） */
  console.error('[数据库] ❌❌ 所有备份来源均不可用，已回退为空库（原数据仅存于 ' + corruptPath + '，请人工抢救）');
  return defaultDb();
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!store.exists()) {
    /* 首次运行：库不存在 → 空库并落盘（保持原行为） */
    rt.setDb(defaultDb()); saveDb();
  } else {
    let parsed = null, parseErr = null;
    try { parsed = store.load(); }
    catch (e) { parseErr = e; }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.users)) {
      /* 合法库（users 为数组即可认；nextId 缺失则修复，无需清库） */
      rt.setDb(parsed);
      if (typeof rt.db.nextId !== 'number') rt.db.nextId = 1000;
    } else if (parsed && typeof parsed === 'object' && parseErr === null) {
      /* 能解析成对象但缺少关键字段（users 缺失）：走恢复，避免半残库直接把服务带偏 */
      rt.setDb(recoverFromCorruption(new Error('库结构不完整：缺少 users 数组')));
    } else {
      /* 解析失败：绝不静默清库，走自愈 */
      rt.setDb(recoverFromCorruption(parseErr));
    }
  }
  try {
    // 历史 sessions.json 里可能存着 token→session 明文映射：一律不读入，
    // 内存 sessions 以运行时登录为准（见 saveSessions 已改为只写元数据）。
    JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) { /* 文件不存在/损坏均忽略 */ }
  rt.sessions = {};
  migrateDb();
  decryptSettingsSecrets();
  /* 自愈来源：立即原子写回，堵住「恢复后未落盘即崩溃 → 重启回退空库」的数据丢失窗口。
     写入的是恢复出的完整库（saveDb 内部照常对敏感字段加密），不会破坏证据文件。 */
  if (dbRecovered) {
    try { saveDb(); console.error('[数据库] ✅ 已把恢复出的数据写回 ' + DB_FILE); }
    catch (e) { console.error('[数据库] ⚠️ 恢复数据写回失败：' + (e && e.message ? e.message : e)); }
  }
}

/* 旧库结构平滑升级：补齐新集合与新增字段，不破坏既有数据 */
function migrateDb() {
  let changed = false;
  /* F7：库结构版本号。旧库/导入库缺字段 → 回填当前版本（幂等，语义不变）。
     版本高于本程序支持的（来自更新版程序的备份）→ 醒目告警但不阻断（本应用结构演进按「加字段不破坏」设计）。 */
  if (rt.db.schemaVersion === undefined) { rt.db.schemaVersion = DB_SCHEMA_VERSION; changed = true; }
  else if (typeof rt.db.schemaVersion === 'number' && rt.db.schemaVersion > DB_SCHEMA_VERSION) {
    console.error('[数据库] ⚠️ 当前库结构版本 v' + rt.db.schemaVersion + ' 高于本程序支持的 v' + DB_SCHEMA_VERSION + '（可能来自更新版本的程序），继续使用可能有字段兼容风险。');
  }
  const arr = (k) => { if (!Array.isArray(rt.db[k])) { rt.db[k] = []; changed = true; } };
  /* giftConfigs 必须回填：它不在默认清单里的原因是「引入该集合时的现存库
     都跑过那一版、键已存在」，但自愈/导入拿到的备份可以是任意历史形状——
     缺这个键时 ensureGiftConfigs（启动序列紧随 loadDb 之后）读 .length
     直接 TypeError，服务起不来。同类还有 gifts 其余两个集合，一并在列：
     路由级缺键只是单接口 500，启动级缺键是整个服务起不来。 */
  ['familyMembers', 'ledgerCategories', 'ledgerBooks', 'ledgerBudgets', 'ledgerAccounts', 'ledgerRecords', 'scheduledTasks', 'expiryItems', 'vaultEntries', 'anniversaries', 'giftPersons',
   'giftGroups', 'giftRecords', 'giftConfigs', 'expiryCategories', 'statuses', 'tasks', 'notes', 'photoPoints',
   'tracks', 'trackPoints', 'uploads', 'footprints', 'fpDiary', 'aiChats', 'mortgages', 'assets', 'healthProfiles', 'otherDebts', 'networthSnapshots'].forEach(arr);
  /* G5 足迹点亮规则：默认 0 = 打卡即点亮（保持历史行为）；migrate 幂等回填 */
  if (!rt.db.settings.fpRule || typeof rt.db.settings.fpRule !== 'object') { rt.db.settings.fpRule = { minStayMinutes: 0 }; changed = true; }
  else if (typeof rt.db.settings.fpRule.minStayMinutes !== 'number') { rt.db.settings.fpRule.minStayMinutes = 0; changed = true; }
  if (!rt.db.aiProviders || typeof rt.db.aiProviders !== 'object') { rt.db.aiProviders = {}; changed = true; }
  if (!rt.db.settings.aiSecretKey) {
    rt.db.settings.aiSecretKey = crypto.randomBytes(16).toString('hex'); changed = true;
    // 密钥换了，旧加密 Key 全部作废（避免出现「显示已配置但永远解不开」的僵尸配置）
    Object.keys(rt.db.aiProviders).forEach(pid => { if (rt.db.aiProviders[pid] && rt.db.aiProviders[pid].apiKeyEnc) { delete rt.db.aiProviders[pid].apiKeyEnc; rt.db.aiProviders[pid].enabled = false; } });
    // v48：新结构连接同样作废，防「有 Key 显示但永远解不开」的僵尸连接
    if (Array.isArray(rt.db.aiConnections)) {
      rt.db.aiConnections.forEach(c => { delete c.apiKeyEnc; });
      if (rt.db.aiSettings && typeof rt.db.aiSettings === 'object') rt.db.aiSettings.defaultId = null;
    }
  }
  /* v48 AI 配置改版：多连接 db.aiConnections + 全局设置 db.aiSettings。
     仅在 aiConnections 不是数组时迁移一次（幂等）；旧 aiProviders 原样保留（一键回退用），新代码不再读它。 */
  if (!Array.isArray(rt.db.aiConnections)) {
    const PID_ORDER = ['deepseek', 'qwen', 'doubao'];
    const srcStore = (rt.db.aiProviders && typeof rt.db.aiProviders === 'object') ? rt.db.aiProviders : {};
    const conns = []; let enabledId = null;
    Object.keys(srcStore).sort((a, b) => {
      const ia = PID_ORDER.indexOf(a), ib = PID_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).forEach(pid => {
      const c = srcStore[pid];
      if (!c || !c.apiKeyEnc) return;            // 仅迁移已配 Key 的条目（密文原样搬，密钥体系不变）
      const meta = AI_PROVIDERS[pid] || {};
      conns.push({
        id: rt.db.nextId++, label: meta.label || pid,
        baseUrl: c.baseUrl || meta.baseUrl || '',
        apiKeyEnc: c.apiKeyEnc,
        textModel: c.model || meta.model || '', visionModel: '',
        createdAt: nowStr()
      });
      if (c.enabled && enabledId === null) enabledId = conns[conns.length - 1].id;
    });
    rt.db.aiConnections = conns;
    rt.db.aiSettings = {
      enabled: true,
      defaultId: enabledId !== null ? enabledId : (conns.length ? conns[0].id : null),
      timeoutSec: 120,
      scenes: { chat: '', insights: '', quickadd: '', receipt: '' }
    };
    changed = true;
  }
  // 家庭档案库字段
  rt.db.expiryItems.forEach(it => {
    if (it.location === undefined) { it.location = ''; changed = true; }
    if (it.warrantyUntil === undefined) { it.warrantyUntil = ''; changed = true; }
    if (it.serialNo === undefined) { it.serialNo = ''; changed = true; }
    if (!Array.isArray(it.attachments)) { it.attachments = []; changed = true; }
    if (it.memberId === undefined) { it.memberId = null; changed = true; }
  });
  // 纪念日 / 往来对象 → 家人关联
  rt.db.anniversaries.forEach(a => { if (a.memberId === undefined) { a.memberId = null; changed = true; } });
  rt.db.giftPersons.forEach(p => { if (p.memberId === undefined) { p.memberId = null; changed = true; } });
  // 周期调度引擎字段
  rt.db.scheduledTasks.forEach(t => {
    ['category', 'lastDoneAt', 'intervalUnit', 'startDate'].forEach(k => { if (t[k] === undefined) { t[k] = ''; changed = true; } });
    if (t.intervalValue === undefined) { t.intervalValue = 1; changed = true; }
    if (t.doneCount === undefined) { t.doneCount = 0; changed = true; }
    if (!t.category) { t.category = '其他'; changed = true; }
  });
  // 一次性事务 → 家人关联（P1-1：与周期事项/纪念日对齐，null = 全家人共用）
  rt.db.tasks.forEach(t => { if (t.memberId === undefined) { t.memberId = null; changed = true; } });
  // 保险库类型化
  rt.db.vaultEntries.forEach(e => {
    if (e.kind === undefined) { e.kind = 'password'; changed = true; }
    if (e.secretEnc === undefined) { e.secretEnc = ''; changed = true; }
    if (e.holder === undefined) { e.holder = ''; changed = true; }
    if (e.expireDate === undefined) { e.expireDate = ''; changed = true; }
    if (e.memberId === undefined) { e.memberId = null; changed = true; }
  });
  // 位置轨迹日记字段
  rt.db.tracks.forEach(t => {
    if (!Array.isArray(t.memberIds)) { t.memberIds = t.memberIds ? [t.memberIds] : []; changed = true; }
    ['mood', 'weather', 'startTime', 'endTime'].forEach(k => { if (t[k] === undefined) { t[k] = ''; changed = true; } });
    if (t.status === undefined) { t.status = 'done'; changed = true; }
  });
  rt.db.trackPoints.forEach(p => {
    if (!Array.isArray(p.photoIds)) { p.photoIds = []; changed = true; }
    ['mood', 'weather', 'address', 'remark', 'name', 'province', 'city', 'district'].forEach(k => { if (p[k] === undefined) { p[k] = ''; changed = true; } });
    if (p.source === undefined) { p.source = 'manual'; changed = true; }
    // 老数据自动补一次地域识别（幂等，仅名称匹配）
    if (!p.city && (p.address || p.name)) {
      const r = parseRegion(p.address, p.name);
      if (r.city || r.province) { p.province = r.province; p.city = r.city; changed = true; }
    }
  });
  // 手动点亮的城市
  rt.db.footprints.forEach(f => {
    ['province', 'city', 'firstDate', 'remark'].forEach(k => { if (f[k] === undefined) { f[k] = ''; changed = true; } });
  });
  // 设置项：腾讯地图 Key / 自动记录间隔 / 轨迹功能开关
  if (!rt.db.settings) { rt.db.settings = {}; changed = true; }
  if (rt.db.settings.mapKey === undefined) { rt.db.settings.mapKey = ''; changed = true; }
  if (!rt.db.settings.mapProvider) { rt.db.settings.mapProvider = 'tencent'; changed = true; }
  if (rt.db.settings.trackAutoInterval === undefined) { rt.db.settings.trackAutoInterval = 10; changed = true; }
  if (rt.db.settings.featTrack === undefined) { rt.db.settings.featTrack = true; changed = true; }
  /* 埋点开关：老库补默认值（开启）。埋点数据集合也一并补齐，避免读写时 undefined */
  if (rt.db.settings.telemetry === undefined) { rt.db.settings.telemetry = true; changed = true; }
  if (!rt.db.activityStats || typeof rt.db.activityStats !== 'object' || !rt.db.activityStats.byDate) { rt.db.activityStats = { byDate: {} }; changed = true; }
  if (!rt.db.visitLog || typeof rt.db.visitLog !== 'object' || Array.isArray(rt.db.visitLog)) { rt.db.visitLog = {}; changed = true; }
  if (!rt.db.settings.mapTileCfg) {
    rt.db.settings.mapTileCfg = {
      preset: 'amap-road',
      urlTemplate: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      subs: '1234'
    };
    changed = true;
  }
  // 照片数据：独立点位数组 + 地图显示配置（默认黄色、默认显示，对齐参考交互）
  if (!Array.isArray(rt.db.photoPoints)) { rt.db.photoPoints = []; changed = true; }
  if (!rt.db.settings.footprintPhotoCfg || typeof rt.db.settings.footprintPhotoCfg !== 'object') {
    rt.db.settings.footprintPhotoCfg = { visible: true, color: '#eab308' };
    changed = true;
  }
  // 消息推送（企业微信/飞书/钉钉机器人）
  if (!rt.db.settings.push || typeof rt.db.settings.push !== 'object') {
    rt.db.settings.push = {
      enabled: false, webhook: '', channel: 'wecom', dailyReport: true,
      dailyTime: '08:00', leadDays: 3, lastSentDate: '', lastResult: ''
    };
    changed = true;
  } else {
    const pd = { enabled: false, webhook: '', channel: 'wecom', dailyReport: true, dailyTime: '08:00', leadDays: 3, lastSentDate: '', lastResult: '' };
    Object.keys(pd).forEach(k => { if (rt.db.settings.push[k] === undefined) { rt.db.settings.push[k] = pd[k]; changed = true; } });
  }
  /* 数据备份（完整还原点）配置：默认开启；remoteDir 为「异地目录」绝对路径 */
  if (!rt.db.settings.backup || typeof rt.db.settings.backup !== 'object') {
    rt.db.settings.backup = {
      enabled: true, remoteDir: '', keepDays: 7, keepWeeks: 4, keepMonths: 6, maxDirs: 24,
      lastRunDate: '', lastResult: '', lastDir: '', lastSha: ''
    };
    changed = true;
  }
  /* 安全收口：全站强制修改初始密码（默认开启，可在系统设置里关闭） */
  if (rt.db.settings.requirePwdChange === undefined) { rt.db.settings.requirePwdChange = true; changed = true; }
  /* v43 工作事务扶正：假期/周末工作事项折叠偏好（用户可控，默认不折叠）。老库补默认值 */
  if (rt.db.settings.todayWorkFold === undefined) { rt.db.settings.todayWorkFold = false; changed = true; }
  /* 微信小程序推送配置（AppSecret/TemplateId 由管理员在设置页填写） */
  if (!rt.db.settings.wechat || typeof rt.db.settings.wechat !== 'object') {
    rt.db.settings.wechat = {
      appId: 'wx05d7341864ab60c2', appSecret: '', templateId: '',
      page: 'pages/dashboard/dashboard',
      tplFields: [
        { key: 'thing1', label: '提醒标题', value: '生活驾驶舱提醒' },
        { key: 'time2', label: '时间', value: '' }
      ]
    };
    changed = true;
  } else if (!Array.isArray(rt.db.settings.wechat.tplFields)) {
    if (rt.db.settings.wechat.tplData) {
      /* 兼容旧版 tplData 对象 → 可编辑的 tplFields 数组 */
      const td = rt.db.settings.wechat.tplData;
      rt.db.settings.wechat.tplFields = Object.keys(td).map(k => ({
        key: k, label: k, value: (td[k] && td[k].value !== undefined) ? td[k].value : ''
      }));
      delete rt.db.settings.wechat.tplData;
    } else {
      /* 已有 wechat 对象但从未配置过字段 → 补默认两条，避免配置界面空白 */
      rt.db.settings.wechat.tplFields = [
        { key: 'thing1', label: '提醒标题', value: '生活驾驶舱提醒' },
        { key: 'time2', label: '时间', value: '' }
      ];
    }
    changed = true;
  }
  /* 仍是出厂密码的账号 → 标记为「必须修改密码」 */
  rt.db.users.forEach(u => {
    if (u.mustChangePassword === undefined) {
      const isFactoryPwd = u.username === 'admin' && u.passwordHash === sha256('admin123' + u.salt);
      u.mustChangePassword = !!isFactoryPwd;
      changed = true;
    }
    if (u.createdAt === undefined) { u.createdAt = ''; changed = true; }
    if (u.wechatOpenid === undefined) { u.wechatOpenid = ''; changed = true; }
    if (u.wechatSubscribe === undefined) { u.wechatSubscribe = null; changed = true; }
  });
  if (changed) saveDb();
}

module.exports = {
  DB_SCHEMA_VERSION,
  acquireInstanceLock,
  defaultDb,
  filesByMtimeDesc,
  loadDb,
  lockPidIsOurServer,
  migrateDb,
  pidAlive,
  releaseInstanceLock,
  recoverFromCorruption,
  tryReadUsableDb,
};
