'use strict';
/* voice.js —— 由 scripts/split-frontend.py 从 public/js/common.js 拆出。
 *
 * 原位置：common.js 第 333-474 行（1.48.38 版，142 行）。
 * 加载顺序：common.js → lunar.js → voice.js → quick-add.js → pwa.js → telemetry.js
 *
 * 语音输入：麦克风采集 + AI 填表。 * 必须排在 common.js 之后、quick-add.js 之前—— * quick-add 会用自己实现的 toggleVoiceInput 覆盖 window.toggleVoiceInput。
 */

let __voiceRec = null;
function voiceSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
/* FIX-16：中央大按钮(mtbVoice)录音态联动 + qa-title 旁只读走秒 */
let __vmTimerInt = null, __vmSecs = 0;
function __mtbVoiceRec(on) { const m = document.getElementById('mtbVoice'); if (m) m.classList.toggle('recording', !!on); }
function __vmTimerStart() {
  const el = document.getElementById('vmTimer');
  if (!el) return;
  __vmSecs = 0; el.textContent = '0:00'; el.style.display = 'inline-block';
  if (__vmTimerInt) clearInterval(__vmTimerInt);
  __vmTimerInt = setInterval(() => {
    __vmSecs++;
    el.textContent = Math.floor(__vmSecs / 60) + ':' + pad2(__vmSecs % 60);
  }, 1000);
}
function __vmTimerStop() {
  if (__vmTimerInt) { clearInterval(__vmTimerInt); __vmTimerInt = null; }
  const el = document.getElementById('vmTimer');
  if (el) { el.style.display = 'none'; el.textContent = ''; }
}
function voiceMicHtml(targetId, opts) {
  const o = opts || {};
  return '<button type="button" class="voice-mic" data-target="' + targetId + '" data-mode="' + (o.mode || 'append') + '"'
    + (o.ai ? ' data-ai="' + o.ai + '"' : '')
    + ' title="语音录入" aria-label="语音录入" onclick="toggleVoiceInput(this)">'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg><span class="vm-wave" aria-hidden="true"><i></i><i></i><i></i></span></button>';
}
// 占位 hydration：页面弹窗标记可能出现在 common.js 之前，
// 页面里放 <script data-voice-mic data-target="xx" data-mode=".." data-ai=".."></script>，这里统一换成麦克风按钮
(function hydrateVoiceMics() {
  const run = () => document.querySelectorAll('script[data-voice-mic]').forEach(s => {
    const span = document.createElement('span');
    span.innerHTML = voiceMicHtml(s.dataset.target, { mode: s.dataset.mode || 'append', ai: s.dataset.ai || '' });
    s.replaceWith(span);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
// 录音状态：__voiceRec 存 MediaRecorder 句柄
window.toggleVoiceInput = async function (btn) {
  // 再次点击 = 停止录音并上传转写
  if (__voiceRec) {
    try { __voiceRec.stop(); } catch (e) {}
    return;
  }
  const target = document.getElementById(btn.dataset.target);
  if (!target) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('当前浏览器不支持录音，请用 Chrome / Edge', 'warning'); return;
  }
  let stream, recorder, chunks = [];
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showToast('麦克风权限被拒绝，请在浏览器地址栏允许', 'error'); return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  try { recorder = new MediaRecorder(stream, { mimeType: mime }); }
  catch (e) { showToast('录音器初始化失败', 'error'); stream.getTracks().forEach(t=>t.stop()); return; }
  __voiceRec = recorder;
  const mode = btn.dataset.mode || 'append';
  const isEditable = target.isContentEditable;
  const isValue = !isEditable && target.value !== undefined;
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstart = () => {
    btn.classList.add('recording'); __mtbVoiceRec(true); __vmTimerStart();
    /* UI 评审 P1-5：这套录音器既被内联麦克风（点击切换）复用，也被 qa-sheet
       在「无 Web Speech」时复用（按住说话、松开结束）。文案必须同时适用于两种手势，
       原先「说完再点一下」在按住说话场景下是错的。 */
    showToast('录音中，松开或再点一下结束', 'info', { icon: uiIcon('mic') });
  };
  recorder.onstop = async () => {
    btn.classList.remove('recording'); __mtbVoiceRec(false); __vmTimerStop();
    __voiceRec = null;
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    chunks = [];
    if (blob.size < 1000) { showToast('录音太短，请多说几个字', 'warning'); return; }
    showToast('⏳ 转写中…', 'info');
    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        const r = await fetch('/api/asr', { method: 'POST', headers: {'Content-Type':'application/json', 'X-Requested-With':'XMLHttpRequest'}, body: JSON.stringify({ audio: reader.result }) });
        const j = await r.json();
        if (!j || j.code !== 200) { showToast('转写失败：' + (j?.error || r.status), 'error'); return; }
        const text = (j.data?.text || '').trim();
        if (!text) { showToast('没识别到内容，请再试一次', 'warning'); return; }
        // 填回输入框
        if (isEditable) {
          try {
            target.focus();
            const sel = window.getSelection();
            const rng = document.createRange(); rng.selectNodeContents(target); rng.collapse(false);
            sel.removeAllRanges(); sel.addRange(rng);
            document.execCommand('insertText', false, text);
          } catch (e) { target.textContent += text; }
        } else if (isValue) {
          target.value = (mode === 'replace' ? '' : target.value) + (mode !== 'replace' && target.value ? ' ' : '') + text;
          target.focus();
          if (target.setSelectionRange) target.setSelectionRange(target.value.length, target.value.length);
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        if (btn.dataset.ai) voiceAiFill(btn.dataset.ai, text);
      } catch (e) { showToast('转写请求失败：' + e.message, 'error'); }
    };
    reader.readAsDataURL(blob);
  };
  try { recorder.start(); } catch (e) { showToast('录音启动失败', 'error'); stream.getTracks().forEach(t=>t.stop()); __voiceRec = null; }
};
/* UI 评审 P1-5：common.js 的懒加载占位与 quick-add.mjs 的真身都会覆盖
   window.toggleVoiceInput。这里留一份稳定别名，供 qa-sheet 在无 Web Speech 的
   浏览器（Safari / Firefox）上复用同一套 MediaRecorder → /api/asr 录音转写，
   避免「同一个语音录入」出现两套引擎、两套反馈与不同的可用性。 */
window.__backendVoiceToggle = window.toggleVoiceInput;
const VOICE_AI_PROMPTS = {
  ledger: function () {
    return '从这句话中提取记账信息，只输出一个 JSON 对象，不要输出任何其他文字：'
      + '{"kind":"expense或income","amount":数字金额,"date":"YYYY-MM-DD，相对日期如明天/后天按今天' + todayStr() + '推算","remark":"摘要短句","category":"支出分类猜测如餐饮/交通/购物/人情/居住"}。未提到的字段填 null。句子：';
  },
  tasks: function () {
    return '从这句话中提取待办事项信息，只输出一个 JSON 对象，不要输出任何其他文字：'
      + '{"title":"事项名","date":"YYYY-MM-DD，相对日期按今天' + todayStr() + '推算","remindTime":"HH:MM 或 null","remark":"备注或 null"}。句子：';
  }
};
async function voiceAiFill(kind, text) {
  const build = VOICE_AI_PROMPTS[kind];
  if (!build) return;
  let act = null;
  try {
    const pr = await apiGet('/api/ai/providers');
    act = (pr.data || []).find(p => p.enabled && p.hasKey);
  } catch (e) { /* 忽略 */ }
  if (!act) return; // AI 未配置：只保留转写文本
  showToast('AI 正在解析语音…', '', { icon: uiIcon('bot') });
  try {
    const r = await apiPost('/api/ai/complete', {
      prompt: build() + text,
      system: '你是信息抽取器。只输出 JSON 本体，禁止输出解释、markdown 代码块标记。',
      temperature: 0.1
    });
    if (r.code !== 200) { showToast('AI 解析失败：' + (r.message || ''), 'warning'); return; }
    let raw = String(r.data.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const data = JSON.parse(m ? m[0] : raw);
    if (typeof window.applyVoiceFill === 'function') window.applyVoiceFill(kind, data);
    else showToast('AI 解析完成，但当前页面不支持自动填充', 'warning');
  } catch (e) {
    showToast('AI 解析失败：' + (e.message || e), 'warning');
  }
}
