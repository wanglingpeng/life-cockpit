/* 生活驾驶舱 Service Worker（零依赖、无构建步骤）
 * 策略：
 *  - /api/*        永不拦截（鉴权/SSE/实时数据直连）
 *  - /uploads/ 等私有路径  完全不拦截，交给服务端逐次鉴权
 *  - 页面导航       network-first（离线回落缓存 → offline.html）
 *  - 白名单静态资源（/css/ /js/ /icons/ /fonts/ + 少数根文件）cache-first
 *  - 其他同源 GET   network-first
 * 升级：改 PWA_VERSION 即全员换新缓存，旧缓存 activate 时清除
 *
 * P0-3 安全修复：旧版用「扩展名」判断可缓存资源，导致 /uploads/xxx.png
 * 也走 cache-first。SW 先查本地缓存，命中就直接返回，服务端那段
 * 「未登录 401 + Cache-Control: private」根本没机会执行——用户退出后，
 * 同一浏览器仍能从缓存里读到证件/合同扫描件。现在改为路径白名单 +
 * 显式排除私有路径 + 不缓存 private/no-store 响应。
 */
const PWA_VERSION = 'v72';
const OFFLINE_URL = '/offline.html';
const PUBLIC_ASSET_RE = /^\/(css|js|icons|fonts|avatars)\//;
const PUBLIC_ROOT_FILES = new Set(['/favicon.ico', '/manifest.webmanifest', '/offline.html']);
const PRIVATE_PATH_RE = /^\/(uploads|data|backup|backups|exports)\//i;

/* 服务端标记为私有/禁缓存的响应，绝不写入 Cache Storage */
function cacheable(res) {
  const cc = String((res && res.headers && res.headers.get('Cache-Control')) || '').toLowerCase();
  return !/private|no-store/.test(cc);
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open('shell-' + PWA_VERSION);
    await c.add(OFFLINE_URL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set(['shell-' + PWA_VERSION, 'asset-' + PWA_VERSION, 'page-' + PWA_VERSION]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // 跨域直连
  if (url.pathname.startsWith('/api/')) return;    // API 永不缓存
  /* 私有文件必须每次走服务端鉴权：SW 一旦介入（哪怕只是查缓存），
     就可能把上一次登录时缓存的敏感附件在退出后继续吐出来。 */
  if (PRIVATE_PATH_RE.test(url.pathname)) return;

  // 页面导航：network-first → 缓存 → offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && cacheable(fresh)) {
          const c = await caches.open('page-' + PWA_VERSION);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match(req, { ignoreSearch: false });
        if (cached) return cached;
        const shell = await caches.match(OFFLINE_URL);
        return shell || new Response('离线且无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 公开静态资源：cache-first（URL 带 ?v=，内容变更时键必变）
  if (PUBLIC_ASSET_RE.test(url.pathname) || PUBLIC_ROOT_FILES.has(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic' && cacheable(fresh)) {
          const c = await caches.open('asset-' + PWA_VERSION);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 其余同源 GET（无版本号页面资源等）：network-first
  e.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
