/**
 * 生活驾驶舱（克隆版）- 公共JS
 * API封装 / 登录检查 / 页面壳渲染 / 时钟农历 / 天气 / 通用组件
 */

/* ---------------- 全局错误兜底（P1-6） ----------------
 * 页面任何未捕获脚本异常（含历史白屏类 SyntaxError）首次出现时，
 * 在页面底部弹出非阻塞提示条：友好文案 + 一键刷新，用户不再"白屏干瞪眼"。
 * 同一次页面加载只提示一次；样式内联自包含，即使 CSS 加载失败也能显示。 */
(function () {
  var shown = false;
  function boot(detail) {
    try {
      if (!document.body || document.getElementById('g-error-bar')) return;
      var bar = document.createElement('div');
      bar.id = 'g-error-bar';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;'
        + 'display:flex;align-items:center;gap:10px;width:calc(100vw - 32px);max-width:560px;box-sizing:border-box;'
        + 'padding:10px 12px 10px 16px;border-radius:12px;background:#1f2937;color:#f3f4f6;'
        + 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.28);';
      var txt = document.createElement('span');
      txt.textContent = '页面出了点小问题，部分功能可能不可用';
      txt.style.cssText = 'flex:1 1 auto;min-width:0;';
      txt.title = detail || ''; // 完整报错悬停可见，不在横幅里刷屏
      var refresh = document.createElement('button');
      refresh.textContent = '刷新页面';
      refresh.style.cssText = 'flex:none;min-height:34px;padding:0 14px;border:0;border-radius:8px;'
        + 'background:#2563eb;color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;';
      refresh.onclick = function () { location.reload(); };
      var close = document.createElement('button');
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭提示');
      close.style.cssText = 'flex:none;min-width:30px;min-height:30px;border:0;border-radius:6px;'
        + 'background:transparent;color:#9ca3af;font-family:inherit;font-size:16px;line-height:1;cursor:pointer;';
      close.onclick = function () { bar.remove(); };
      bar.appendChild(txt); bar.appendChild(refresh); bar.appendChild(close);
      document.body.appendChild(bar);
    } catch (e) { /* 兜底自身绝不能再抛错 */ }
  }
  function show(detail) {
    if (shown) return;
    shown = true;
    try { console.error('[错误兜底]', detail); } catch (e) {}
    if (document.body) boot(detail);
    else document.addEventListener('DOMContentLoaded', function () { boot(detail); }, { once: true });
  }
  window.onerror = function (msg, src, line, col) {
    if (src && /-extension:/.test(src)) return false; // 浏览器扩展脚本报错不打扰用户
    show(String(msg) + (src ? '（' + String(src).replace(/^.*[\\/]/, '') + ':' + line + ':' + col + '）' : ''));
    return false; // 不拦截默认行为，报错仍可在控制台查看
  };
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    show('Promise 异常：' + (r && r.message ? r.message : String(r || '未知异常')));
  });
})();

/* ---------------- 应用版本（全局唯一来源） ---------------- */
// 全站共享：侧边栏底部、ai-core.js 等运行时版本号统一从这里读取；
// 页面 <script src="...?v=xxx"> 上的缓存 busting 版本号由组织者统一 bump。
var APP_VERSION = '1.48.54';

/* ---------------- API 封装 ---------------- */
function getToken() { return localStorage.getItem('token') || readCookie('token'); }
function getUsername() { return localStorage.getItem('username') || 'admin'; }
function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
async function apiGet(url) { return request('GET', url); }
async function apiPost(url, data) { return request('POST', url, data); }
async function apiPut(url, data) { return request('PUT', url, data); }
async function apiDelete(url) { return request('DELETE', url); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function request(method, url, data) {
  try {
    /* X-Requested-With 是服务端 CSRF 判据之一：自定义头无法由跨站 <form> 设置，
       跨站 fetch 带它会触发 CORS 预检（本服务无 CORS 头，预检必失败）。
       同源请求同时也会带同源 Origin，两条判据都满足，全站只需在这一处加。 */
    const opt = { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } };
    if (data !== undefined) opt.body = JSON.stringify(data);
    const resp = await fetch(url, opt);
    if (resp.status === 401) { clearAuth(); window.location.href = '/login'; return { code: 401 }; }
    return await resp.json();
  } catch (e) {
    return { code: 500, message: '网络错误' };
  }
}
function clearAuth() {
  ['token', 'username', 'userId', 'role', 'themeColor', 'theme'].forEach(k => localStorage.removeItem(k));
  document.cookie = 'token=;path=/;max-age=0'; // 兜底清除非 HttpOnly 残留；HttpOnly cookie 由服务端 /api/auth/logout 清除
}
async function logout() {
  // 先请服务端删除会话并清除 HttpOnly cookie（前端 JS 无法清除 HttpOnly cookie）
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      // 鉴权走同源 HttpOnly cookie（fetch 默认携带），不再用 Bearer；
      // 自定义头让这个写请求通过服务端 CSRF 校验（见 request() 的说明）
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
  } catch (e) { /* 网络异常也要继续本地清理与跳转，避免卡在原地 */ }
  clearAuth();
  window.location.href = '/login';
}
// 未登录跳转：HttpOnly cookie 无法被 JS 读取，改用非敏感标记 username 判断"看起来已登录"；
// 真正的鉴权仍由服务端 cookie 校验——request() 遇到 401 会自动 clearAuth 并跳回登录页。
(function checkAuth() {
  if (!localStorage.getItem('username') && !getToken() && !location.pathname.startsWith('/login')) {
    location.replace('/login');
  }
})();
// 若 localStorage 缺少用户名（如从 Cookie 恢复登录态），从服务端补齐
async function ensureUserInfo() {
  if (localStorage.getItem('username')) return;
  try {
    const r = await fetch('/api/users/me').then(x => x.json());
    if (r.code === 200 && r.data) {
      localStorage.setItem('username', r.data.username);
      localStorage.setItem('userId', r.data.id);
      localStorage.setItem('role', r.data.role);
      if (r.data.themeColor) localStorage.setItem('themeColor', r.data.themeColor);
      if (r.data.theme) localStorage.setItem('theme', r.data.theme);
      // 补齐后刷新壳上的用户名
      document.querySelectorAll('.user-info span').forEach(el => {
        if (el.textContent === 'admin' || el.textContent === '') el.textContent = r.data.username;
      });
    }
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 功能开关（系统设置→功能开关） ---------------- */
let FEATURE_FLAGS = null;
const FEATURE_MENU_MAP = {
  featGift: 'gift-records', featExpiry: 'expiries', featAnniversary: 'anniversaries',
  featMortgage: 'mortgage', featVault: 'vault', featNotes: 'notes', featTrack: ['location', 'footprint']
};

/* ---------------- 成员卡通头像（全站统一渲染，单一来源） ---------------- */
const AVATARS = [
  { key:'grandmother', name:'老奶奶', src:'/avatars/grandmother.jpg' },
  { key:'grandfather', name:'老爷爷', src:'/avatars/grandfather.jpg' },
  { key:'mother',      name:'妈妈',   src:'/avatars/mother.jpg' },
  { key:'father',      name:'爸爸',   src:'/avatars/father.jpg' },
  { key:'daughter',    name:'大女儿', src:'/avatars/daughter.jpg' },
  { key:'son',         name:'大儿子', src:'/avatars/son.jpg' },
  { key:'girl',        name:'小女孩', src:'/avatars/girl.jpg' },
  { key:'boy',         name:'小男孩', src:'/avatars/boy.jpg' },
  { key:'babygirl',    name:'女婴',   src:'/avatars/babygirl.jpg' },
  { key:'babyboy',     name:'男婴',   src:'/avatars/babyboy.jpg' },
  { key:'cat',         name:'小猫',   src:'/avatars/cat.jpg' },
  { key:'dog',         name:'小狗',   src:'/avatars/dog.jpg' }
];
// 命中成员头像则返回 <img>，否则返回 ''（调用方走原 emoji/SVG 回退）
function memberAvatarHtml(m) {
  if (!m || !m.avatar) return '';
  const a = AVATARS.find(x => x.key === m.avatar);
  if (!a) return '';
  return '<img class="mem-avatar-img" src="' + a.src + '" alt="' + a.name + '" loading="lazy">';
}
window.memberAvatarHtml = memberAvatarHtml;
let __cfgPromise = null;
async function loadAppConfig() {
  // 在途 Promise 复用：renderShell 与 mountAiCore 并发调用时只发一次请求
  if (__cfgPromise) return __cfgPromise;
  __cfgPromise = (async () => {
    try {
      const r = await fetch('/api/settings/config').then(x => x.json());
      if (r.code === 200 && r.data) {
        FEATURE_FLAGS = r.data;
        localStorage.setItem('featureFlags', JSON.stringify(r.data));
        applyFeatureFlags();
      }
    } catch (e) { /* 忽略 */ }
    finally { __cfgPromise = null; }
  })();
  return __cfgPromise;
}
function applyFeatureFlags() {
  const f = FEATURE_FLAGS;
  if (!f) return;
  Object.keys(FEATURE_MENU_MAP).forEach(k => {
    const v = FEATURE_MENU_MAP[k];
    (Array.isArray(v) ? v : [v]).forEach(href => {
      // 桌面侧栏
      const a = document.querySelector('.sidebar-nav a[href="/' + href + '"]');
      if (a) a.style.display = (f[k] === false) ? 'none' : '';
      // 移动端「更多」面板（P2-4：与桌面保持一致，关闭数据开关后移动端入口同样隐藏）
      document.querySelectorAll('.ms-item[href="/' + href + '"]').forEach(el => {
        el.style.display = (f[k] === false) ? 'none' : '';
      });
    });
  });
  // 组内菜单项全部被隐藏时，一并隐藏该分组标题，避免出现空标题
  document.querySelectorAll('.sidebar-nav .nav-group').forEach(g => {
    const links = g.querySelectorAll('a');
    const anyVisible = Array.prototype.some.call(links, a => getComputedStyle(a).display !== 'none');
    g.style.display = anyVisible ? '' : 'none';
  });
  // 移动端「更多」面板：组内项全部隐藏时，隐藏对应 `.ms-sec` + `.ms-grid` 分节
  // 结构：moreGrid 把每个组的 `.ms-sec` 与全部 `.ms-item` 平铺进同一个 `.ms-grid`，
  // 因此这里按「每个 `.ms-sec` 后到下一个 `.ms-sec` 之前」的兄弟项聚合判断。
  (function hideEmptyMobileSections() {
    const grid = document.querySelector('.ms-grid');
    if (!grid) return;
    const secs = Array.prototype.slice.call(grid.querySelectorAll('.ms-sec'));
    secs.forEach(sec => {
      let vis = false;
      for (let n = sec.nextElementSibling; n && !n.classList.contains('ms-sec'); n = n.nextElementSibling) {
        if (n.classList.contains('ms-item') && getComputedStyle(n).display !== 'none') { vis = true; break; }
      }
      sec.style.display = vis ? '' : 'none';
    });
  })();
}

/* ---------------- 时钟与问候 ---------------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function weekCN(d) { return '星期' + ['日','一','二','三','四','五','六'][d.getDay()]; }
function greetingOf(h) {
  return h < 6 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}
function formatFullTime(date) {
  const lunar = lunarStrOf(date);
  return date.getFullYear() + '年' + pad2(date.getMonth() + 1) + '月' + pad2(date.getDate()) + '日 '
    + lunar + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    + ' ' + weekCN(date);
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* =====================================================================
   v1.7.1 语音录入（Web Speech API，零依赖）
   - voiceMicHtml(targetId, opts)：生成麦克风按钮；opts.mode = append|replace
   - toggleVoiceInput(btn)：开始/停止识别，结果实时写入目标输入框/contenteditable
   - opts.ai = 'ledger'|'tasks'…：结束后调用 /api/ai/complete 抽取结构化字段，
     由页面注册的 window.applyVoiceFill(kind, data) 接收填表；AI 未配置则只做转写
   ===================================================================== */
/* ===== 全局：URL ?hl=<id> 跳转后自动高亮定位（首页「今天要处理」跳入的目标页） ===== */
(function () {
  var m = (location.search || '').match(/[?&]hl=(\d+)/);
  if (!m) return;
  var hlId = parseInt(m[1], 10), done = false;
  function flash(el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(true); }
    el.classList.add('hl-flash');
    setTimeout(function () { el.classList.remove('hl-flash'); }, 2600);
  }
  function tryFind() {
    if (done) return;
    var el = document.querySelector('[data-id="' + hlId + '"]');
    if (!el) return;
    done = true;
    flash(el);
  }
  tryFind();
  if (document.readyState !== 'complete') window.addEventListener('load', tryFind);
  if (window.MutationObserver) {
    var obs = new MutationObserver(tryFind);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { try { obs.disconnect(); } catch (e) { } }, 6000);
  }
})();
function startClock() {
  let lastMin = -1;
  const update = () => {
    const n = new Date();
    const h = n.getHours();
    const g = greetingOf(h);
    const clockEl = document.getElementById('clock');
    if (clockEl) clockEl.textContent = n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate())
      + ' ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ':' + pad2(n.getSeconds()) + ' ' + weekCN(n);
    // 读屏专用：每分钟才更新一次，避免秒级刷新造成噪音
    const srEl = document.getElementById('clockSr');
    const min = n.getMinutes();
    if (srEl && min !== lastMin) {
      lastMin = min;
      srEl.textContent = (n.getMonth() + 1) + '月' + n.getDate() + '日 ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ' ' + weekCN(n);
    }
    const welcomeEl = document.getElementById('welcomeClock');
    if (welcomeEl) welcomeEl.textContent = formatFullTime(n) + ' | ' + g;
  };
  update();
  setInterval(update, 1000);
}

/* ---------------- 页面壳（侧边栏 + 顶栏） ---------------- */
const MENU_DEFS = [
  { key: 'dashboard', href: '/dashboard', label: '生活驾驶舱', group: '今天', icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10' },
  { key: 'tasks', href: '/tasks', label: '一次性事务', group: '今天', icon: 'M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18' },
  { key: 'scheduled-tasks', href: '/scheduled-tasks', label: '循环事务', group: '今天', icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2' },
  { key: 'family', href: '/family', label: '家庭成员', group: '家底', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75' },
  { key: 'anniversaries', href: '/anniversaries', label: '纪念日', group: '家底', icon: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7z' },
  { key: 'expiries', href: '/expiries', label: '证件效期', group: '家底', icon: 'M6 2h12 M6 22h12 M6 2v4l6 6 6-6V2 M6 22v-4l6-6 6 6v4' },
  { key: 'networth', href: '/networth', label: '家底总览', group: '家底', icon: 'M12 3v18 M7 21h10 M3 7l6 3 M21 7l-6 3 M3 7a3 3 0 0 0 6 0 M15 7a3 3 0 0 0 6 0' },
  { key: 'vault', href: '/vault', label: '保险库', group: '家底', icon: 'M3 11h18v11H3z M7 11V7a5 5 0 0 1 10 0v4' },
  { key: 'ledger', href: '/ledger', label: '家庭账本', group: '钱', icon: 'M21 12V7H5a2 2 0 0 1 0-4h14v4 M3 5v14a2 2 0 0 0 2 2h16v-5 M18 12a2 2 0 0 0 0 4h4v-4z' },
  { key: 'gift-records', href: '/gift-records', label: '人情记账', group: '钱', icon: 'M20 12v10H4V12 M2 7h20v5H2z M12 22V7 M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z' },
  { key: 'mortgage', href: '/mortgage', label: '贷款计算', group: '钱', icon: 'M2 3h20v14H2z M8 21h8 M12 17v4' },
  { key: 'notes', href: '/notes', label: '备忘手记', group: '我', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M16 21H8' },
  { key: 'health', href: '/health', label: '健康记录', group: '我', icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v8 M8 12h8' },
  { key: 'report', href: '/report', label: '生活月报', group: '我', icon: 'M3 3h18v18H3z M3 9h18 M9 21V9 M21 3H9' },
  { key: 'location', href: '/location', label: '轨迹记录', group: '我', icon: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { key: 'footprint', href: '/footprint', label: '足迹回顾', group: '我', icon: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15' },
  { key: 'ai', href: '/ai', label: 'AI 小助手', group: '我', icon: 'M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z M9 21h6' },
  { key: 'general-config', href: '/general-config', label: '通用配置', group: '管理', icon: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6' },
  { key: 'help-center', href: '/help-center', label: '帮助中心', group: '管理', icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01' },
  { key: 'settings', href: '/settings', label: '系统设置', group: '管理', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
  { key: 'insights', href: '/insights', label: '使用洞察', group: '管理', icon: 'M3 3v18h18 M7 15l4-5 3 3 5-7' },
  { key: 'admin-modules', href: '/admin-modules', label: '模块管理', group: '管理', icon: 'M4 4h16v16H4z M9 4v16 M15 4v16 M4 9h16 M4 15h16' },
  { key: 'admin-store', href: '/admin-store', label: '版本与规划', group: '管理', icon: 'M6 2h12l2 6H4z M4 8h16l-2 14H6z' }
];

/* 信息架构：今天 → 家底 → 钱 → 我 → 管理（0 数据模块已隐藏，不删代码） */
const GROUP_ORDER = ['今天', '家底', '钱', '我', '管理'];

function iconSvg(path) {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
}

/* 渲染路径 UI 图标（Lucide 风格，1em 随字号）：emoji → 内联 SVG 的统一来源 */
const UI_ICON = {
  home: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  search: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  mic: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  bot: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9 13v2"/><path d="M15 13v2"/></svg>',
  keyboard: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01"/><path d="M10 10h.01"/><path d="M14 10h.01"/><path d="M18 10h.01"/><path d="M8 14h8"/></svg>',
  /* UI 评审 P2-8：成功态图标统一走 uiIcon，替代 Toast 里的 emoji ✅ */
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
};
function uiIcon(name) { return UI_ICON[name] || ''; }

/* ---- 拍板方案 B（docs/redesign-v2/01-首页原型评审.md §七 A1）----
   桌面侧栏 = 8 项主入口平铺 + 末尾「系统设置」齿轮（分隔线隔开）。
   其余 15 个模块不进侧栏，但顶栏全局搜索 renderPages() 遍历全部 MENU_DEFS，桌面仍可直达，不丢入口（A2）。
   初始渲染与「禁用模块」异步刷新共用本函数，保证两处一致。 */
const SIDEBAR_KEYS = ['dashboard', 'ledger', 'anniversaries', 'expiries', 'health', 'vault', 'report', 'ai'];
const NAV_LABEL = { dashboard: '首页' };   // 品牌名已在 sidebar-brand，导航项显示「首页」而非「生活驾驶舱」
function buildDesktopNav(disabledList, activeKey) {
  const dis = disabledList || [];
  const byKey = k => MENU_DEFS.find(m => m.key === k);
  const link = m => '<a href="' + m.href + '"' + (m.key === activeKey ? ' class="active"' : '') + '>'
    + '<span class="nav-icon">' + iconSvg(m.icon) + '</span><span>' + (NAV_LABEL[m.key] || m.label) + '</span></a>';
  let html = SIDEBAR_KEYS.map(byKey).filter(m => m && !dis.includes(m.key)).map(link).join('');
  const s = byKey('settings');
  if (s && !dis.includes('settings')) html += '<div class="nav-sep"></div>' + link(s);
  /* 评审 P2-1：全站 24 个模块只有 9 个进侧栏，其余 15 个原本只能靠顶栏搜索进入。
     搜索优先对不熟悉产品的家人（含长辈）门槛偏高，这里把移动端已有的「全部功能」面板
     接到桌面侧栏，作为可发现性兜底——不改变原有的收敛导航设计。 */
  html += '<button type="button" class="nav-more-btn" onclick="openMoreSheet()">'
    + '<span class="nav-icon">' + iconSvg('M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z') + '</span><span>全部功能</span></button>';
  return html;
}

/* ---------------- 无障碍兜底（评审 P2-3） ----------------
 * 实测问题：全站 128 个表单控件只挂了 placeholder、没有 label/aria-label；
 * 88 个纯图标按钮没有任何可访问名称（账本页一个页面 74 个编辑/删除钮）；
 * 22/24 个页面没有 h1。placeholder 不能当标签用——输入后提示即消失，读屏读到的是空控件。
 * 这里集中兜底，而不是去改 24 个页面的模板：
 *   1) 缺名称的 input/select/textarea → 依次尝试 placeholder / 邻近 label / 所在 form-group 的 label；
 *   2) 页面没有 h1 时，用页面标题插入一个视觉隐藏的 h1（.sr-only），让读屏有正确文档结构；
 *   3) 纯图标按钮仍无名称时，按 title / onclick 语义兜底（正常页面走不到这一步）。
 * 原则：只补空缺，绝不覆盖页面已写好的标注（aria-label 优先级最高，不会被改写）。
 */
function a11yFillNames(root) {
  const scope = root || document;
  const hasName = el => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
  scope.querySelectorAll('input:not([type=hidden]),select,textarea').forEach(el => {
    if (hasName(el) || el.closest('label')) return;
    if (el.id && scope.querySelector('label[for="' + el.id + '"]')) return;
    let name = (el.getAttribute('placeholder') || '').trim();
    if (!name) {
      const grp = el.closest('.form-group,.form-item,.field,.modal-body');
      if (grp) {
        const lab = grp.querySelector('label');
        if (lab) name = (lab.textContent || '').trim();
      }
    }
    if (!name) {
      const prev = el.previousElementSibling;
      if (prev && /^(LABEL|B|SPAN|DIV|H3|H4)$/.test(prev.tagName) && (prev.textContent || '').trim().length <= 24) {
        name = (prev.textContent || '').trim();
      }
    }
    if (!name) name = (el.getAttribute('name') || '').trim();
    if (name) el.setAttribute('aria-label', String(name).replace(/\s+/g, ' ').slice(0, 60));
  });
  const HINTS = [
    [/remove|delete|trash|clear|purge/, '删除'],
    [/edit|rename|modify|update/, '编辑'],
    [/add|create|new|insert/, '新增'],
    [/close|dismiss|cancel/, '关闭'],
    [/save|submit|confirm/, '保存'],
    [/copy|duplicate|clone/, '复制'],
    [/move|sort|order|up|down/, '调整顺序'],
    [/toggle|switch/, '开关'],
    [/search|filter/, '筛选']
  ];
  scope.querySelectorAll('button,a[href],[role=button]').forEach(el => {
    if (hasName(el) || (el.textContent || '').trim()) return;
    if (el.querySelector('img[alt]:not([alt=""])')) return;
    const hint = String(el.getAttribute('onclick') || '').toLowerCase();
    const hit = HINTS.find(h => h[0].test(hint));
    if (hit) { el.setAttribute('aria-label', hit[1]); el.setAttribute('title', hit[1]); }
    else el.setAttribute('aria-label', '操作');
  });
}
function ensurePageH1(title) {
  if (document.querySelector('h1')) return;
  const t = String(title || document.title || '').trim();
  if (!t) return;
  const h = document.createElement('h1');
  h.className = 'sr-only';
  h.textContent = t;
  document.body.insertBefore(h, document.body.firstChild);
}
/* 页面大都是「先渲染壳、再异步取数渲染表单」，因此用 MutationObserver 兜住后插入的控件。
   只监听 childList（不监听 attributes），补 aria-label 不会反过来触发自身，无死循环风险。 */
function startA11yObserver() {
  if (window.__a11yObserver || typeof MutationObserver !== 'function') return;
  let timer = null;
  const run = () => { timer = null; try { a11yFillNames(document); } catch (e) { } };
  window.__a11yObserver = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(run, 200);
  });
  window.__a11yObserver.observe(document.body, { childList: true, subtree: true });
}

function renderShell(activeKey, pageTitle) {
  // 主题应用：light / dark / auto（auto 跟随系统，监听系统切换实时生效）
  const theme = localStorage.getItem('theme') || 'light';
  const themeColor = localStorage.getItem('themeColor') || 'blue';
  const fontSize = localStorage.getItem('fontSize') || 'normal';
  const themeIsDark = t => t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', themeIsDark(theme) ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-color', themeColor);
  document.documentElement.setAttribute('data-font-size', fontSize === 'large' ? 'large' : 'normal');
  if (theme === 'auto' && window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    });
  }
  // 供 AI 内核识别当前页面
  document.body.dataset.aiPage = activeKey || '';
  document.body.dataset.aiPageTitle = pageTitle || '';

  const user = getUsername();
  const avatarChar = user.charAt(0).toUpperCase();
  // 桌面侧栏：拍板方案 B（8 项平铺 + 系统设置齿轮），见 buildDesktopNav
  // 模块管理：若已有禁用列表（window.__disabledModules）先过滤，稍后再异步拉取刷新
  const disabled0 = (window.__disabledModules || []);
  const nav = buildDesktopNav(disabled0, activeKey);

  const shell = `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">${uiIcon('home')}</span><span>生活驾驶舱</span>
      </div>
      <div class="sidebar-nav">
        ${nav}
      </div>
      <div class="sidebar-footer">v${APP_VERSION} · 生活驾驶舱</div>
    </aside>
    <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="toggleMobileMenu()"></div>
    <div class="main-content">
      <header class="top-bar">
        <div class="top-bar-left">
          <button class="menu-toggle" onclick="toggleMobileMenu()" aria-label="菜单">&#9776;</button>
          <!-- 移动端搜索入口：点开「全部功能」面板并聚焦搜索框（桌面直接显示搜索框，见 theme/） -->
          <button class="topbar-search-btn" onclick="openMoreSheet();setTimeout(function(){var i=document.getElementById('msSearch');if(i)i.focus();},380);" aria-label="搜索功能" title="搜索功能">${uiIcon('search')}</button>
          <span class="page-title">${pageTitle || ''}</span>
          <div class="topbar-search" id="topbarSearch">
            <span class="ts-icon">${uiIcon('search')}</span>
            <input type="text" id="globalSearch" placeholder="搜索页面 / 功能（试试：这个月花了多少）" autocomplete="off" aria-label="全局搜索">
            <button type="button" class="voice-mic" data-target="globalSearch" data-mode="append" title="语音问驾驶舱" aria-label="语音问驾驶舱" onclick="toggleVoiceInput(this)"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg><span class="vm-wave" aria-hidden="true"><i></i><i></i><i></i></span></button>
            <div class="gs-dropdown" id="gsDropdown" role="listbox"></div>
          </div>
        </div>
        <div class="top-bar-right">
          <span class="clock-display" id="clock" aria-hidden="true">--</span>
          <span class="sr-only" id="clockSr" aria-live="polite"></span>
          <div class="user-info">
            <div class="user-avatar">${avatarChar}</div>
            <span class="user-name">${user}</span>
          </div>
          <button class="logout-btn" onclick="logout()" title="退出登录">退出</button>
        </div>
      </header>
      <div class="content-area">`;
  // ---- 移动端信息架构（拍板 A3）：底部 5 Tab（首页/账本/提醒/健康/我的）+ 语音「记一下」悬浮钮（独立于 Tab 栏）+「全部功能」面板 ----
  const MOBILE_TABS = ['dashboard', 'ledger', 'scheduled-tasks', 'health', 'settings'];
  const TAB_LABEL = { dashboard: '首页', ledger: '账本', 'scheduled-tasks': '提醒', health: '健康', settings: '我的' };
  const MOBILE_FABS = {
    ledger: { fn: 'openRecordModal', label: '记一笔' },
    tasks: { fn: 'showAddTaskModal', label: '新建事务' },
    notes: { fn: 'createNewNote', label: '写笔记' },
    'gift-records': { fn: 'openGiftModal', label: '记人情' },
    anniversaries: { fn: 'showAddModal', label: '添加纪念日' },
    expiries: { fn: 'openItemModal', label: '添加物品' },
    'scheduled-tasks': { fn: 'openAddModal', label: '新建周期事项' }
  };
  const menuOf = k => MENU_DEFS.find(m => m.key === k) || {};
  const tabLinkHtml = k => '<a href="' + menuOf(k).href + '"' + (k === activeKey ? ' class="active" aria-current="page"' : '')
    + ' aria-label="' + (TAB_LABEL[k] || menuOf(k).label) + '"><span class="mtb-icon">' + iconSvg(menuOf(k).icon || '')
    + '</span><span class="mtb-label">' + (TAB_LABEL[k] || menuOf(k).label) + '</span></a>';
  // 语音「一句话记下来」：悬浮钮，独立于 Tab 栏上方（A3），有页面级 FAB 时自动上移避免遮挡（见 theme/ body.has-fab）
  const voiceFab = '<button type="button" class="mtb-voice-fab" id="mtbVoice" aria-label="一句话记下来" title="一句话记下来" onclick="openQuickAdd()">'
    + '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
    + '</button>';
  const tabsHtml = MOBILE_TABS.map(tabLinkHtml).join('');
  const fabDef = MOBILE_FABS[activeKey];
  const fabHtml = fabDef
    ? '<button type="button" class="mobile-fab" id="mobileFab" aria-label="' + fabDef.label + '" title="' + fabDef.label + '">'
      + '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>'
    : '';
  // 「全部功能」面板内容：按分组渲染，排除底部 5 个 Tab 项与被模块管理禁用的项。
  // A2：不再按 hidden 过滤——侧栏收敛到 8 项后，其余入口全部在此面板保留，移动端不丢可达性。
  window.__renderMoreGrid = function () {
    const dis = (window.__disabledModules || []);
    return GROUP_ORDER.map(g => {
      const items = MENU_DEFS.filter(m => m.group === g && !MOBILE_TABS.includes(m.key) && !dis.includes(m.key));
      if (!items.length) return '';
      return '<div class="ms-sec">' + g + '</div>' + items.map(m =>
        '<a class="ms-item' + (m.key === activeKey ? ' active' : '') + '" href="' + m.href + '">'
        + '<span class="ms-icon">' + iconSvg(m.icon) + '</span><span class="ms-label">' + m.label + '</span></a>').join('');
    }).join('');
  };
  const moreGrid = window.__renderMoreGrid();
  const moreSheet = '<div class="more-sheet" id="moreSheet" role="dialog" aria-modal="true" aria-label="全部功能" aria-hidden="true">'
    + '<div class="ms-backdrop" onclick="closeMoreSheet()"></div>'
    + '<div class="ms-panel"><div class="ms-handle" aria-hidden="true"></div><div class="ms-title">全部功能</div>'
    + '<div class="ms-search"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'
    + '<input type="text" id="msSearch" placeholder="搜索功能名称" autocomplete="off" aria-label="搜索功能"></div>'
    + '<div class="ms-grid">' + moreGrid + '</div>'
    + '<div class="ms-empty" id="msEmpty" style="display:none;">没有找到匹配的功能，试试换个关键词</div>'
    + '<div class="ms-footer"><button type="button" class="ms-logout" onclick="logout()">退出登录</button></div>'
    + '</div></div>';
  // 5 Tab 占满底栏，不再放「更多」按钮；「全部功能」入口移至「我的」(系统设置)页顶部（A4）。
  // 语音悬浮钮独立于 Tab 栏（A3），叠在页面级 FAB 之上（theme/ 用 body.has-fab 上移避让）。
  const mobileChrome = '<nav class="mobile-tabbar" aria-label="底部导航">' + tabsHtml + '</nav>'
    + voiceFab + fabHtml + moreSheet;

  // 壳容器：页面里没有 #shell 时自动创建（插到 body 最前面）
  let shellHost = document.getElementById('shell');
  if (!shellHost) {
    shellHost = document.createElement('div');
    shellHost.id = 'shell';
    document.body.insertBefore(shellHost, document.body.firstChild);
  }
  shellHost.innerHTML = shell + '</div></div>' + mobileChrome;
  // 模块管理：异步拉取禁用模块，刷新侧边栏和更多面板
  fetch('/api/modules/disabled').then(r => r.json()).then(j => {
    const disabled = (j && j.data) || [];
    if (!disabled.length) return;
    window.__disabledModules = disabled;
    // 重新渲染侧边栏导航（与初始渲染同一函数，8 项平铺 + 系统设置齿轮）
    const navEl = document.querySelector('.sidebar-nav');
    if (navEl) navEl.innerHTML = buildDesktopNav(disabled, activeKey);
    // 重新渲染移动端「更多」面板（此前移动端未过滤 disabled）
    const gridEl = document.querySelector('.ms-grid');
    if (gridEl && typeof window.__renderMoreGrid === 'function') gridEl.innerHTML = window.__renderMoreGrid();
  }).catch(() => {});
  // FAB：绑定当前页面的主操作（页面脚本此时已定义，click 时再取 window[fn] 最稳）
  const fabEl = document.getElementById('mobileFab');
  if (fabEl && fabDef) {
    document.body.classList.add('has-fab');
    fabEl.addEventListener('click', () => {
      const f = window[fabDef.fn];
      if (typeof f === 'function') f();
      else if (typeof showToast === 'function') showToast('页面尚未就绪，请稍候', 'warning');
    });
  }
  // 「更多」面板开合（移动端底部 Tab）
  window.openMoreSheet = function () {
    const s = document.getElementById('moreSheet');
    if (!s) return;
    if (window.__msCloseT) { clearTimeout(window.__msCloseT); window.__msCloseT = null; }
    s.classList.add('open');
    s.setAttribute('aria-hidden', 'false');
  };
  window.closeMoreSheet = function () {
    const s = document.getElementById('moreSheet');
    if (!s) return;
    // FIX-35：先移除 .open 触发 CSS 下滑/遮罩渐隐过渡，300ms 后再收尾隐藏
    s.classList.remove('open');
    if (window.__msCloseT) clearTimeout(window.__msCloseT);
    window.__msCloseT = setTimeout(() => {
      if (!s.classList.contains('open')) s.setAttribute('aria-hidden', 'true');
    }, 300);
  }
  // 移动端搜索：打开「全部功能」面板并聚焦搜索框（由顶栏搜索钮调用）
  window.openMoreSearch = function () {
    openMoreSheet();
    setTimeout(function () {
      const i = document.getElementById('msSearch');
      if (i) { i.focus(); i.select(); }
    }, 380);
  }
  // 「全部功能」面板内搜索：按功能名过滤，分组标题与空态联动
  window.__bindMsSearch = function () {
    const inp = document.getElementById('msSearch');
    if (!inp || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', function () {
      const q = (this.value || '').trim().toLowerCase();
      const items = document.querySelectorAll('#moreSheet .ms-item');
      let shown = 0;
      items.forEach(function (it) {
        const hit = !q || (it.textContent || '').toLowerCase().indexOf(q) >= 0;
        it.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      document.querySelectorAll('#moreSheet .ms-sec').forEach(function (sec) {
        let any = false, n = sec.nextElementSibling;
        while (n && n.classList.contains('ms-item')) {
          if (n.style.display !== 'none') { any = true; break; }
          n = n.nextElementSibling;
        }
        sec.style.display = any ? '' : 'none';
      });
      const empty = document.getElementById('msEmpty');
      if (empty) empty.style.display = shown ? 'none' : '';
    });
  }
  window.__bindMsSearch();
  // openQuickAdd / closeQuickAdd / quickAddSubmit 已由下方 qa-sheet IIFE（v1.37.0）统一提供，
  // 此处不再重复定义旧版，避免 renderShell 调用时覆盖新版实现。
  // 将页面自身的 #pageContent 移入壳的 content-area
  const content = document.getElementById('pageContent');
  if (content) {
    content.style.display = 'block';
    document.querySelector('.content-area').appendChild(content);
  }
  startClock();
  setupGlobalSearch();
  ensureUserInfo();
  // 恢复缓存的功能开关，并异步拉取最新配置
  try { FEATURE_FLAGS = JSON.parse(localStorage.getItem('featureFlags') || 'null'); } catch (e) { }
  applyFeatureFlags();
  loadAppConfig();
  /* 无障碍兜底：补齐表单标签、图标按钮可访问名，并在缺 h1 的页面补一个视觉隐藏的 h1 */
  ensurePageH1(pageTitle);
  a11yFillNames(document);
  startA11yObserver();
  // 全站挂载 AI 内核（异步加载，不阻塞首屏；AI 页面自身不显示悬浮入口）
  mountAiCore(activeKey);
}

/* ---------------- AI 内核挂载（全站共享） ---------------- */
let __aiCoreLoading = null;
function loadAiCore() {
  if (window.AICore) return Promise.resolve(window.AICore);
  if (__aiCoreLoading) return __aiCoreLoading;
  __aiCoreLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/ai-core.js?v=' + APP_VERSION;
    s.onload = () => resolve(window.AICore);
    s.onerror = () => { __aiCoreLoading = null; reject(new Error('ai-core load failed')); };
    document.head.appendChild(s);
  });
  return __aiCoreLoading;
}
async function mountAiCore(activeKey) {
  try {
    const core = await loadAiCore();
    if (!core) return;
    // 首访时 localStorage 无缓存，等配置到位再决定是否显示悬浮入口
    if (!FEATURE_FLAGS) { try { await loadAppConfig(); } catch (e) { } }
    const flags = FEATURE_FLAGS || {};
    await core.mount({
      // 受「系统设置 → AI 悬浮图标」开关控制；AI 小助手页自身不重复显示
      showFloat: flags.showAiFloat !== false,
      isAiPage: activeKey === 'ai',
      onReady: (active) => {
        const f = document.getElementById('aiFloat');
        if (f) f.classList.toggle('off', !active);
      }
    });
  } catch (e) { /* AI 内核加载失败不应影响页面主流程 */ }
}
function toggleMobileMenu() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('show');
}

/* ---------------- 顶栏全局搜索（页面 + 四类业务数据 + P1④ 问驾驶舱） ---------------- */
/* P1④ 自然语言查询「问驾驶舱」：识别问句（末尾问号，或含明确查询意图词），调 /api/ai/ask 拿数据答案 */
let _gsSeq = 0;
function gsIsAsk(raw) {
  if (/[？?]$/.test(raw)) return true;
  return /(花了|支出|开销|花掉)了?\s*(多少|几|几块)|还剩|剩多少|还有几天|几天后|什么时候到期|快到期|哪天到期|下个?周|下星期|本月花了|这个月花了|谁要过生日|有多少待办|几个待办/.test(raw);
}
async function gsRunAsk(input, box) {
  const my = ++_gsSeq;
  box.innerHTML = '<div class="gs-empty gs-loading">加载中…</div>';
  box.style.display = 'block';
  try {
    const r = await apiPost('/api/ai/ask', { q: String(input.value || '').trim().slice(0, 300) });
    if (my !== _gsSeq) return;
    if (r && r.code === 200 && r.data && r.data.answer) {
      const ans = escapeHtml(r.data.answer).replace(/\n/g, '<br>');
      box.innerHTML = '<div class="gs-sec">问驾驶舱</div>'
        + '<div class="gs-answer">' + ans + '</div>'
        + '<div class="gs-ask-foot">' + (r.data.aiUsed ? 'AI 按驾驶舱实时数据回答' : '按驾驶舱数据回答（AI 暂不可用）') + '</div>';
    } else {
      box.innerHTML = '<div class="gs-empty">未能获取答案，换种问法试试</div>';
    }
  } catch (e) { if (my !== _gsSeq) return; box.innerHTML = '<div class="gs-empty">回答出错，请重试</div>'; }
}
function setupGlobalSearch() {
  const input = document.getElementById('globalSearch');
  const box = document.getElementById('gsDropdown');
  const host = document.getElementById('topbarSearch');
  if (!input || !box || !host) return;
  if (input.dataset.bound) return;
  input.dataset.bound = '1';
  let timer = null;

  const hitHtml = (text, kw) => {           // 关键词高亮（先转义再包 <b>，防反射 XSS）
    const t = String(text == null ? '' : text);
    if (!kw) return escapeHtml(t);
    const i = t.toLowerCase().indexOf(kw);
    if (i < 0) return escapeHtml(t);
    return escapeHtml(t.slice(0, i)) + '<b class="gs-hl">' + escapeHtml(t.slice(i, i + kw.length)) + '</b>' + escapeHtml(t.slice(i + kw.length));
  };
  const renderPages = (kw) => {
    const hits = MENU_DEFS.filter(m => !kw || m.label.toLowerCase().includes(kw) || m.group.toLowerCase().includes(kw) || m.href.includes(kw));
    return hits.slice(0, 8).map(m =>
      '<a href="' + m.href + '" class="gs-item"><span class="gs-group">' + escapeHtml(m.group) + '</span><span>' + hitHtml(m.label, kw) + '</span></a>').join('');
  };
  /* dataGroups: [{group:'数据', items:[{type,id,title,snippet,date,href}]}] */
  const renderData = (dataGroups, kw) => (dataGroups || []).map(g =>
    '<div class="gs-sec">' + escapeHtml(g.group) + '</div>' + (g.items || []).map(it =>
      '<a href="' + escapeHtml(it.href) + '" class="gs-item"><span class="gs-group">' + escapeHtml(it.type) + '</span>'
      + '<span>' + hitHtml(it.title, kw) + (it.snippet ? ' · ' + hitHtml(it.snippet, kw) : '') + '</span></a>').join('')).join('');
  const paint = (kw, dataGroups) => {
    const pages = renderPages(kw);
    const data = renderData(dataGroups, kw);
    if (!pages && !data) { box.innerHTML = '<div class="gs-empty">未找到相关数据</div>'; }
    else { box.innerHTML = (pages ? '<div class="gs-sec">页面</div>' + pages : '') + data; }
    box.style.display = 'block';
  };
  const run = async () => {
    const raw = input.value.trim();
    const k = raw.toLowerCase();
    if (!raw) { paint('', []); return; }                     // 空/纯空格：不请求
    if (gsIsAsk(raw)) { await gsRunAsk(input, box); return; } // P1④ 自然语言问句 → 问驾驶舱
    const my = ++_gsSeq;
    box.innerHTML = '<div class="gs-empty gs-loading">加载中…</div>';
    box.style.display = 'block';
    let groups = [];
    try {
      const r = await apiGet('/api/search?kw=' + encodeURIComponent(raw.slice(0, 50)));
      if (my !== _gsSeq) return;                             // 竞态丢弃
      if (r && r.code === 200 && Array.isArray(r.data)) groups = r.data;
    } catch (e) { if (my !== _gsSeq) return; }
    paint(k, groups);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });   // 防抖 300ms
  input.addEventListener('focus', () => { const k = input.value.trim().toLowerCase(); paint(k, []); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {                                 // Enter：跳第一个结果（页面或数据）
      const first = box.querySelector('.gs-item');
      if (first) location.href = first.getAttribute('href');
    } else if (e.key === 'Escape') {
      box.style.display = 'none'; input.blur();
    }
  });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target)) box.style.display = 'none';
  });
}

/* ---------------- 天气 ---------------- */
/* 请求超时信号：优先 AbortSignal.timeout(8s)；旧浏览器无此 API 时返回 undefined（降级为无超时，行为同旧版） */
function weatherTimeoutSignal() {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(8000) : undefined;
}
async function loadWeather(retry = true) {
  const block = document.getElementById('weatherBlock');
  if (!block) return;
  /* 失败/超时：整块隐藏（黄金位不留按钮、不留占位文本），下次进页面自动重试 */
  const hideBlock = () => { block.style.display = 'none'; };
  try {
    let lat = 30.59, lon = 114.30, city = '武汉市';
    try {
      const loc = await fetch('/api/geo', { signal: weatherTimeoutSignal() }).then(r => r.json());
      if (loc && loc.lat) { lat = loc.lat; lon = loc.lon; city = loc.city || city; }
    } catch (e) { /* 定位失败/超时：用默认武汉 */ }
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`, { signal: weatherTimeoutSignal() }).then(r => r.json());
    const temp = Math.round(w.current.temperature_2m);
    const tmax = Math.round(w.daily.temperature_2m_max[0]);
    const tmin = Math.round(w.daily.temperature_2m_min[0]);
    const code = w.current.weather_code;
    const desc = wmoDesc(code), icon = wmoIcon(code);
    block.style.display = '';
    block.innerHTML = `
      <div class="weather-location">${city}</div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
        <span style="font-size:26px;">${icon}</span>
        <span class="weather-desc">${desc}</span>
        <span style="font-size:30px;font-weight:700;">${temp}°</span>
      </div>
      <div style="font-size:12px;opacity:.85;">低温 ${tmin}° / 高温 ${tmax}°</div>`;
  } catch (e) { hideBlock(); }
}
function wmoDesc(code) {
  if (code === 0) return '晴';
  if (code <= 2) return '多云';
  if (code === 3) return '阴';
  if (code <= 48) return '雾';
  if (code <= 57) return '毛毛雨';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  return '强对流';
}
function wmoIcon(code) {
  // 天气图标统一为 Lucide 风格 SVG（蓝色系随 currentColor），不再注入 emoji
  const svg = p => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  if (code === 0) return svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>');
  if (code <= 2) return svg('<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.95 12.65a4 4 0 0 0-5.93-4.13"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>');
  if (code === 3) return svg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>');
  if (code <= 48) return svg('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24"/><path d="M16 17H7"/><path d="M17 21H9"/>');
  if (code <= 67) return svg('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24"/><path d="M16 19v2"/><path d="M8 19v2"/><path d="M12 22v2"/>');
  if (code <= 77) return svg('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24"/><path d="M8 19h.01"/><path d="M12 21h.01"/><path d="M16 19h.01"/><path d="M8 15h.01"/><path d="M16 15h.01"/>');
  return svg('<path d="M6 16.3A5 5 0 0 1 7 6h.5A6 6 0 0 1 19 7.5c1 0 1.8.5 2.4 1.2"/><path d="M13 12l-2 4h4l-2 4"/>');
}

/* ---------------- 通用工具 ---------------- */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 通用组件：Toast ---------------- */
function ensureToastBox() {
  let box = document.getElementById('toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastBox';
    document.body.appendChild(box);
  }
  // 读屏可播报：容器作为 status 区域（polite）
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('aria-atomic', 'false');
  return box;
}
/**
 * 轻提示
 * @param {string} msg 文本
 * @param {string} [type] success | error | warning
 * @param {{actionLabel?:string,onAction?:Function,duration?:number,closable?:boolean}} [opts]
 * @returns {Function} 手动关闭函数
 */
function showToast(msg, type, opts) {
  opts = opts || {};
  const box = ensureToastBox();
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  if (opts.icon) {
    const ic = document.createElement('span');
    ic.className = 'toast-icon';
    ic.innerHTML = opts.icon;
    t.appendChild(ic);
  }
  // 兼容历史调用：msg 里内嵌的 <svg>...</svg> 应渲染为图标，其余按纯文本（避免裸 <svg xmlns=...> 泄漏为可见文本）
  const svgMatch = /<svg[\s\S]*?<\/svg>/.exec(String(msg));
  if (svgMatch && !opts.icon) {
    const ic = document.createElement('span');
    ic.className = 'toast-icon';
    ic.innerHTML = svgMatch[0];
    t.appendChild(ic);
    msg = String(msg).replace(svgMatch[0], '').trim();
  }
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  t.appendChild(text);

  let timer = null;
  const dismiss = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    t.style.opacity = '0'; t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 300);
  };
  const hasAction = opts.actionLabel && typeof opts.onAction === 'function';
  if (hasAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { dismiss(); opts.onAction(); });
    t.appendChild(btn);
  }
  // error 或显式 closable：提供手动关闭
  if (type === 'error' || opts.closable) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'toast-close';
    c.setAttribute('aria-label', '关闭提示');
    c.textContent = '×';
    c.addEventListener('click', dismiss);
    t.appendChild(c);
  }
  box.appendChild(t);
  let duration = opts.duration;
  if (duration == null) duration = (type === 'error') ? 5000 : (hasAction ? 5000 : 2400);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------------- 模态框：Esc / 焦点圈定与归还 / role=dialog ---------------- */
function getFocusable(root) {
  if (!root) return [];
  return Array.prototype.filter.call(
    root.querySelectorAll('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'),
    el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
  );
}
let __activeModal = null;
let __modalLastFocus = null;
function __modalKeydown(e) {
  if (!__activeModal || window.__confirmOpen) return; // 确认弹窗开启时让位
  if (e.key === 'Escape') { e.preventDefault(); closeModal(__activeModal.id); return; }
  if (e.key === 'Tab') {
    const f = getFocusable(__activeModal.querySelector('.modal') || __activeModal);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  __modalLastFocus = document.activeElement;
  const dialog = el.querySelector('.modal') || el;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  el.classList.add('open');
  el.removeAttribute('aria-hidden');
  __activeModal = el;
  document.addEventListener('keydown', __modalKeydown, true);
  const target = el.querySelector('[autofocus]') || getFocusable(dialog)[0] || dialog;
  setTimeout(() => { try { target.focus(); } catch (e) { } }, 40);
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  if (__activeModal === el) {
    __activeModal = null;
    document.removeEventListener('keydown', __modalKeydown, true);
    const back = __modalLastFocus;
    __modalLastFocus = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
      try { back.focus(); } catch (e) { }
    }
  }
  el.setAttribute('aria-hidden', 'true');
}

/* ---------------- 确认弹窗：替代原生 confirm ---------------- */
function confirmTitleOf(msg) {
  if (/删除/.test(msg)) return '删除确认';
  if (/重置/.test(msg)) return '重置确认';
  if (/重新生成/.test(msg)) return '重新生成确认';
  if (/清空|清除/.test(msg)) return '清空确认';
  return '请确认操作';
}
/**
 * Promise 版确认框（替代原生 confirm）
 * @param {string|{title?:string,message?:string,confirmText?:string,cancelText?:string,danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
function confirmModal(opts) {
  if (typeof opts === 'string') opts = { message: opts };
  opts = opts || {};
  const message = opts.message || '确定要继续吗？';
  const danger = opts.danger !== false;
  const title = opts.title || confirmTitleOf(message);
  return new Promise(resolve => {
    window.__confirmOpen = true;
    const lastFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay open';
    overlay.innerHTML =
      '<div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="__cfmTitle" aria-describedby="__cfmMsg">'
      + '<div class="modal-header"><h3 id="__cfmTitle">' + escHtml(title) + '</h3>'
      + '<button type="button" class="modal-close" data-act="cancel" aria-label="关闭">&times;</button></div>'
      + '<div class="modal-body">'
      + '<p class="confirm-msg" id="__cfmMsg">' + escHtml(message) + '</p>'
      + (danger ? '<p class="confirm-note">此操作不可撤销，请谨慎确认。</p>' : '')
      + '</div>'
      + '<div class="modal-footer">'
      + '<button type="button" class="btn btn-secondary" data-act="cancel">' + escHtml(opts.cancelText || '取消') + '</button>'
      + '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' + escHtml(opts.confirmText || '确定') + '</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector('.modal');
    const okBtn = overlay.querySelector('[data-act="ok"]');
    let settled = false;
    function done(val) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      window.__confirmOpen = false;
      if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
        try { lastFocus.focus(); } catch (e) { }
      }
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === 'Tab') {
        const f = getFocusable(dialog);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    overlay.querySelectorAll('[data-act="cancel"]').forEach(b => b.addEventListener('click', () => done(false)));
    okBtn.addEventListener('click', () => done(true));
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { try { okBtn.focus(); } catch (e) { } }, 40);
  });
}
async function confirmDel(msg) { return confirmModal({ message: msg }); }

/* ---------------- 表单字段级校验 ---------------- */
function __fieldErrorId(input) { return (input.id || 'field') + '-error'; }
function setFieldError(input, msg) {
  if (!input) return;
  input.classList.add('input-error');
  input.setAttribute('aria-invalid', 'true');
  const host = input.closest('.form-group') || input.parentElement;
  const id = __fieldErrorId(input);
  let err = document.getElementById(id);
  if (!err || err.parentElement !== host) {
    err = document.createElement('div');
    err.className = 'field-error-msg';
    err.id = id;
    err.setAttribute('role', 'alert');
    host.appendChild(err);
  }
  err.textContent = msg;
  input.setAttribute('aria-describedby', id);
  return false;
}
function clearFieldError(input) {
  if (!input) return;
  input.classList.remove('input-error');
  input.removeAttribute('aria-invalid');
  input.removeAttribute('aria-describedby');
  const err = document.getElementById(__fieldErrorId(input));
  if (err) err.remove();
}
/** 校验单条规则：空值→msg；返回是否通过 */
function validateField(input, rule) {
  if (!input) return true;
  if (!rule) { clearFieldError(input); return true; }
  const val = (input.value || '').trim();
  if (rule.required && !val) return setFieldError(input, rule.emptyMsg || '此项为必填');
  if (val && rule.test && !rule.test(val)) return setFieldError(input, rule.msg || '格式有误');
  clearFieldError(input);
  return true;
}
function fmtMoney(n) {
  return '¥' + (+n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function daysBetween(d1, d2) { return Math.floor((new Date(d2) - new Date(d1)) / 86400000); }

/* =====================================================================
   「记一下」抽屉（quick-add.mjs）—— 按需加载
   ---------------------------------------------------------------------
   这块代码原来就放在本文件末尾，加载即执行。它现在是全站最大的单块前端代码
   （17.7 KB / gzip 6.9 KB），而入口只有两个：tabbar 中央按钮的
   onclick="openQuickAdd()"，和各页面麦克风按钮的 onclick="toggleVoiceInput(this)"。
   用户不点，这 6.9 KB 就白下载了——所以改成 import() 按需拉取。

   三个 window 占位必须存在，原因是调用方是**内联 HTML 属性**：
   renderShell() 拼出来的 fab 带 onclick="openQuickAdd()"，voiceMicHtml()
   拼出来的按钮带 onclick="toggleVoiceInput(this)"。内联属性只在 window 上
   找函数，找不到就静默什么都不发生——没有报错，用户只会觉得"按钮坏了"。

   占位与真身的关系：加载完成后 install() 内部会自己把 window 上的三个名字
   指向真身（见 quick-add.mjs 第 10 步），所以这里加载成功后不需要再赋值，
   只需要在失败时把 __qaLoading 清掉，允许下次重试——不能把失败状态缓存住，
   否则一次网络抖动之后这个按钮就永久失灵。

   关于收益的诚实说明：拆包 + 按需加载让首屏 JS 从 39.8 KB 降到 38.8 KB
   （gzip），只有 1.0 KB。因为 gzip 的滑动窗口不跨文件，6 个文件分别压缩比
   装在一个文件里多花约 2.4 KB。这次改动的真正价值是缓存粒度，不是字节数。
   ===================================================================== */
let __qaLoading = null;

function loadQuickAdd() {
  if (!__qaLoading) {
    __qaLoading = import('/js/quick-add.mjs?v=' + encodeURIComponent(APP_VERSION))
      .then(function (mod) { return mod.default(); })
      .catch(function (e) {
        __qaLoading = null;   // 允许重试
        if (typeof showToast === 'function') {
          showToast('「记一下」加载失败，请重试：' + (e && e.message ? e.message : e), 'error');
        }
        throw e;
      });
  }
  return __qaLoading;
}

window.openQuickAdd = function () {
  loadQuickAdd().then(function (api) { api.openQuickAdd(); });
};
window.closeQuickAdd = function () {
  loadQuickAdd().then(function (api) { api.closeQuickAdd(); });
};
/* toggleVoiceInput 的占位：voice.js 加载时已经挂了一个旧实现到 window 上，
   这里必须再盖一次，否则在 quick-add 加载完成前点麦克风，走的会是旧实现，
   与加载后的行为不一致（旧实现没有 qa-sheet 的双态与 AI 估算）。 */
window.toggleVoiceInput = function (btn) {
  loadQuickAdd().then(function (api) { api.toggleVoiceInput(btn); });
};
