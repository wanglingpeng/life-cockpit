'use strict';
/* pwa.js —— 由 scripts/split-frontend.py 从 public/js/common.js 拆出。
 *
 * 原位置：common.js 第 1624-1729 行（1.48.38 版，106 行）。
 * 加载顺序：common.js → lunar.js → voice.js → quick-add.js → pwa.js → telemetry.js
 *
 * PWA 引导：manifest 注入 + Service Worker 注册 + 安装引导。 * 非安全上下文静默跳过；幂等，重复注册无害。每个页面都要生效。
 */

/* ================================================================
 * PWA 引导（路线 A 第 4 步）：manifest 注入 + Service Worker 注册 + 安装引导
 *  - 非安全上下文（http://192.168.x.x）静默跳过；HTTPS 或 localhost 才生效
 *  - 幂等：link/meta 只注入一次；SW 重复注册无害
 * ================================================================ */
(function pwaBootstrap() {
  'use strict';

  function secure() {
    return location.protocol === 'https:' ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function injectHeads() {
    var doc = document;
    if (!doc.querySelector('link[rel="manifest"]')) {
      var m = doc.createElement('link');
      m.rel = 'manifest'; m.href = '/manifest.webmanifest';
      doc.head.appendChild(m);
    }
    if (!doc.querySelector('link[rel="apple-touch-icon"]')) {
      var a = doc.createElement('link');
      a.rel = 'apple-touch-icon'; a.href = '/icons/icon-192.png';
      doc.head.appendChild(a);
    }
    if (!doc.querySelector('link[rel="icon"]')) {
      var f = doc.createElement('link');
      f.rel = 'icon'; f.href = '/icons/icon-192.png'; f.type = 'image/png';
      doc.head.appendChild(f);
    }
    var tc = doc.querySelector('meta[name="theme-color"]');
    if (!tc) {
      tc = doc.createElement('meta');
      tc.name = 'theme-color';
      doc.head.appendChild(tc);
    }
    // 跟随主题：data-theme-color 落地后取 --primary 实际色值
    requestAnimationFrame(function () {
      var v = getComputedStyle(doc.documentElement).getPropertyValue('--primary').trim();
      if (v) tc.setAttribute('content', v);
    });
  }

  /* 安装引导横幅：捕获 beforeinstallprompt；一次性引导——点过「安装」或「✕」后 localStorage 永久不再弹出。
     移动端为停靠在底部 tabbar 之上的全宽细条，出现时给 body 加 has-install-bar 让 FAB 上移避让；
     桌面端直接贴底（bottom:0），不再悬浮遮挡页面底部内容。 */
  var deferredPrompt = null;
  function installBanner() {
    if (localStorage.getItem('pwaInstallDismissed') === '1') return;
    var bar = document.createElement('div');
    bar.id = 'pwaInstallBar';
    var isMobile = window.matchMedia && matchMedia('(max-width: 768px)').matches;
    var bottom = isMobile ? 'calc(64px + env(safe-area-inset-bottom))' : '0';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:' + bottom + ';'
      + 'z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 14px;'
      + 'background:#0f172a;color:#fff;font-size:13px;box-shadow:0 -2px 12px rgba(15,23,42,.18);';
    bar.innerHTML = '<span style="display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/></svg> 装到桌面，全屏离线可用</span>';
    var yes = document.createElement('button');
    yes.textContent = '安装';
    yes.style.cssText = 'border:none;border-radius:8px;padding:5px 14px;font-size:13px;font-weight:700;background:#0ea5e9;color:#fff;cursor:pointer;flex:none;';
    var no = document.createElement('button');
    no.textContent = '✕';
    no.setAttribute('aria-label', '关闭');
    no.style.cssText = 'border:none;background:transparent;color:#94a3b8;font-size:14px;cursor:pointer;flex:none;padding:4px;';
    var hideBar = function () {
      bar.remove();
      try { document.body.classList.remove('has-install-bar'); } catch (e) { }
    };
    var dismissForever = function () {
      hideBar();
      try { localStorage.setItem('pwaInstallDismissed', '1'); } catch (e) { }
    };
    yes.addEventListener('click', function () {
      dismissForever();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
    });
    no.addEventListener('click', dismissForever);
    bar.appendChild(yes); bar.appendChild(no);
    document.body.appendChild(bar);
    try { document.body.classList.add('has-install-bar'); } catch (e) { }
    // 8 秒未处理自动收起（不打扰），仅本次会话
    setTimeout(hideBar, 8000);
  }

  function boot() {
    injectHeads();
    if (!secure() || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
      console.warn('[PWA] SW 注册失败（不影响使用）:', err && err.message);
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      // 避免与首次引导撞车：延迟 3 秒再出横幅
      setTimeout(function () {
        if (!deferredPrompt) return;
        if (!document.getElementById('pwaInstallBar')) installBanner();
      }, 3000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
