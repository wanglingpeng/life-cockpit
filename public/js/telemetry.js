'use strict';
/* telemetry.js —— 由 scripts/split-frontend.py 从 public/js/common.js 拆出。
 *
 * 原位置：common.js 第 1731-1815 行（1.48.38 版，85 行）。
 * 加载顺序：common.js → lunar.js → voice.js → quick-add.js → pwa.js → telemetry.js
 *
 * 前端埋点（使用洞察）：批次上报行为计数 + 平台识别。 * 只做计数，不采集内容/隐私数据；失败静默。
 */

/* ================================================================
 * 前端埋点（使用洞察）：批次上报行为计数 + 平台识别
 *  - 只做计数，不采集任何内容/隐私数据
 *  - 失败静默；服务端可整体关闭（settings.telemetry === false）
 *  - 页面可直接调 window.LSTrack('xxx') 补充自定义动作
 * ================================================================ */
(function usageTelemetry() {
  'use strict';

  function platform() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
    return 'desktop';
  }
  // 是否以「已安装的 PWA」形态运行（装到主屏后打开为 standalone）
  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  var queue = {};      // action -> count
  var timer = null;

  function flush() {
    timer = null;
    var items = Object.keys(queue).map(function (k) { return { action: k, count: queue[k] }; });
    if (!items.length) return;
    queue = {};
    try {
      fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items, platform: platform() }),
        keepalive: true
      }).catch(function () { });
    } catch (e) { }
  }
  function track(action) {
    if (!action) return;
    queue[action] = (queue[action] || 0) + 1;
    if (!timer) timer = setTimeout(flush, 3000);
  }
  // 关页面/切后台时兜底发一次
  window.addEventListener('pagehide', function () { if (timer) { clearTimeout(timer); flush(); } });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); flush(); }
  });
  window.LSTrack = track;
  window.LSIsStandalone = isStandalone;

  // 页面浏览埋点：用 <body data-page="ledger"> 或路径名推断
  try {
    var path = (location.pathname || '/').replace(/^\//, '').replace(/\.html$/, '') || 'dashboard';
    var pageKey = document.body && document.body.getAttribute('data-page');
    track('page.view.' + (pageKey || path));
    if (isStandalone()) track('pwa.standalone');
  } catch (e) { }

  // 语音输入（Web Speech）使用埋点：拦截一次即可
  try {
    var SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SRC) {
      var Wrapped = function () {
        var inst = new SRC();
        inst.addEventListener('start', function () { track('ai.voice'); });
        return inst;
      };
      Wrapped.prototype = SRC.prototype;
      if (window.SpeechRecognition) window.SpeechRecognition = Wrapped;
      if (window.webkitSpeechRecognition) window.webkitSpeechRecognition = Wrapped;
    }
  } catch (e) { }

  // 推送点开埋点：URL 带 ?from=push 进来即计数
  try {
    if (/[?&]from=push\b/.test(location.search)) track('push.click');
  } catch (e) { }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { if (timer) { clearTimeout(timer); flush(); } });
  } else if (timer) { clearTimeout(timer); flush(); }
})();
