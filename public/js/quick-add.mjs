'use strict';
/* quick-add.mjs —— 「记一下」抽屉（qa-sheet），ESM 模块，按需加载。
 *
 * 由 scripts/split-frontend.py 从 common.js 拆出（原 1266-1622 行），随后改成
 * 按需加载的 ESM 模块（见 scripts/split-frontend.py 末尾的说明）。
 *
 * 为什么按需加载而不是随首屏一起下发：
 *   - 这是全站最大的单块前端代码（17.7 KB / gzip 6.9 KB），而它的入口只有两个：
 *     tabbar 中央按钮的 onclick="openQuickAdd()"，以及各页面麦克风按钮的
 *     onclick="toggleVoiceInput(this)"。用户不点，这 6.9 KB 就白下载了。
 *   - 实测收益：首屏 JS 39.8 KB → 38.8 KB（gzip），只降了 1.0 KB。
 *     原因很反直觉但很重要：gzip 的滑动窗口**不跨文件**。拆成 6 个文件后，
 *     共同的部分（中文提示语、错误文案、SHEET_HTML 里的标签串）在每个文件里
 *     都要各自压一遍。同样的内容装在一个文件里是 29.1 KB，拆开是 31.5 KB，
 *     碎片化代价 2.4 KB，正好吃掉 lazy 收益的一大半。
 *     所以这次拆包的真正价值不是"字节变小"，而是**缓存粒度**：改一行
 *     telemetry.js 不会再让 32 KB 的 common.js 缓存全部失效。
 *
 * 调用方（common.js 里的三个 window 占位）只管调 install()。模块内部保证只
 * 初始化一次：bindDom()/ensureSheet() 本身带幂等守卫，但 install() 也要防重入，
 * 否则第二次 install 会建一套新的闭包状态、对同一批 DOM 元素重复绑定事件，
 * 点一次提交就会发两次请求。
 *
 * ===== UI 交互评审修改（逐条）=====
 * P0-3：补 Esc 关闭 + Tab 焦点圈 + 焦点归还（原先完全无键盘监听）。
 * P1-4：桌面默认键盘态；maxlength 100→300（服务端上限 500）；「今天」胶囊可改基准日期。
 * P1-5：浏览器无 Web Speech 时复用 voice.js 的后端 ASR，统一语音录入行为。
 * P1-6：麦克风 SVG 改 currentColor（跟随主题色）；成功 Toast 的 emoji 换成 uiIcon。
 */


/* ===== qa-sheet 薄荷风双态 IIFE（v1.37.0，覆盖上方旧 openQuickAdd/closeQuickAdd/toggleVoiceInput） =====

/* =====================================================================
 * 任务G：全站「记一下」qa-sheet 双态重构（薄荷健康风）
 * 并入位置：public/js/common.js 末尾（或替换原有 qa-sheet 相关片段）
 * ---------------------------------------------------------------------
 * 保留：FIX-16 recording 红脉冲 + vm-timer 走秒；
 *       FIX-17 全站点中央键(#mtbVoice)都 openQuickAdd；
 *       FIX-35 sheet visibility+opacity+transform 平滑开合（见 theme/）。
 * 复用：openQuickAdd / closeQuickAdd / toggleVoiceInput / quickAddSubmit 名称不变，
 *       老调用方（tabbar #mtbVoice、dashboard tdQuickAdd）无需改动。
 * 接口：不新造 API，提交仍走现有 /api/ask（见 qaSubmit 内 postAsk）。
 * =================================================================== */
let __installed = null;

export default function installQuickAdd() {
  if (__installed) return __installed;

  /* voice.js 的 MediaRecorder → /api/asr 实现。common.js 的占位与本文件末尾的
     真身都会覆盖 window.toggleVoiceInput，所以必须用 voice.js 单独暴露的稳定别名，
     不能在运行时去读 window.toggleVoiceInput。 */
  const backendVoice = (typeof window.__backendVoiceToggle === 'function')
    ? window.__backendVoiceToggle : null;

  /* ---------- 1. 构建/替换 qa-sheet DOM（只建一次） ---------- */
  var SHEET_HTML =
    '<div class="qa-backdrop" id="qaBackdrop">' +
    '  <div class="qa-panel" id="qaPanel" role="dialog" aria-modal="true" aria-label="记一下">' +
    '    <div class="qa-toprow">' +
    '      <button class="qa-chip" id="qaDateChip" type="button" aria-haspopup="dialog" aria-label="选择记录基准日期，当前今天">添加记录 <span id="qaDateLabel">今天</span> <span class="caret">▼</span></button>' +
    '      <input type="date" id="qaDateInput" class="qa-date-native" data-no-dp tabindex="-1" aria-label="记录基准日期">' +
    '      <button class="qa-close" id="qaClose" type="button" aria-label="关闭">✕</button>' +
    '    </div>' +
    '    <div class="qa-guide">一句话记一条，多件事一起说</div>' +
    '    <div class="qa-card">' +
    '      <!-- 语音态 -->' +
    '      <div class="qa-voice-only">' +
    '        <div class="qa-bubble">你可以说：妈妈下周三生日，预算300</div>' +
    '        <div class="qa-bigtext"><span id="qaBigText">长按倾听…</span></div>' +
    '      </div>' +
    '      <!-- 键盘态 -->' +
    '      <div class="qa-kb-only kb-box">' +
    '        <textarea id="qaText" maxlength="300" placeholder="请输入如：妈妈下周三生日，预算300，买束花"></textarea>' +
    '      </div>' +
    '      <div class="qa-swaprow"><button class="qa-swap" id="qaSwap" type="button">⌨ 用键盘</button></div>' +
    '      <div class="qa-kb-only qa-card-foot"><span class="qa-count" id="qaCount">0/300</span></div>' +
    '    </div>' +
    '    <!-- 虚线 + 麦克风（仅语音态） -->' +
    '    <div class="qa-voice-only">' +
    '      <div class="qa-dash"></div>' +
    '      <div class="qa-miczone">' +
    '        <button class="qa-mic-circle" id="qaMic" type="button" aria-label="按住说话" data-target="qaText" data-mode="replace">' +
    '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '            <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none"></rect>' +
    '            <path d="M5 11a7 7 0 0 0 14 0"></path>' +
    '            <line x1="12" y1="18" x2="12" y2="21"></line>' +
    '          </svg>' +
    '        </button>' +
    '        <div class="qa-mic-label">按住说话，松开转写</div>' +
    '      </div>' +
    '    </div>' +
    '    <!-- 键盘态提交 -->' +
    '    <div class="qa-kb-only">' +
    '      <button class="qa-submit" id="qaSubmit" type="button" disabled>开始AI估算</button>' +
    '      <div class="qa-hint">AI 会自动识别事项类型并写入对应模块</div>' +
    '    </div>' +
    '    <!-- 解析预览确认区（提交前展示，确认后才落库） -->' +
    '    <div class="qa-preview" id="qaPreview" style="display:none;">' +
    '      <div class="qa-preview-title">确认要写入以下内容？</div>' +
    '      <div class="qa-preview-list" id="qaPreviewList"></div>' +
    '      <div class="qa-preview-btns">' +
    '        <button class="btn btn-secondary" id="qaCancel" type="button">取消</button>' +
    '        <button class="btn btn-primary" id="qaConfirm" type="button">确认写入</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  function ensureSheet() {
    if (document.getElementById('qaBackdrop')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = SHEET_HTML;
    document.body.appendChild(wrap.firstElementChild);
  }

  /* ---------- 2. 元素句柄与状态 ---------- */
  var backdrop, panel, bigText, ta, countEl, submitBtn, swapBtn, micBtn;
  var timerId = null, seconds = 0, isRecording = false;
  /* P0-3 键盘可达性 / P1-4 基准日期 / P1-5 后端 ASR 兜底 */
  var lastFocus = null, sheetKeyHandler = null;
  var baseDate = '';                 // '' = 今天（服务端 todayStr）
  var resetDateChip = null;
  var usingBackendAsr = false;
  var asrResultListener = null, asrTimeout = null;

  function $(id){ return document.getElementById(id); }

  /* ---------- 3. 开合（FIX-17：全站统一入口；FIX-35 过渡在 CSS） ---------- */
  function openQuickAdd() {
    ensureSheet(); bindDom();
    lastFocus = document.activeElement;
    backdrop.classList.add('qa-show');
    document.body.style.overflow = 'hidden';
    /* P1-4：桌面（鼠标 + 键盘）默认进键盘态。原实现无条件进语音态，
       桌面用户面对「长按倾听…」却只有一个不起眼的「⌨ 用键盘」文字按钮。 */
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      setKeyboardState();
    } else {
      setVoiceState();
    }
    bindSheetKeys();
  }
  function closeQuickAdd() {
    if (!backdrop) return;
    backdrop.classList.remove('qa-show');
    document.body.style.overflow = '';
    unbindSheetKeys();
    stopRecording();
    /* 关闭时清掉后端 ASR 的异步观察器，避免转写回填到已隐藏的抽屉 */
    clearAsrWatchers();
    usingBackendAsr = false;
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* 焦点还原失败不阻塞 */ }
    }
    lastFocus = null;
    // 300ms 延时收尾（沿用原 closeQuickAdd）
    setTimeout(function(){
      ta.value=''; fullTranscript=''; updateCount(); setVoiceState();
      bigText.textContent = '长按倾听…';
      if (resetDateChip) resetDateChip();
    }, 300);
  }

  /* ---------- 3.5 P0-3：Esc 关闭 + Tab 焦点圈 ----------
   * 契约与 uiModal / confirmModal 一致：Esc 可关、Tab 不跑出抽屉、关闭后焦点归还。
   * 用捕获阶段监听，保证 Esc 优先关最上层抽屉（与日期选择器的处理一致）。 */
  function bindSheetKeys() {
    unbindSheetKeys();
    sheetKeyHandler = function (e) {
      /* 更高层的确认框在场时让位，避免 Esc 越级关掉抽屉（与 common.js
         __modalKeydown 的 window.__confirmOpen 让位规则一致）。 */
      if (window.__confirmOpen || document.querySelector('.confirm-overlay.open')) return;
      if (e.key === 'Escape') {
        // 预览确认区打开时，Esc 先退回编辑，不直接丢掉用户已输入的内容
        var pv = $('qaPreview');
        if (pv && pv.style.display === 'block') {
          e.preventDefault(); e.stopPropagation(); cancelAsk(); return;
        }
        e.preventDefault(); e.stopPropagation(); closeQuickAdd(); return;
      }
      if (e.key !== 'Tab' || !panel) return;
      var list = (typeof getFocusable === 'function' ? getFocusable(panel) : [])
        .filter(function (n) { return !n.classList.contains('qa-date-native'); });
      if (!list.length) { e.preventDefault(); return; }
      var first = list[0], last = list[list.length - 1];
      if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', sheetKeyHandler, true);
  }
  function unbindSheetKeys() {
    if (sheetKeyHandler) {
      document.removeEventListener('keydown', sheetKeyHandler, true);
      sheetKeyHandler = null;
    }
  }

  /* ---------- 4. 双态切换 ---------- */
  function setVoiceState() {
    panel.classList.remove('kb');
    swapBtn.innerHTML = uiIcon('keyboard') + ' 用键盘';
    if (!isRecording) bigText.textContent = '长按倾听…';
  }
  function setKeyboardState() {
    panel.classList.add('kb');
    swapBtn.innerHTML = uiIcon('mic') + ' 发语音';
    /* 只在抽屉仍打开时才聚焦：转写回填 / 关闭过程中触发的延时聚焦
       不能把一个已经隐藏的 textarea 抢回焦点。 */
    setTimeout(function(){
      if (ta && backdrop && backdrop.classList.contains('qa-show')) ta.focus();
    }, 250);
  }

  /* ---------- 5. 走秒（FIX-16 vm-timer） ---------- */
  function startTimer() {
    seconds = 0; renderTimer();
    timerId = setInterval(function(){ seconds++; renderTimer(); }, 1000);
  }
  function stopTimer() {
    if (timerId){ clearInterval(timerId); timerId = null; }
  }
  function renderTimer() {
    var m = Math.floor(seconds/60), s = ('0'+(seconds%60)).slice(-2);
    var timerHtml = '<span class="vm-timer">' + m + ':' + s + '</span>';
    // 有实时转写文本时，计时器显示在文本上方，不覆盖转写内容
    var cur = bigText.querySelector('.vm-interim, .vm-final');
    if (cur) {
      bigText.innerHTML = timerHtml + '<br>' + cur.outerHTML;
    } else {
      bigText.innerHTML = timerHtml;
    }
  }

  /* ---------- 6. 录音开关（FIX-16 recording class） ----------
   * P1-5：Web Speech（qa-sheet 实时转写）与 MediaRecorder→/api/asr（内联麦克风）
   * 是两套引擎。原先在 Safari / Firefox 上「按住说话」直接死掉；现在无 Web Speech
   * 时复用 voice.js 暴露的后端 ASR 别名，做到「同一套录音 → 转写 → 回填」，
   * 且不重复实现一份录音代码。 */
  var recognition = (window.SpeechRecognition || window.webkitSpeechRecognition);
  var rec = null;
  var fullTranscript = '';  // 累积的最终识别文本（continuous=false 时需手动累积）

  function ensureRecognition() {
    if (!recognition) return null;
    if (!rec) {
      rec = new recognition();
      rec.lang = 'zh-CN';
      // 移动端 Chrome 上 continuous=true 经常导致 onresult 不触发，改用 false + onend 自动续接
      rec.continuous = false;
      rec.interimResults = true;
      rec.onresult = function(e){
        var interim = '', finalTxt = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var seg = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTxt += seg; else interim += seg;
        }
        if (finalTxt) fullTranscript += finalTxt;
        var display = fullTranscript + interim;
        ta.value = display;
        updateCount();
        // 语音态下把实时转写显示到 bigText，保留已有计时器，避免与 renderTimer 互相覆盖
        if (!panel.classList.contains('kb')) {
          var timerEl = bigText.querySelector('.vm-timer');
          var txtHtml = interim
            ? '<span class="vm-interim">' + escapeHtml(display) + '</span>'
            : '<span class="vm-final">' + escapeHtml(display || '正在聆听…') + '</span>';
          bigText.innerHTML = (timerEl ? timerEl.outerHTML + '<br>' : '') + txtHtml;
        }
      };
      rec.onerror = function(e){
        // 权限拒绝/无网络/不支持时给出明确提示，不要静默失败
        var map = { 'not-allowed':'麦克风权限被拒绝，请在浏览器设置中允许', 'service-not-allowed':'语音服务不可用', 'no-speech':'没听到声音，请再试一次', 'audio-capture':'找不到麦克风设备', 'network':'网络异常，语音识别需要联网' };
        var msg = map[e.error] || ('语音识别出错：' + e.error);
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          if (typeof window.showToast === 'function') window.showToast(msg, 'error');
          bigText.textContent = msg;
        }
      };
      rec.onend = function(){
        // continuous=false 时浏览器会自动结束，若用户仍按住则续接
        if (isRecording) { try{ rec.start(); }catch(e){} }
      };
    }
    return rec;
  }

  function clearAsrWatchers() {
    if (asrResultListener) { ta.removeEventListener('input', asrResultListener); asrResultListener = null; }
    if (asrTimeout) { clearTimeout(asrTimeout); asrTimeout = null; }
  }
  /* 转写完成后收尾：切到键盘态便于确认/提交 */
  function finishAsr(ok) {
    clearAsrWatchers();
    if (!usingBackendAsr) return;
    usingBackendAsr = false;
    updateCount();
    if (ok && ta.value && ta.value.trim()) setKeyboardState();
    else bigText.textContent = '长按倾听…';
  }
  /* voice.js 的 onstop 会异步把文本写进 ta.value 并派发 input 事件 */
  function watchAsrResult() {
    clearAsrWatchers();
    asrResultListener = function () { finishAsr(true); };
    ta.addEventListener('input', asrResultListener);
  }
  /* 录音太短 / 转写失败时不会派发 input，兜底收尾，避免永远停在「正在转写…」 */
  function armAsrTimeout() {
    if (asrTimeout) clearTimeout(asrTimeout);
    asrTimeout = setTimeout(function () { finishAsr(!!(ta.value && ta.value.trim())); }, 12000);
  }
  function callBackendVoice(onFail) {
    try {
      var p = backendVoice(micBtn);
      if (p && typeof p.catch === 'function') p.catch(onFail);
    } catch (e) { onFail(); }
  }
  function abortBackendStart() {
    isRecording = false;
    micBtn.classList.remove('recording');
    stopTimer();
    finishAsr(false);
    bigText.textContent = '录音失败，请用键盘输入';
  }

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    fullTranscript = '';
    micBtn.classList.add('recording');
    bigText.innerHTML = '<span class="vm-final">正在聆听…</span>';
    var r = ensureRecognition();
    if (!r) {
      if (!backendVoice) {
        // 两套引擎都不可用：给出明确提示，不进入录音态
        bigText.textContent = '当前浏览器不支持语音识别，请用键盘输入';
        if (typeof window.showToast === 'function') window.showToast('当前浏览器不支持语音识别', 'warning');
        isRecording = false;
        micBtn.classList.remove('recording');
        return;
      }
      // 后端 ASR 是「点一下开始 / 再点一下停止」的 toggle 语义；
      // pointerdown 起录、pointerup 停录正好对应两次调用。
      usingBackendAsr = true;
      watchAsrResult();
      callBackendVoice(abortBackendStart);
      startTimer();
      return;
    }
    try { r.start(); }
    catch (e) {
      // start() 抛异常通常是因为上一次还没结束，稍等重试
      setTimeout(function(){ try{ rec.start(); }catch(e2){} }, 200);
    }
    startTimer();
  }
  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    micBtn.classList.remove('recording');
    stopTimer();
    if (usingBackendAsr && backendVoice) {
      bigText.innerHTML = '<span class="vm-final">正在转写…</span>';
      armAsrTimeout();
      callBackendVoice(function () { finishAsr(false); });
      return;
    }
    var r = ensureRecognition();
    if (r){ try{ r.stop(); }catch(e){} }
    // 录音结束后：若识别到文本，自动切到键盘态便于确认/提交
    if (ta.value && ta.value.trim()) setKeyboardState();
    else bigText.textContent = '长按倾听…';
  }

  // 暴露给老代码：toggleVoiceInput 保持原语义（点一下开/再点关，桌面兼容）
  function toggleVoiceInput() {
    if (isRecording) stopRecording(); else startRecording();
  }

  /* ---------- 7. 0/300 计数 + 提交按钮可用性 ---------- */
  function updateCount() {
    var n = ta.value.length;
    countEl.textContent = n + '/300';
    submitBtn.disabled = (n === 0);
  }

  /* ---------- 8. 提交：两阶段——先 dryRun 解析出预览，用户确认后再落库 ---------- */
  var PENDING = null; // { text, items, summary }
  var TYPE_TAG = { task:'事务', scheduled:'循环', anniversary:'纪念日', ledger:'记账', gift:'人情', expiry:'临期', note:'随手记' };
  function itemLine(it) {
    var tag = TYPE_TAG[it.type] || it.type;
    var desc = it.title || it.name || it.content || it.eventType || it.remark || '';
    var when = it.date || it.expiryDate || '';
    if (it.amount) desc += '（¥' + it.amount + (it.kind === 'income' ? ' 收' : ' 支') + '）';
    return '<li><span class="qa-tag">' + tag + '</span><span class="qa-line">' + escapeHtml(desc || '(空)') + '</span>' + (when ? '<span class="qa-when">' + escapeHtml(when) + '</span>' : '') + '</li>';
  }
  function postAsk(text) {
    if (!text) return;
    submitBtn.disabled = true;
    // 阶段一：解析（不落库）
    fetch('/api/ai/quick-add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text: text, dryRun: true, baseDate: baseDate || undefined })
    }).then(function(r){ return r.json(); })
      .then(function(data){
        submitBtn.disabled = false;
        if (!data || data.code !== 200 || !data.data) {
          if (typeof window.showToast === 'function') window.showToast((data && data.message) || '识别失败，请重试', 'error');
          return;
        }
        var d = data.data;
        var items = d.items || [];
        if (!items.length) { if (typeof window.showToast === 'function') window.showToast('未能识别内容', 'error'); return; }
        PENDING = { text: text, items: items, summary: d.summary || '' };
        var list = document.getElementById('qaPreviewList');
        /* P0-1：AI 没解析成功时（兜底成一条事务）必须醒目提示，别让用户以为识别成功 */
        var FB = { none:'未配置 AI，将按事务记录', bad_model:'AI 配置有误，将按事务记录', ai_error:'AI 暂不可用，将按事务记录' };
        var head = document.getElementById('qaPreview');
        var warnEl = head.querySelector('.qa-fallback-warn');
        if (d.fallback) {
          if (!warnEl) { warnEl = document.createElement('div'); warnEl.className = 'qa-fallback-warn'; head.insertBefore(warnEl, head.firstChild); }
          warnEl.textContent = FB[d.fallbackReason] || FB.ai_error;
        } else if (warnEl) { warnEl.remove(); }
        list.innerHTML = '<ul>' + items.map(itemLine).join('') + '</ul>';
        /* 上一轮若因「部分写入失败」禁用了确认按钮，新一轮解析成功必须恢复 */
        var qc = document.getElementById('qaConfirm');
        if (qc) qc.disabled = false;
        head.style.display = 'block';
      })
      .catch(function(){
        submitBtn.disabled = false;
        if (typeof window.showToast === 'function') window.showToast('网络异常，请重试', 'error');
      });
  }
  // 阶段二：确认写入（回显 items，不再走 AI）
  function confirmAsk() {
    if (!PENDING) return;
    var payload = { text: PENDING.text, items: PENDING.items, summary: PENDING.summary, baseDate: baseDate || undefined };
    document.getElementById('qaConfirm').disabled = true;
    fetch('/api/ai/quick-add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }).then(function(r){ return r.json(); })
      .then(function(data){
        document.getElementById('qaConfirm').disabled = false;
        /* 服务端返回非 200：保留 PENDING，用户可直接重试同一批内容 */
        if (!data || data.code !== 200 || !data.data) {
          if (typeof window.showToast === 'function') window.showToast((data && data.message) || '写入失败，请重试', 'error');
          return;
        }
        var d = data.data;
        var all = d.failed || [];
        var failed = all.filter(function(f){ return !f.skipped; });
        var merged = all.filter(function(f){ return f.skipped; });
        /* P0：部分条目未落库时不能无脑提示「已写入」并刷新页面——
           那会让用户永远不知道哪几条丢了。改为就地列出失败清单。 */
        if (failed.length) {
          var head = document.getElementById('qaPreview');
          var list = document.getElementById('qaPreviewList');
          var rows = failed.map(function(f){
            return '<li><span class="qa-tag">' + escapeHtml(f.type || '未识别') + '</span>'
              + '<span class="qa-line">' + escapeHtml((f.title || '(无标题)') + ' · ' + (f.reason || '未写入')) + '</span></li>';
          }).join('');
          list.innerHTML = '<div class="qa-fallback-warn">请求 ' + (d.requested || 0) + ' 项，已写入 '
            + (d.createdCount || 0) + ' 项，以下 ' + failed.length + ' 项未能写入，请调整说法后重新录入：</div>'
            + '<ul>' + rows + '</ul>';
          head.style.display = 'block';
          PENDING = null;               // 防止重复确认导致已成功项被二次写入
          document.getElementById('qaConfirm').disabled = true;
          if (typeof window.showToast === 'function') window.showToast('部分内容未能写入，请查看清单', 'error');
          return;
        }
        PENDING = null;
        document.getElementById('qaPreview').style.display = 'none';
        /* P2-8：去掉 emoji，改用与全站一致的 uiIcon 图标体系 */
        if (typeof window.showToast === 'function') {
          window.showToast('已写入 ' + (d.createdCount || 0) + ' 项'
            + (merged.length ? '（自动合并 ' + merged.length + ' 项）' : ''), 'success', {
            icon: (typeof uiIcon === 'function' ? uiIcon('check') : '')
          });
        }
        closeQuickAdd();
        setTimeout(function(){ location.reload(); }, 700);
      })
      .catch(function(){
        document.getElementById('qaConfirm').disabled = false;
        if (typeof window.showToast === 'function') window.showToast('网络异常，请重试', 'error');
      });
  }
  function cancelAsk() {
    PENDING = null;
    document.getElementById('qaPreview').style.display = 'none';
  }

  /* ---------- 9. 事件绑定 ---------- */
  function bindDom() {
    if (backdrop) return; // 已绑
    backdrop = $('qaBackdrop'); panel = $('qaPanel'); bigText = $('qaBigText');
    ta = $('qaText'); countEl = $('qaCount'); submitBtn = $('qaSubmit');
    swapBtn = $('qaSwap'); micBtn = $('qaMic');

    $('qaClose').addEventListener('click', closeQuickAdd);
    backdrop.addEventListener('click', function(e){ if (e.target === backdrop) closeQuickAdd(); });

    /* P1-4：把原本静态写死的「添加记录 今天 ▼」变成可改的基准日期。
       选中的日期随 dryRun / 落库请求一起发给服务端，用于换算「明天 / 下周三」等相对日期。 */
    var dateChip = $('qaDateChip'), dateInput = $('qaDateInput'), dateLabel = $('qaDateLabel');
    function isoLocal(d) {
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    function applyDate(v) {
      baseDate = /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';
      var now = new Date();
      var tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      var todayIso = isoLocal(now), tomorrowIso = isoLocal(tmr);
      var label = (!baseDate || baseDate === todayIso) ? '今天'
        : (baseDate === tomorrowIso ? '明天' : baseDate.slice(5).replace('-', '/'));
      dateLabel.textContent = label;
      dateChip.setAttribute('aria-label', '选择记录基准日期，当前' + label);
    }
    dateChip.addEventListener('click', function () {
      // showPicker 需要用户手势；不支持或抛错时退回 focus + click 唤起原生控件
      try {
        if (typeof dateInput.showPicker === 'function') dateInput.showPicker();
        else { dateInput.focus(); dateInput.click(); }
      } catch (e) { dateInput.focus(); dateInput.click(); }
    });
    dateInput.addEventListener('change', function () { applyDate(dateInput.value); });
    resetDateChip = function () { dateInput.value = ''; applyDate(''); };
    applyDate('');

    // 切换态
    swapBtn.addEventListener('click', function(){
      if (panel.classList.contains('kb')) setVoiceState(); else setKeyboardState();
    });

    // 计数
    ta.addEventListener('input', updateCount);

    // 按住说话（pointer 统一鼠标/触摸；touch-action:none 已在 CSS）
    micBtn.addEventListener('pointerdown', function(e){ e.preventDefault(); startRecording(); });
    micBtn.addEventListener('pointerup',   function(){ stopRecording(); });
    micBtn.addEventListener('pointerleave', function(){ if (isRecording) stopRecording(); });
    micBtn.addEventListener('pointercancel',function(){ if (isRecording) stopRecording(); });
    // 桌面端兼容：无 pointer 时退回 click 开/关
    micBtn.addEventListener('click', function(){
      if (!('onpointerdown' in window)) toggleVoiceInput();
    });

    // 提交
    submitBtn.addEventListener('click', function(){
      var txt = ta.value.trim();
      if (!txt) return;
      submitBtn.disabled = true;
      postAsk(txt);
    });

    // 解析预览：确认写入 / 取消
    var qc = document.getElementById('qaConfirm');
    var qx = document.getElementById('qaCancel');
    if (qc) qc.addEventListener('click', confirmAsk);
    if (qx) qx.addEventListener('click', cancelAsk);

    // tabbar 中央语音按钮（FIX-17：全站统一）
    var mtb = $('mtbVoice');
    if (mtb) mtb.addEventListener('click', openQuickAdd);
  }

  /* ---------- 10. 挂全局 + 建 DOM（原来这段在脚本加载时就跑，现在推迟到 install()） ---------- */
  /* 三个 window 赋值保留：common.js 的懒加载占位在 install() 成功后也会写同样的值，
     两边写同一个函数引用，谁写都不改变行为。真正需要保留的是"挂上"这个动作本身——
     页面上还有 onclick="toggleVoiceInput(this)" 这类内联属性，靠的是 window 上有名。 */
  window.openQuickAdd = openQuickAdd;
  window.closeQuickAdd = closeQuickAdd;
  window.toggleVoiceInput = toggleVoiceInput;

  /* 原来这里按 document.readyState 分两种时机初始化。改成 install() 之后时机已经
     确定（一定在页面加载完成之后，因为是用户点击触发的），直接建即可。
     ensureSheet()/bindDom() 都有幂等守卫，重复调用不会重复绑事件。 */
  ensureSheet();
  bindDom();

  const api = { openQuickAdd: openQuickAdd, closeQuickAdd: closeQuickAdd, toggleVoiceInput: toggleVoiceInput };
  __installed = api;
  return api;
}
