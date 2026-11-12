/* 纯工具层：日期/字符串/数字/格式化/地域/ZIP 签名。
 *
 * 这一层不依赖 db、state、sessions 等任何运行时状态，也不依赖 server.js 的
 * 初始化顺序——这是它被单独拆出来的原因：后续所有 service 都站在它上面，
 * 而它自己谁都不靠。判定标准是「同样的入参永远得到同样的出参」。
 *
 * 从 server.js 抽出。原位置分散在工具函数区、HTTP 区、S3 区、地域表区，
 * 由 scripts/split-service.py 按 scripts/dep-map.py 的依赖分层搬运。 */
const crypto = require('crypto');
const { lunar2solar } = require('../../lib/lunar.js');

/* ---------------- 工具函数 ---------------- */
/**
 * 原子写：写临时文件 → fsync 落盘 → rename 覆盖。
 * 避免断电/写中断留下半个 db.json：rename 在同一文件系统内是原子操作，
 * 因此读取方要么看到旧内容、要么看到新内容，绝不会读到半截文件。
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} data 写入内容
 * @param {number} [mode] 文件权限（默认 0600）
 */
/* 口令 KDF（KDF_ITER / hashPassword / verifyPassword）已抽到 lib/crypto.js */
function newToken() { return crypto.randomBytes(16).toString('hex'); }

function newId(db) { return db.nextId++; }

function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 无 AI 时的规则兜底：识别「花了/买了…+金额」直接记账，不降级成待办 */
function quickAddRuleFallback(text, today) {
  const s = String(text || '').trim();
  const m = s.match(/(?:花了|花费|支出|消费|用了|付了|买了|买菜花)\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|人民币|RMB|¥)?/)
          || s.match(/(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|人民币|RMB|¥)/);
  if (!m) return null;
  const amount = Math.round((+m[1]) * 100) / 100;
  if (!(amount > 0)) return null;
  const income = /收入|赚|收到|进账|工资|入账|到账|回收|收款/.test(s);
  const expense = /花|买|消费|支出|付款|买菜|吃饭|购物|加油|打车|外卖|交|缴|付/.test(s);
  if (income && !expense) return { type: 'ledger', kind: 'income', amount, date: today, remark: s.slice(0, 100), categoryName: '' };
  if (!expense) return null;
  const CAT = [['菜|食材|饭|餐|外卖|零食|饮料', '餐饮'], ['交通|打车|出租|加油|地铁|公交|停车', '交通'], ['衣服|服饰|鞋|裤', '服饰'], ['电费|水费|燃气|话费|网费|物业|房租|水电', '居住'], ['药|医院|挂号|看病|体检', '医疗'], ['学费|书|课|培训', '教育'], ['红包|人情|份子|随礼', '人情'], ['电影|游戏|KTV|旅游|健身', '娱乐']];
  let categoryName = '';
  for (const [kw, name] of CAT) if (new RegExp(kw).test(s)) { categoryName = name; break; }
  return { type: 'ledger', kind: 'expense', amount, date: today, remark: s.slice(0, 100), categoryName };
}

/** 校验 YYYY-MM-DD 是否是真日历日（防 2026-13-99 / 2026-02-30 等非法日期入库） */
function validDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

/** 金额必须是大于 0 的有限数字（拒绝负数 / NaN / 非数字串，防静默翻转污染账本） */
function validAmount(v) {
  const n = Number(v);
  return typeof v === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * 按 Unicode 码点截断字符串，避免把代理对（emoji 等星平面字符）切半产生孤立代理。
 * 语义取舍：预算按 UTF-16 code unit 计（沿用历史 .slice(0,n) 的产出长度契约），
 * 逐个码点累加其 code unit 长度，超出预算即停止。这样同时满足：
 *   - 不切半：绝不产出 D800-DFFF 的孤立代理；
 *   - length <= n：结果 String.length（code unit）不超过 n（与旧断言 client.length===40 兼容）；
 *   - BMP 字符（中文/ASCII）1 码点=1 code unit，纯 BMP 输入的 length 仍恰为 n。
 * 副作用：若第 n 个 code unit 恰好落在某 emoji 的中间，则该 emoji 整体舍弃，结果可能少 n-1 个 code unit。
 */
function safeSlice(s, n) {
  s = String(s == null ? '' : s);
  if (n <= 0) return '';
  if (s.length <= n) return s;                       // 快路径：本就未超预算，原样返回
  let out = '', used = 0;
  for (const ch of s) {                              // for...of 按码点迭代，天然不切半
    const len = ch.length;                           // BMP=1，星平面（emoji）=2
    if (used + len > n) break;
    out += ch; used += len;
  }
  return out;
}

/**
 * 用户输入 → 字符串（缺陷 C）：只接受 string 原样、number 字符串化；
 * 其余类型（对象 / 数组 / 布尔 / null / undefined）一律视为空串，避免 '[object Object]'、'true' 等脏值入库。
 */
function toText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function nowStr() {
  const d = new Date();
  return todayStr(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}

/* YYYYMMDD-HHmmss 时间戳（损坏库留证、备份目录改名等场景） */
function fileStamp(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/* ---- 敏感加密 v2：AES-256-GCM（认证加密，F1 修复） ----
 * 原 AES-128-CBC 无完整性认证、密钥截取输入前 16 字节，已不达 2026 安全基线。
 * 新密钥：对任意 key 输入 SHA-256 派生固定 32 字节（同输入同输出，调用方无需改动）；
 * 新密文格式 'gcm:<ivHex>:<tagHex>:<dataHex>'：12 字节随机 IV + 认证 tag，篡改即解密失败。
 * 兼容：解密自动识别旧格式 'iv:data'（AES-128-CBC + 16 字节截断规则），老数据无感可读。 */
/* AES 加解密（legacyAesKeyBuf / aesKeyBuf / aesEncrypt / aesDecrypt）已抽到 lib/crypto.js */

/* ---------------- R13：settings 敏感密钥加密存储 ----------------
   现状：appSecret / subscribeToken / mapKey / aiKey / aiSecretKey / storageApi(accessKey,secretKey) / push.webhook
   在 db.json 里明文落盘，仅在接口导出时脱敏。这里改为：库内密文、内存明文——
   引入独立存储密钥 data/.storage-key 作锚点，loadDb 解密、saveDb 加密，所有既有调用点读到的仍是明文。
   ⚠ 备份 data/ 时必须连同 .storage-key 一起，否则密文密钥无法解密（服务会以密文比对而失效）。 */

/* ---------------- 富文本净化（白名单）----------------
 * 笔记正文以 HTML 存储并由前端 innerHTML 渲染，必须服务端兜底净化，
 * 否则任何能写笔记的人都能塞 <script>/onerror 拿登录态。
 * 策略：只保留白名单标签，丢弃全部事件属性与危险协议。 */
const RICH_TAGS = new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'A', 'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);

const RICH_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height'], TD: ['colspan'], TH: ['colspan'] };

// 这些标签连同内容一起丢弃
const RICH_DROP = /<(script|style|iframe|object|embed|link|meta|svg|math|form|input|button|textarea|select)\b[\s\S]*?(<\/\1\s*>|$)/gi;

function sanitizeRichHtml(input) {
  let html = String(input == null ? '' : input);
  if (html.length > 400000) html = html.slice(0, 400000);
  html = html.replace(/<!--[\s\S]*?-->/g, '');          // 注释
  html = html.replace(RICH_DROP, '');                   // 危险标签（含内容）
  // 白名单过滤：用 openCount 追踪未闭合的开标签，避免丢弃开标签后残留孤立 </a> 之类
  const openCount = Object.create(null);
  const VOID_TAGS = new Set(['BR', 'HR', 'IMG']);
  html = html.replace(/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (full, tag, attrStr) => {
    const T = String(tag).toUpperCase();
    if (!RICH_TAGS.has(T)) return '';                   // 非白名单标签只去标签、留文字
    if (full.startsWith('</')) {
      if (!openCount[T]) return '';                     // 没有对应开标签 → 丢弃孤立闭合标签
      openCount[T]--;
      return '</' + T.toLowerCase() + '>';
    }
    const allow = RICH_ATTRS[T];
    if (!allow || !attrStr) {
      if (!VOID_TAGS.has(T)) openCount[T] = (openCount[T] || 0) + 1;
      return '<' + T.toLowerCase() + '>';
    }
    let out = '';
    allow.forEach(name => {
      const re = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
      const m = attrStr.match(re);
      if (!m) return;
      let val = (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]) || '');
      val = val.replace(/[\u0000-\u001f]/g, '').trim();
      if (name === 'href' || name === 'src') {
        // 只允许 http(s) 与站内相对路径
        if (!/^(https?:\/\/|\/)/i.test(val)) return;
        if (/^(javascript|data|vbscript):/i.test(val)) return;
        val = val.replace(/"/g, '%22');
      }
      if (name === 'colspan') { const n = parseInt(val, 10); if (!(n >= 1 && n <= 20)) return; val = String(n); }
      if (name === 'width' || name === 'height') { const n = parseFloat(val); if (!(n > 0 && n <= 4000)) return; val = String(Math.round(n)); }
      out += ' ' + name + '="' + val.replace(/"/g, '&quot;') + '"';
    });
    if (T === 'A') {
      // 无合法链接 → 只去标签留文字（不计入 openCount，对应 </a> 会被判为孤立闭合标签一并丢弃）
      if (!/ href=/.test(out)) return '';
      out += ' target="_blank" rel="noopener noreferrer"';
    }
    if (T === 'IMG' && !/ src=/.test(out)) return '';   // 没有合法 src 的图片直接丢弃，避免残留破图
    if (!VOID_TAGS.has(T)) openCount[T] = (openCount[T] || 0) + 1;
    return '<' + T.toLowerCase() + out + '>';
  });
  return html.trim();
}

// HTML → 纯文本（用于列表摘要与关键词搜索）
function htmlToPlain(html) {
  return String(html == null ? '' : html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-4]|\/tr|\/blockquote|\/pre)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** 生日/纪念日的「下一次还有多少天」（每年循环） */
function daysToNextYearly(dateStr) {
  if (!dateStr) return null;
  const mmdd = dateStr.length > 5 ? dateStr.slice(5) : dateStr;
  const today = todayStr();
  const cur = new Date(today + 'T00:00:00');
  let next = new Date(cur.getFullYear() + '-' + mmdd + 'T00:00:00');
  if (isNaN(next.getTime())) return null;
  if (next < cur) next = new Date((cur.getFullYear() + 1) + '-' + mmdd + 'T00:00:00');
  return Math.round((next - cur) / 86400000);
}

/** 农历月日（MM-DD 形态取自 dateStr）的下一个公历周年还有多少天；复用头部 lunar2solar（1900-2100 表），闰月生日按平月算 */
function daysToNextYearlyLunar(dateStr) {
  if (!dateStr) return null;
  const mm = +dateStr.slice(5, 7), dd = +dateStr.slice(8, 10);
  if (!mm || mm > 12 || !dd || dd > 30) return null;
  const today = new Date(todayStr() + 'T00:00:00');
  for (let y = today.getFullYear(); y <= today.getFullYear() + 1; y++) {
    if (y < 1900 || y > 2100) continue;
    const solar = lunar2solar(y, mm, dd);
    const diff = Math.round((new Date(solar + 'T00:00:00') - today) / 86400000);
    if (diff >= 0) return diff;
  }
  return null;
}

/** 统一到期引擎（底座·第 2 条）：把散落各模块的到期逻辑收成一套
 *  daysUntil —— 任意日期到今天的自然日差（null=无日期/非法）
 *  dueState  —— 统一多级状态：soon(临期)/due(今天到期)/overdue(逾期)/ok(正常)，leadDays 统一可配
 *  mortgageNextPayment —— 贷款下次还款日（每月 startDate 的日期，超年限视为还清返回 null） */
function daysUntil(dateStr) {
  if (!dateStr || !validDateStr(String(dateStr))) return null;
  return Math.round((new Date(dateStr + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
}

/** 月供金额（元）：principal 单位万元→×10000；等额本息用年金公式，等额本金取首月月供 */
function mortgageMonthlyPayment(m) {
  if (!m) return 0;
  const P = (+m.principal || 0) * 10000;
  if (P <= 0) return 0;
  const r = (+m.annualRate || 0) / 100 / 12;
  const n = Math.max(1, (+m.years || 0) * 12);
  if (m.method === 'equal-principal') return P / n + P * r;
  return r > 0 ? P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1) : P / n;
}

/* ==================== 埋点 / 使用洞察 ====================
 * 只做「次数 + 平台」计数，不采集任何记录内容；settings.telemetry === false 时整体停用。
 * 落盘结构：
 *   db.activityStats.byDate['YYYY-MM-DD'] = { actions:{key:count}, platforms:{mobile,desktop,tablet} }
 *   db.visitLog['YYYY-MM-DD'] = true   —— 该日有访问行为（供活跃率/连续活跃推导）
 * 写入类动作（core）用于「北极星·本周有效写入」与每日序列的 count（浏览类只计 total）。
 */
const CORE_ACTIONS = new Set([
  'task.create', 'note.create', 'ledger.create', 'anniversary.create', 'scheduled.create', 'expiry.create'
]);

/** 从 'YYYY-MM-DD' 偏移 delta 天，返回日期串 */
function dateKeyShift(dateKey, delta) {
  const p = String(dateKey).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + delta);
  return todayStr(d);
}

/** 汇总某天的「写入数」与「写入+浏览总数」 */
function dayWriteAndTotal(day) {
  let write = 0, total = 0;
  if (day && day.actions) {
    for (const k of Object.keys(day.actions)) {
      const c = day.actions[k] || 0;
      total += c;
      if (CORE_ACTIONS.has(k)) write += c;
    }
  }
  return { write, total };
}

/**
 * 账本汇总（month 传 'YYYY-MM' 则按月，传 '' 则全部）
 * 人情记账（giftRecords）自动折算为「人情」分类汇入总账：
 *   direction=out → 支出，direction=in → 收入
 */
/* =================== 「今天」驾驶舱聚合 =================== */
/** 月份位移：'2026-10' + (-1) → '2026-09' */
function monthShift(month, delta) {
  const parts = String(month).split('-');
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** 本周（周一为起点）起始日期 */
function weekStartOf(today) {
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return todayStr(d);
}

function greetingByHour(h) {
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

/** 宽松解析 JSON：容忍代码块包裹与前后废话，支持对象或数组 */
function parseJsonLoose(raw) {
  let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  // 找第一个 { 或 [ 到最后一个 } 或 ]
  const a = s.search(/[{[]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// 订阅消息授权后仅 7 天内可下发，过期需重新授权
function wechatSubValid(sub) { return sub && sub.tmplId && sub.grantedAt && (Date.now() - sub.grantedAt) < 7 * 86400 * 1000; }

// 模板字段值占位符：{{date}} {{time}} {{datetime}} {{text}}
function fillTpl(value, text) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const time = pad(now.getHours()) + ':' + pad(now.getMinutes());
  s = s.replace(/\{\{date\}\}/g, date)
       .replace(/\{\{time\}\}/g, time)
       .replace(/\{\{datetime\}\}/g, date + ' ' + time);
  if (text) s = s.replace(/\{\{text\}\}/g, (safeSlice((text.split('\n')[0] || ''), 20)));
  else s = s.replace(/\{\{text\}\}/g, '');
  return s;
}

/** 金额短显示：整数省小数，非整数保留两位 */
function moneyVal(n) {
  const v = Math.round((+n || 0) * 100) / 100;
  return Number.isInteger(v) ? v.toLocaleString('zh-CN') : v.toFixed(2);
}

function maskWebhook(u) {
  if (!u) return '';
  try { const o = new URL(u); return o.hostname + '/…' + o.pathname.slice(-6); } catch (e) { return '已配置'; }
}

/* ---------------- 对象存储备份（S3 / MinIO，零依赖 SigV4 签名） ---------------- */
/** AWS Signature V4 所需：HMAC-SHA256 */
function sigHmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }

function sigSha256Hex(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }

/** 按 RFC3986 编码路径段（S3 key 的 %2F 需还原为 /，否则 MinIO 会当单段处理） */
function sigUriEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, '/');
}

/* ---------------- 完整备份 ZIP（零依赖手写 ZIP 写入器） ----------------
 * 目的：「一键完整备份」下载一个可离机保存、可整目录恢复的 zip——
 *   db.json（原样含密文）+ .storage-key（解密锚点）+ uploads/（证件扫描件等）+ backup-manifest.json（SHA-256 清单）。
 *   与每日自动备份（data/backup/auto/<日期>/）同源同语义，只是把还原点搬到了用户手里。
 * 实现：store/deflate 二选一（deflate 用 zlib.deflateRawSync，压不小则回退 store）；
 *   文件名均为 ASCII（uploads 落盘名 = 32 位 hex + 扩展名），仍置 UTF-8 标志位（bit 11）防未来非 ASCII 名；
 *   只写文件条目不写目录条目，解压器（含 Windows 资源管理器）会自动建立中间目录。 */
let __zipCrcTable = null;

function crc32(buf) {
  if (!__zipCrcTable) {
    __zipCrcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      __zipCrcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = __zipCrcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  d = (d instanceof Date && !isNaN(d)) ? d : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 'YYYY-MM-DD' 的 ISO 周年键，如 '2026-W41' */
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // 本周周四
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const fdayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdayNum + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/** 日期加减天数（返回 'YYYY-MM-DD'） */
function dateAddDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 人类可读的字节数 */
function fmtBytes(n) {
  n = +n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/* ==================== 账户余额推导（迭代 1） ====================
 * 口径（硬性）：
 *   balance(A) = 期初余额 + Σ转出到 A − Σ从 A 转出 + Σ收入(A) − Σ支出(A)
 *   余额只由流水推导，绝不落盘；转账既不进收入也不进支出。
 *   month 传 'YYYY-MM' 时，balance 仍是「全量推导」（余额是存量概念），
 *   而 monthIncome / monthExpense / monthTransferIn / monthTransferOut 是当月发生额（流量）。
 */
const round2 = n => Math.round((+n || 0) * 100) / 100;

function fpMaxStayMinutes(times) {
  const ts = (times || []).filter(Boolean).sort();
  if (!ts.length) return 0;
  const GAP = 60 * 60 * 1000;   // 相邻打卡间隔超过 60 分钟视为离场，重新起算停留段
  let maxMin = 0, start = ts[0], prev = ts[0];
  for (let i = 1; i <= ts.length; i++) {
    const cur = ts[i];
    if (cur === undefined || (new Date(cur) - new Date(prev)) > GAP) {
      const span = (new Date(prev) - new Date(start)) / 60000;
      if (span > maxMin) maxMin = span;
      if (cur !== undefined) start = cur;
    }
    prev = cur;
  }
  return Math.floor(maxMin);
}

/* ---------- 中国省市名称表（用于「点亮城市」的地域识别，仅名称不含坐标） ---------- */
const CN_REGION = [
  ['北京市', ['北京市']], ['天津市', ['天津市']], ['上海市', ['上海市']], ['重庆市', ['重庆市']],
  ['河北省', ['石家庄市', '唐山市', '秦皇岛市', '邯郸市', '邢台市', '保定市', '张家口市', '承德市', '沧州市', '廊坊市', '衡水市']],
  ['山西省', ['太原市', '大同市', '阳泉市', '长治市', '晋城市', '朔州市', '晋中市', '运城市', '忻州市', '临汾市', '吕梁市']],
  ['内蒙古自治区', ['呼和浩特市', '包头市', '乌海市', '赤峰市', '通辽市', '鄂尔多斯市', '呼伦贝尔市', '巴彦淖尔市', '乌兰察布市', '兴安盟', '锡林郭勒盟', '阿拉善盟']],
  ['辽宁省', ['沈阳市', '大连市', '鞍山市', '抚顺市', '本溪市', '丹东市', '锦州市', '营口市', '阜新市', '辽阳市', '盘锦市', '铁岭市', '朝阳市', '葫芦岛市']],
  ['吉林省', ['长春市', '吉林市', '四平市', '辽源市', '通化市', '白山市', '松原市', '白城市', '延边朝鲜族自治州']],
  ['黑龙江省', ['哈尔滨市', '齐齐哈尔市', '鸡西市', '鹤岗市', '双鸭山市', '大庆市', '伊春市', '佳木斯市', '七台河市', '牡丹江市', '黑河市', '绥化市', '大兴安岭地区']],
  ['江苏省', ['南京市', '无锡市', '徐州市', '常州市', '苏州市', '南通市', '连云港市', '淮安市', '盐城市', '扬州市', '镇江市', '泰州市', '宿迁市']],
  ['浙江省', ['杭州市', '宁波市', '温州市', '嘉兴市', '湖州市', '绍兴市', '金华市', '衢州市', '舟山市', '台州市', '丽水市']],
  ['安徽省', ['合肥市', '芜湖市', '蚌埠市', '淮南市', '马鞍山市', '淮北市', '铜陵市', '安庆市', '黄山市', '滁州市', '阜阳市', '宿州市', '六安市', '亳州市', '池州市', '宣城市']],
  ['福建省', ['福州市', '厦门市', '莆田市', '三明市', '泉州市', '漳州市', '南平市', '龙岩市', '宁德市']],
  ['江西省', ['南昌市', '景德镇市', '萍乡市', '九江市', '新余市', '鹰潭市', '赣州市', '吉安市', '宜春市', '抚州市', '上饶市']],
  ['山东省', ['济南市', '青岛市', '淄博市', '枣庄市', '东营市', '烟台市', '潍坊市', '济宁市', '泰安市', '威海市', '日照市', '临沂市', '德州市', '聊城市', '滨州市', '菏泽市']],
  ['河南省', ['郑州市', '开封市', '洛阳市', '平顶山市', '安阳市', '鹤壁市', '新乡市', '焦作市', '濮阳市', '许昌市', '漯河市', '三门峡市', '南阳市', '商丘市', '信阳市', '周口市', '驻马店市']],
  ['湖北省', ['武汉市', '黄石市', '十堰市', '宜昌市', '襄阳市', '鄂州市', '荆门市', '孝感市', '荆州市', '黄冈市', '咸宁市', '随州市', '恩施土家族苗族自治州']],
  ['湖南省', ['长沙市', '株洲市', '湘潭市', '衡阳市', '邵阳市', '岳阳市', '常德市', '张家界市', '益阳市', '郴州市', '永州市', '怀化市', '娄底市', '湘西土家族苗族自治州']],
  ['广东省', ['广州市', '韶关市', '深圳市', '珠海市', '汕头市', '佛山市', '江门市', '湛江市', '茂名市', '肇庆市', '惠州市', '梅州市', '汕尾市', '河源市', '阳江市', '清远市', '东莞市', '中山市', '潮州市', '揭阳市', '云浮市']],
  ['广西壮族自治区', ['南宁市', '柳州市', '桂林市', '梧州市', '北海市', '防城港市', '钦州市', '贵港市', '玉林市', '百色市', '贺州市', '河池市', '来宾市', '崇左市']],
  ['海南省', ['海口市', '三亚市', '三沙市', '儋州市']],
  ['四川省', ['成都市', '自贡市', '攀枝花市', '泸州市', '德阳市', '绵阳市', '广元市', '遂宁市', '内江市', '乐山市', '南充市', '眉山市', '宜宾市', '广安市', '达州市', '雅安市', '巴中市', '资阳市', '阿坝藏族羌族自治州', '甘孜藏族自治州', '凉山彝族自治州']],
  ['贵州省', ['贵阳市', '六盘水市', '遵义市', '安顺市', '毕节市', '铜仁市', '黔西南布依族苗族自治州', '黔东南苗族侗族自治州', '黔南布依族苗族自治州']],
  ['云南省', ['昆明市', '曲靖市', '玉溪市', '保山市', '昭通市', '丽江市', '普洱市', '临沧市', '楚雄彝族自治州', '红河哈尼族彝族自治州', '文山壮族苗族自治州', '西双版纳傣族自治州', '大理白族自治州', '德宏傣族景颇族自治州', '怒江傈僳族自治州', '迪庆藏族自治州']],
  ['西藏自治区', ['拉萨市', '日喀则市', '昌都市', '林芝市', '山南市', '那曲市', '阿里地区']],
  ['陕西省', ['西安市', '铜川市', '宝鸡市', '咸阳市', '渭南市', '延安市', '汉中市', '榆林市', '安康市', '商洛市']],
  ['甘肃省', ['兰州市', '嘉峪关市', '金昌市', '白银市', '天水市', '武威市', '张掖市', '平凉市', '酒泉市', '庆阳市', '定西市', '陇南市', '临夏回族自治州', '甘南藏族自治州']],
  ['青海省', ['西宁市', '海东市', '海北藏族自治州', '黄南藏族自治州', '海南藏族自治州', '果洛藏族自治州', '玉树藏族自治州', '海西蒙古族藏族自治州']],
  ['宁夏回族自治区', ['银川市', '石嘴山市', '吴忠市', '固原市', '中卫市']],
  ['新疆维吾尔自治区', ['乌鲁木齐市', '克拉玛依市', '吐鲁番市', '哈密市', '昌吉回族自治州', '博尔塔拉蒙古自治州', '巴音郭楞蒙古自治州', '阿克苏地区', '克孜勒苏柯尔克孜自治州', '喀什地区', '和田地区', '伊犁哈萨克自治州', '塔城地区', '阿勒泰地区']],
  ['台湾省', ['台北市', '新北市', '桃园市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉义市']],
  ['香港特别行政区', ['香港']], ['澳门特别行政区', ['澳门']]
];

/** 去掉行政区后缀得到核心词，如「延边朝鲜族自治州」→「延边」 */
function regionCore(name) {
  let s = String(name || '');
  const ETHNIC = '(?:朝鲜|蒙古|回|藏|维吾尔|苗|彝|壮|布依|侗|瑶|白|土家|哈尼|哈萨克|傣|黎|傈僳|佤|畲|高山|拉祜|水|东乡|纳西|景颇|柯尔克孜|土|达斡尔|仫佬|羌|布朗|撒拉|毛南|仡佬|锡伯|阿昌|普米|塔吉克|怒|乌孜别克|俄罗斯|鄂温克|德昂|保安|裕固|京|塔塔尔|独龙|鄂伦春|赫哲|门巴|珞巴|基诺)族';
  s = s.replace(/(特别行政区|自治区|省|地区|市|盟|自治州|自治县|县|区)$/, '');
  s = s.replace(new RegExp('(' + ETHNIC + ')+$'), '');
  return s;
}

const CITY_FLAT = [];   // {city, core, province}

const PROV_FLAT = [];   // {province, core}
CN_REGION.forEach(([prov, cities]) => {
  PROV_FLAT.push({ province: prov, core: regionCore(prov) });
  cities.forEach(c => CITY_FLAT.push({ city: c, core: regionCore(c), province: prov }));
});
CITY_FLAT.sort((a, b) => b.core.length - a.core.length);
PROV_FLAT.sort((a, b) => b.core.length - a.core.length);

/** 从地址/地点名识别 省 / 市（仅做名称匹配，无坐标依赖；识别不到则为空） */
function parseRegion(address, name) {
  const text = String(address || '') + ' ' + String(name || '');
  let out = { province: '', city: '' };
  for (const c of CITY_FLAT) {
    if (c.core.length >= 2 && text.indexOf(c.core) >= 0) {
      out.city = c.city; out.province = c.province; break;
    }
  }
  if (!out.province) {
    for (const p of PROV_FLAT) {
      if (p.core.length >= 2 && text.indexOf(p.core) >= 0) { out.province = p.province; break; }
    }
  }
  // 直辖市：省=市
  if (out.province && !out.city && ['北京市', '天津市', '上海市', '重庆市'].includes(out.province)) out.city = out.province;
  return out;
}

/** 城市搜索（手动点亮用） */
function searchCities(kw) {
  const k = String(kw || '').trim();
  if (!k) return CITY_FLAT.slice(0, 30).map(c => ({ city: c.city, province: c.province }));
  return CITY_FLAT.filter(c => c.city.includes(k) || c.core.includes(k) || c.province.includes(k))
    .slice(0, 30).map(c => ({ city: c.city, province: c.province }));
}

/** 两坐标点球面距离（米），Haversine 公式 */
function haversine(a, b) {
  if (!a || !b || !a.lat || !b.lat) return 0;
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLng / 2), 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = {
  CITY_FLAT,
  CN_REGION,
  CORE_ACTIONS,
  PROV_FLAT,
  RICH_ATTRS,
  RICH_DROP,
  RICH_TAGS,
  __zipCrcTable,
  crc32,
  dateAddDays,
  dateKeyShift,
  dayWriteAndTotal,
  daysToNextYearly,
  daysToNextYearlyLunar,
  daysUntil,
  dosDateTime,
  fileStamp,
  fillTpl,
  fmtBytes,
  fpMaxStayMinutes,
  greetingByHour,
  haversine,
  htmlToPlain,
  isoWeekKey,
  maskWebhook,
  moneyVal,
  monthShift,
  mortgageMonthlyPayment,
  newId,
  newToken,
  nowStr,
  parseJsonLoose,
  parseRegion,
  regionCore,
  quickAddRuleFallback,
  round2,
  safeSlice,
  sanitizeRichHtml,
  searchCities,
  sigHmac,
  sigSha256Hex,
  sigUriEncode,
  toText,
  todayStr,
  validAmount,
  validDateStr,
  wechatSubValid,
  weekStartOf,
};
