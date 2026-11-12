/* =====================================================================
   生活驾驶舱 · AI 内核（全站共享）
   - AI 模型配置（多连接 + 全局设置，OpenAI 兼容）：设置弹窗，可从任意页面打开
   - 流式对话 stream() / 单次补全 complete()
   - 右下角悬浮入口 + 右侧抽屉对话
   - 页面上下文感知 + 页面级 AI 动作菜单
   依赖：common.js（apiGet/apiPut/apiPost/getToken/getUsername/showToast）
   注意：必须显式挂到 window —— 经典脚本里的顶层 const 不产生 window 属性，
        页面与 common.js 都通过 window.AICore 探测就绪状态。
   ===================================================================== */
window.AICore = (function () {
  const S = {
    cfg: null, connections: [], active: null, busy: false, currentChatId: null,
    mounted: false, drawerOpen: false, inited: false
  };

  /* ---------------- 小工具 ---------------- */
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 极简 Markdown（先转义再解析，杜绝注入）
  function mdToHtml(src) {
    const raw = String(src == null ? '' : src);
    const lines = escHtml(raw).split('\n');
    let html = '', inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
    const inline = t => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*(\d+)[.、]\s+(.*)$/);
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (ul) { if (inOl) { html += '</ol>'; inOl = false; } if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + inline(ul[1]) + '</li>'; }
      else if (ol) { if (inUl) { html += '</ul>'; inUl = false; } if (!inOl) { html += '<ol>'; inOl = true; } html += '<li>' + inline(ol[2]) + '</li>'; }
      else if (h) { closeLists(); html += '<h4>' + inline(h[1]) + '</h4>'; }
      else if (!line.trim()) closeLists();
      else { closeLists(); html += '<p>' + inline(line) + '</p>'; }
    }
    closeLists();
    return html || '<p></p>';
  }
  // 前端净化：AI 回复插入到富文本编辑器前再洗一遍（三趟处理，避免 live 集合与递归陷阱）
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    const root = tpl.content;
    const BAD = /^(script|style|iframe|object|embed|link|meta|svg|math|form|input|button|textarea|select)$/i;

    // ① 移除危险元素（拆包会暴露新节点，循环到稳定为止）
    for (let i = 0; i < 20; i++) {
      const bad = [...root.querySelectorAll('*')].filter(el => BAD.test(el.tagName));
      if (!bad.length) break;
      bad.forEach(el => el.remove());
    }
    // ② 属性过滤：事件属性一律去掉，href/src 只允许 http(s) 与站内相对路径
    [...root.querySelectorAll('*')].forEach(el => {
      [...el.attributes].forEach(a => {
        const n = a.name.toLowerCase();
        const v = String(a.value || '');
        if (n.startsWith('on')) { el.removeAttribute(a.name); return; }
        if (n === 'href' || n === 'src') {
          if (/^\s*(javascript|data|vbscript):/i.test(v)) { el.removeAttribute(a.name); return; }
          if (n === 'src' && !/^(https?:|\/)/i.test(v)) { el.removeAttribute(a.name); return; }
        }
        if (n === 'style') el.removeAttribute(a.name);
      });
    });
    // ③ 无效链接拆包（保留文字），有效链接补 target/rel
    [...root.querySelectorAll('a')].forEach(a => {
      if (a.getAttribute('href')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else {
        const frag = document.createDocumentFragment();
        while (a.firstChild) frag.appendChild(a.firstChild);
        a.replaceWith(frag);
      }
    });
    return tpl.innerHTML;
  }

  /* ---------------- AI 配置（v48：多连接 + 全局设置） ---------------- */
  /* 并发调用共享同一次请求（mount 与页面 init 会几乎同时触发，避免 /api/ai/config 重复拉取） */
  let __providersLoading = null;
  async function loadProviders() {
    if (__providersLoading) return __providersLoading;
    __providersLoading = (async () => {
      try {
        const r = await apiGet('/api/ai/config');
        const d = (r && r.data) || {};
        S.cfg = d;
        S.connections = d.connections || [];
        const keyed = S.connections.filter(c => c.hasKey);
        S.active = keyed.find(c => c.id === d.defaultId) || keyed[0] || null;
      } catch (e) { S.cfg = null; S.connections = []; S.active = null; }
      return S.active;
    })();
    try { return await __providersLoading; } finally { __providersLoading = null; }
  }
  function providerLabel() { return S.active ? S.active.label + ' · ' + (S.active.textModel || S.active.visionModel || '未填模型') : '未配置'; }
  /* P0-1：S.active 只代表「默认且已配 Key」，不代表模型名没写错。
     无效模型名会让每次调用 404，必须单独标出来。 */
  function providerHealth() {
    if (!S.active) return { ok: false, warn: false, text: '未配置' };
    if (S.active.modelValid === false) return { ok: false, warn: true, text: '模型名有误' };
    return { ok: true, warn: false, text: providerLabel() };
  }

  // 有可用连接返回 true；否则提示并打开设置
  async function ensureProvider() {
    if (!S.cfg) await loadProviders();
    if (S.active) return true;
    showToast('还没有配置 AI 连接，先填个 API Key 吧', 'warning');
    openSettings();
    return false;
  }

  /* ---------------- 流式对话 ---------------- */
  function parseSSE(text, handlers) {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch (e) { continue; }
      if (j.error) { handlers.onError && handlers.onError(j.error); continue; }
      if (j.chatId && handlers.onMeta) handlers.onMeta(j);
      if (j.delta) handlers.onDelta && handlers.onDelta(j.delta);
    }
  }
  async function stream(opts) {
    const o = opts || {};
    const resp = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },   // 鉴权走同源 HttpOnly cookie
      body: JSON.stringify({ message: o.message, chatId: o.chatId || null, context: o.context || contextOf() })
    });
    if (!resp.ok || !resp.body) {
      let msg = 'AI 服务不可用（' + resp.status + '）';
      try { const j = await resp.json(); if (j && j.message) msg = j.message; } catch (e) { }
      o.onError && o.onError(msg);
      o.onDone && o.onDone('');
      return '';
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.error) { o.onError && o.onError(j.error); continue; }
        if (j.chatId && o.onMeta) o.onMeta(j);
        if (j.delta) { full += j.delta; o.onDelta && o.onDelta(j.delta, full); }
      }
    }
    o.onDone && o.onDone(full);
    return full;
  }
  /* ---------------- 单次补全 ---------------- */
  async function complete(opts) {
    const o = opts || {};
    const r = await apiPost('/api/ai/complete', {
      prompt: o.prompt, system: o.system || '', context: o.context || contextOf(), temperature: o.temperature
    });
    if (!r || r.code !== 200) throw new Error((r && r.message) || 'AI 调用失败');
    return r.data.text;
  }

  /* ---------------- 页面上下文 ---------------- */
  function pageKey() { return document.body.dataset.aiPage || ''; }
  function pageTitle() { return document.body.dataset.aiPageTitle || document.title || ''; }
  function contextOf() {
    const key = pageKey(), title = pageTitle();
    const extra = (PAGE_CONTEXT_EXTRA[key] && PAGE_CONTEXT_EXTRA[key]()) || '';
    return (title ? '「' + title + '」页面' : '') + (extra ? '，' + extra : '');
  }
  // 各页面可注册「当前正在做什么」的动态补充
  const PAGE_CONTEXT_EXTRA = {};
  function registerContext(key, fn) { PAGE_CONTEXT_EXTRA[key] = fn; }

  /* ---------------- 页面级动作 ---------------- */
  const PAGE_ACTIONS = {
    dashboard: [
      { icon: '🌅', label: '今天先做什么', prompt: '结合我今天的待办、循环事务和证件效期临期物品，帮我排出今天的处理顺序，并说明为什么这么排。' }
    ],
    tasks: [
      { icon: '📋', label: '帮我排优先级', prompt: '把我今天和本周的事务按重要性排出优先级，指出哪些必须今天完成。' },
      { icon: '✍️', label: '教我怎么建事务', prompt: '我想新增一条事务，帮我把需要填的字段（标题、日期、提醒时间、状态、备注）列成清单。' }
    ],
    'scheduled-tasks': [
      { icon: '🔁', label: '哪些该做了', prompt: '我的循环事务里哪些已经逾期或快到点了？按紧急程度排序并给出建议。' }
    ],
    notes: [
      { icon: '📝', label: '帮我写一篇', prompt: '帮我写一篇家庭生活备忘的草稿，主题是：' },
      { icon: '🔍', label: '总结我的笔记', prompt: '根据我最近的笔记，帮我总结我最近在关注什么。' }
    ],
    family: [
      { icon: '👨‍👩‍👧', label: '家人近期提醒', prompt: '接下来 30 天家里有哪些生日和纪念日？分别需要准备什么？' }
    ],
    anniversaries: [
      { icon: '💖', label: '纪念日提醒与准备', prompt: '最近有哪些纪念日？帮我规划怎么准备，给出具体可执行的建议。' }
    ],
    ledger: [
      { icon: '💰', label: '分析本月支出', prompt: '帮我分析本月支出的结构和趋势，指出可以优化的地方，并给出具体的省多少钱的建议。' }
    ],
    'gift-records': [
      { icon: '🎁', label: '人情往来分析', prompt: '帮我分析人情往来的收支情况，哪些人需要回礼、哪些关系往来不平衡。' }
    ],
    expiries: [
      { icon: '📦', label: '临期物品怎么办', prompt: '档案库里哪些东西快到期了？按紧急程度给出处理建议。' }
    ],
    location: [
      { icon: '📍', label: '行程小结', prompt: '帮我总结最近的轨迹记录，看看我的活动范围和规律。' }
    ],
    footprint: [
      { icon: '🏆', label: '足迹解读', prompt: '根据我的足迹数据，帮我总结去过的地方和规律，给点旅行建议。' }
    ],
    vault: [
      { icon: '🔐', label: '到期证件提醒', prompt: '保险库里哪些证件、保单或会员卡快到期了？提醒我该办什么。' }
    ],
    mortgage: [
      { icon: '🏠', label: '贷款方案建议', prompt: '帮我对比等额本息和等额本金，结合我记录的贷款方案给出建议。' }
    ],
    'general-config': [
      { icon: '🔗', label: '怎么对接外部系统', prompt: '我想把外部系统接进生活驾驶舱，帮我讲讲 AppKey/AppSecret 和订阅链接怎么用。' }
    ],
    'help-center': [
      { icon: '🧭', label: '帮我介绍功能', prompt: '介绍一下生活驾驶舱各个功能模块分别解决什么问题，我该按什么顺序上手。' }
    ]
  };
  function actionsOf(key) { return PAGE_ACTIONS[key || pageKey()] || []; }

  /* ---------------- 设置弹窗（全站共享，v48 两区：连接配置 + 模型配置） ---------------- */
  let onProviderChange = null;
  function setProviderChangeHandler(fn) { onProviderChange = fn; }
  /* 连接/配置变化后的统一同步：刷新抽屉标签与欢迎语（无人注册外部钩子也能自洽） */
  function notifyProviderChange() {
    const tag = document.getElementById('aiDrawerTag');
    if (tag) {
      const h = providerHealth();
      tag.textContent = h.text;
      tag.classList.toggle('none', !S.active);
      tag.classList.toggle('warn', !!h.warn);
      if (h.warn) tag.title = '模型名无效，AI 调用会失败，点右侧 ⚙ 修正';
      else tag.removeAttribute('title');
    }
    const body = document.getElementById('aiDrawerBody');
    if (S.drawerOpen && body && body.dataset.built && !body.querySelector('.chat-msg')) drawerWelcome();
    if (typeof onProviderChange === 'function') onProviderChange(S.active);
  }
  const SCENE_ORDER = ['chat', 'insights', 'quickadd', 'receipt'];
  const SCENE_LABELS = { chat: 'AI 对话', insights: '首页洞察', quickadd: '一句话录入·AI 建档', receipt: '票据识别' };

  function ensureSettingsModal() {
    if (document.getElementById('aiCfgModal')) return;
    const el = document.createElement('div');
    el.id = 'aiCfgModal';
    el.className = 'modal-overlay';
    el.innerHTML =
      '<div class="modal" style="max-width:560px;">'
      + '<div class="modal-header"><h3>AI 模型配置</h3>'
      + '<button class="modal-close" data-close aria-label="关闭">&times;</button></div>'
      + '<div class="modal-body">'
      + '<h4 class="ai-cfg-sec">连接配置</h4>'
      + '<div id="aiConnList"></div>'
      + '<button class="btn btn-secondary ai-conn-add" id="aiConnAddBtn">＋ 添加连接配置</button>'
      + '<h4 class="ai-cfg-sec">模型配置</h4>'
      + '<p class="ai-cfg-note">API Key 加密存到本机数据库，仅本人可见；所有连接均为 OpenAI 兼容接口，场景未指定时使用默认连接。</p>'
      + '<div id="aiCfgForm"></div>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn btn-secondary" data-close>完成</button></div>'
      + '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      if (e.target === el || e.target.hasAttribute('data-close')) closeSettings();
      else if (e.target.closest('#aiConnAddBtn')) openConnEditor(null);
    });
  }
  function connCard(c) {
    const card = document.createElement('div');
    card.className = 'ai-conn';
    const head = document.createElement('div'); head.className = 'ai-conn-head';
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = c.label;
    head.appendChild(nm);
    if (S.cfg && S.cfg.defaultId === c.id) { const b = document.createElement('span'); b.className = 'ai-conn-badge default'; b.textContent = '默认'; head.appendChild(b); }
    const kb = document.createElement('span');
    kb.className = 'ai-conn-badge ok';
    kb.textContent = c.builtin ? '内置' : (c.hasKey ? '✓ 已配 Key' : '未配 Key');
    head.appendChild(kb);
    card.appendChild(head);
    const meta = document.createElement('div'); meta.className = 'ai-conn-meta';
    meta.textContent = c.baseUrl || '（未填 API 地址）';
    card.appendChild(meta);
    const chips = document.createElement('div'); chips.className = 'ai-conn-chips';
    [['文本', c.textModel], ['视觉', c.visionModel]].forEach(p => {
      const chip = document.createElement('span'); chip.className = 'ai-conn-chip';
      chip.textContent = p[0] + '：' + (p[1] || '未填');
      chips.appendChild(chip);
    });
    card.appendChild(chips);
    // P0-1：模型名无效时直接标出，避免「界面显示已配置但调用永远失败」
    if (c.modelValid === false && c.textModel) {
      const w = document.createElement('div'); w.className = 'ai-prov-warn';
      w.textContent = '⚠️ 文本模型名「' + c.textModel + '」疑似无效，调用会失败，请编辑修正';
      card.appendChild(w);
    }
    const foot = document.createElement('div'); foot.className = 'ai-conn-foot';
    (c.builtin ? [['测试', 'test']] : [['编辑', 'edit'], ['测试', 'test'], ['删除', 'del']]).forEach(p => {
      const b = document.createElement('button');
      b.className = 'btn ' + (p[1] === 'del' ? 'btn-danger' : 'btn-secondary') + ' btn-sm';
      b.type = 'button';
      b.textContent = p[0];
      b.addEventListener('click', () => {
        if (p[1] === 'edit') openConnEditor(c);
        else if (p[1] === 'test') testConnQuick(c, b);
        else delConn(c);
      });
      foot.appendChild(b);
    });
    card.appendChild(foot);
    return card;
  }
  function renderConnList() {
    const box = document.getElementById('aiConnList');
    if (!box) return;
    box.innerHTML = '';
    const conns = S.connections || [];
    if (!conns.length) {
      const p = document.createElement('p');
      p.className = 'ai-conn-empty';
      p.textContent = '还没有连接配置，点下方按钮添加第一份。';
      box.appendChild(p);
      return;
    }
    conns.forEach(c => box.appendChild(connCard(c)));
  }
  function renderCfgForm() {
    const box = document.getElementById('aiCfgForm');
    if (!box) return;
    const d = S.cfg || {};
    const conns = S.connections || [];
    box.innerHTML = '';
    const rowOf = (labelText, ctrl) => {
      const row = document.createElement('div'); row.className = 'ai-scene-row';
      const lb = document.createElement('label'); lb.textContent = labelText;
      row.appendChild(lb); row.appendChild(ctrl); box.appendChild(row);
    };
    const connOption = (sel, c) => {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.label + (c.hasKey ? '' : '（未配 Key）');
      sel.appendChild(o);
    };
    const syncSel = sel => { if (sel.selectedIndex < 0) sel.value = ''; };
    // 启用 AI 总开关
    const swWrap = document.createElement('label'); swWrap.className = 'switch'; swWrap.style.margin = '0';
    const sw = document.createElement('input'); sw.type = 'checkbox'; sw.checked = d.enabled !== false;
    const slider = document.createElement('span'); slider.className = 'slider';
    swWrap.appendChild(sw); swWrap.appendChild(slider);
    rowOf('启用 AI', swWrap);
    // 默认连接
    const defSel = document.createElement('select');
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = '自动（第一个已配 Key 的连接）'; defSel.appendChild(auto);
    conns.forEach(c => connOption(defSel, c));
    defSel.value = d.defaultId === null || d.defaultId === undefined ? '' : String(d.defaultId);
    syncSel(defSel);
    rowOf('默认连接', defSel);
    // 单次请求超时
    const toInp = document.createElement('input');
    toInp.type = 'number'; toInp.min = '30'; toInp.max = '3600'; toInp.step = '10';
    toInp.value = d.timeoutSec || 120;
    rowOf('单次请求超时（秒）', toInp);
    // 场景覆盖
    const sceneSels = {};
    const labels = d.sceneLabels || SCENE_LABELS;
    SCENE_ORDER.forEach(k => {
      const sel = document.createElement('select');
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '继承默认连接'; sel.appendChild(o0);
      conns.forEach(c => connOption(sel, c));
      sel.value = (d.scenes && d.scenes[k]) ? String(d.scenes[k]) : '';
      syncSel(sel);
      sceneSels[k] = sel;
      rowOf(labels[k] || k, sel);
    });
    // 保存（模型配置区整体一个保存）
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary ai-cfg-save'; saveBtn.type = 'button'; saveBtn.textContent = '保存模型配置';
    saveBtn.addEventListener('click', async () => {
      const body = {
        enabled: sw.checked,
        defaultId: defSel.value === '' ? null : +defSel.value,
        timeoutSec: parseInt(toInp.value, 10) || 120,
        scenes: {}
      };
      Object.keys(sceneSels).forEach(k => { body.scenes[k] = sceneSels[k].value === '' ? '' : +sceneSels[k].value; });
      const r = await apiPut('/api/ai/config', body);
      if (!r || r.code !== 200) { showToast((r && r.message) || '保存失败', 'error'); return; }
      await refreshCfg();
      showToast('AI 设置已保存');
      notifyProviderChange();
    });
    box.appendChild(saveBtn);
  }
  async function refreshCfg() {
    await loadProviders();
    renderConnList();
    renderCfgForm();
  }

  /* ---- 二级弹窗：添加 / 编辑连接 ---- */
  let connEditing = null;
  function ensureConnModal() {
    if (document.getElementById('aiConnModal')) return;
    const el = document.createElement('div');
    el.id = 'aiConnModal';
    el.className = 'modal-overlay';
    el.innerHTML =
      '<div class="modal" style="max-width:520px;">'
      + '<div class="modal-header"><h3 id="aiConnModalTitle">添加连接配置</h3>'
      + '<button class="modal-close" data-close aria-label="关闭">&times;</button></div>'
      + '<div class="modal-body">'
      + '<div class="ai-conn-fld"><label>名称预设</label><select id="aiConnPreset"></select></div>'
      + '<div class="ai-conn-fld" id="aiConnNameFld" style="display:none;"><label>连接名称</label><input type="text" id="aiConnName" maxlength="20" placeholder="如：本地 Ollama"></div>'
      + '<div class="ai-conn-fld"><label>API 地址</label><input type="text" id="aiConnBase" placeholder="https://api.deepseek.com"></div>'
      + '<div class="ai-conn-fld"><label>API Key</label><input type="password" id="aiConnKey" autocomplete="new-password" placeholder="粘贴 API Key"></div>'
      + '<div class="ai-conn-fld"><label>文本模型</label><span class="ai-conn-model-row"><input type="text" id="aiConnTextModel" list="aiModelDlText" placeholder="如 deepseek-chat"><button class="btn btn-secondary btn-sm" id="aiConnTextRefresh" type="button" title="从服务拉取模型列表">↻ 拉取</button></span></div>'
      + '<datalist id="aiModelDlText"></datalist>'
      + '<div class="ai-conn-fld"><label>视觉模型（看图用，可空）</label><span class="ai-conn-model-row"><input type="text" id="aiConnVisionModel" list="aiModelDlVision" placeholder="如 qwen-vl-plus"><button class="btn btn-secondary btn-sm" id="aiConnVisionRefresh" type="button" title="从服务拉取模型列表">↻ 拉取</button></span></div>'
      + '<datalist id="aiModelDlVision"></datalist>'
      + '<div class="ai-conn-test-row">'
      + '<button class="btn btn-secondary btn-sm" id="aiConnTestQuick" type="button">快速测试</button>'
      + '<button class="btn btn-secondary btn-sm" id="aiConnTestFull" type="button">完整测试</button>'
      + '</div>'
      + '<div class="ai-conn-test-msg" id="aiConnTestMsg"></div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn btn-secondary" data-close>取消</button>'
      + '<button class="btn btn-primary" id="aiConnSave" type="button">保存连接</button>'
      + '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      if (e.target === el || e.target.hasAttribute('data-close')) { el.classList.remove('open'); return; }
      if (e.target.closest('#aiConnSave')) saveConn();
      else if (e.target.closest('#aiConnTestQuick')) testConnForm('quick');
      else if (e.target.closest('#aiConnTestFull')) testConnForm('full');
      else if (e.target.closest('#aiConnTextRefresh')) loadModelList('aiConnTextModel', 'aiModelDlText');
      else if (e.target.closest('#aiConnVisionRefresh')) loadModelList('aiConnVisionModel', 'aiModelDlVision');
    });
    // 名称预设：选即自动填地址/模型；自定义时露出名称输入框
    document.getElementById('aiConnPreset').addEventListener('change', () => {
      const p = presetOf(document.getElementById('aiConnPreset').value);
      const nameFld = document.getElementById('aiConnNameFld');
      if (p) {
        document.getElementById('aiConnBase').value = p.baseUrl || '';
        document.getElementById('aiConnTextModel').value = p.model || '';
        nameFld.style.display = 'none';
      } else nameFld.style.display = '';
    });
  }
  function presetOf(id) { return ((S.cfg && S.cfg.presets) || []).find(p => p.id === id) || null; }
  function setTestMsg(kind, text) {
    const el = document.getElementById('aiConnTestMsg');
    if (!el) return;
    el.className = 'ai-conn-test-msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }
  function openConnEditor(c) {
    ensureConnModal();
    connEditing = c || null;
    const el = document.getElementById('aiConnModal');
    const presets = (S.cfg && S.cfg.presets) || [];
    const sel = document.getElementById('aiConnPreset');
    sel.innerHTML = '';
    presets.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); });
    const oc = document.createElement('option'); oc.value = 'custom'; oc.textContent = 'OpenAI 兼容自定义'; sel.appendChild(oc);
    const nameFld = document.getElementById('aiConnNameFld');
    const nameInp = document.getElementById('aiConnName');
    const keyInp = document.getElementById('aiConnKey');
    keyInp.value = '';
    keyInp.placeholder = (c && c.hasKey) ? '•••••••• 已加密保存（留空则不修改）' : '粘贴 API Key';
    if (c) {
      const matched = presets.find(p => p.baseUrl === c.baseUrl);
      if (matched) { sel.value = matched.id; nameFld.style.display = 'none'; }
      else { sel.value = 'custom'; nameFld.style.display = ''; nameInp.value = c.label; }
      document.getElementById('aiConnBase').value = c.baseUrl || '';
      document.getElementById('aiConnTextModel').value = c.textModel || '';
      document.getElementById('aiConnVisionModel').value = c.visionModel || '';
      document.getElementById('aiConnModalTitle').textContent = '编辑连接：' + c.label;
    } else {
      const p0 = presets[0];
      if (p0) { sel.value = p0.id; document.getElementById('aiConnBase').value = p0.baseUrl || ''; document.getElementById('aiConnTextModel').value = p0.model || ''; nameFld.style.display = 'none'; }
      else { sel.value = 'custom'; nameFld.style.display = ''; document.getElementById('aiConnBase').value = ''; document.getElementById('aiConnTextModel').value = ''; }
      nameInp.value = '';
      document.getElementById('aiConnVisionModel').value = '';
      document.getElementById('aiConnModalTitle').textContent = '添加连接配置';
    }
    setTestMsg('', '');
    el.classList.add('open');
  }
  function connFormBody() {
    const p = presetOf(document.getElementById('aiConnPreset').value);
    return {
      label: p ? p.label : document.getElementById('aiConnName').value.trim(),
      baseUrl: document.getElementById('aiConnBase').value.trim(),
      textModel: document.getElementById('aiConnTextModel').value.trim(),
      visionModel: document.getElementById('aiConnVisionModel').value.trim(),
      key: document.getElementById('aiConnKey').value.trim()
    };
  }
  async function saveConn() {
    const f = connFormBody();
    if (!f.label) return setTestMsg('err', '请填写连接名称');
    if (!/^https?:\/\//i.test(f.baseUrl)) return setTestMsg('err', 'API 地址需以 http(s):// 开头');
    if (!f.textModel && !f.visionModel) return setTestMsg('err', '请至少填写文本模型或视觉模型');
    const body = { label: f.label, baseUrl: f.baseUrl, textModel: f.textModel, visionModel: f.visionModel };
    if (f.key) body.apiKey = f.key;
    let r;
    if (connEditing) r = await apiPut('/api/ai/connections/' + connEditing.id, body);
    else {
      if (!f.key) return setTestMsg('err', '请填写 API Key');
      r = await apiPost('/api/ai/connections', body);
    }
    if (!r || r.code !== 200) return setTestMsg('err', (r && r.message) || '保存失败');
    document.getElementById('aiConnModal').classList.remove('open');
    await refreshCfg();
    showToast(connEditing ? '连接已保存' : '连接已添加');
    notifyProviderChange();
  }
  async function testConnForm(mode) {
    const f = connFormBody();
    if (!f.textModel) return setTestMsg('err', '请先填写文本模型');
    setTestMsg('', '测试中…');
    const body = { mode, baseUrl: f.baseUrl, textModel: f.textModel };
    if (connEditing) body.id = connEditing.id;
    if (f.key) body.apiKey = f.key;
    const r = await apiPost('/api/ai/connections/test', body);
    const d = (r && r.data) || {};
    if (r && r.code === 200 && d.ok) setTestMsg('ok', mode === 'full' && d.reply ? ('回复：' + d.reply) : ('连接正常（' + (d.ms || 0) + 'ms）'));
    else setTestMsg('err', d.message || (r && r.message) || '测试失败');
  }
  async function loadModelList(inputId, dlId) {
    const f = connFormBody();
    if (!f.baseUrl) return setTestMsg('err', '请先填写 API 地址');
    setTestMsg('', '拉取模型列表中…');
    const body = { baseUrl: f.baseUrl };
    if (connEditing) body.connId = connEditing.id;
    if (f.key) body.apiKey = f.key;
    const r = await apiPost('/api/ai/models', body);
    const ids = (r && r.code === 200 && r.data && r.data.models) || null;
    const dl = document.getElementById(dlId);
    dl.innerHTML = '';
    if (!ids) return setTestMsg('err', (r && r.message) || '拉取模型列表失败');
    ids.forEach(id => { const o = document.createElement('option'); o.value = id; dl.appendChild(o); });
    setTestMsg('ok', '已拉取 ' + ids.length + ' 个模型，点击输入框可下拉选择');
  }
  async function testConnQuick(c, btn) {
    btn.disabled = true; const old = btn.textContent; btn.textContent = '测试中…';
    try {
      const r = await apiPost('/api/ai/connections/test', { id: c.id, mode: 'quick' });
      const d = (r && r.data) || {};
      if (r && r.code === 200 && d.ok) showToast('连接正常（' + (d.ms || 0) + 'ms）');
      else showToast('连接失败：' + (d.message || (r && r.message) || '未知原因'), 'error');
    } finally { btn.disabled = false; btn.textContent = old; }
  }
  async function delConn(c) {
    // UI 评审 P0-2：原生 confirm 阻塞线程、不可主题化，且与全站 confirmModal 的
    // 焦点圈 / Esc / 焦点归还体验割裂。本页加载了 common.js，可直接用全局 confirmModal。
    const ok = await confirmModal({
      title: '删除连接',
      message: '删除连接「' + c.label + '」？其 API Key 将一并删除。',
      confirmText: '删除'
    });
    if (!ok) return;
    const r = await apiDelete('/api/ai/connections/' + c.id);
    if (!r || r.code !== 200) { showToast((r && r.message) || '删除失败', 'error'); return; }
    await refreshCfg();
    showToast('连接已删除');
    notifyProviderChange();
  }

  async function openSettings() {
    ensureSettingsModal();
    await loadProviders();
    renderConnList();
    renderCfgForm();
    document.getElementById('aiCfgModal').classList.add('open');
  }
  function closeSettings() {
    const el = document.getElementById('aiCfgModal');
    if (el) el.classList.remove('open');
    loadProviders().then(() => notifyProviderChange());
  }

  /* ---------------- 悬浮入口 + 抽屉 ---------------- */
  function ensureFloat() {
    if (document.getElementById('aiFloat')) return;
    const b = document.createElement('button');
    b.id = 'aiFloat';
    b.className = 'ai-float';
    b.title = 'AI 小助手（可拖动）';
    b.setAttribute('aria-label', '打开 AI 小助手');
    b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg><span class="ai-float-dot"></span>';
    b.addEventListener('click', () => { if (!floatDragged()) toggleDrawer(); });
    document.body.appendChild(b);
    initFloatDrag(b);
  }
  /* 拖放：任意位置摆放，localStorage 记忆；按下移动超过 6px 视为拖拽（不触发点击） */
  let __floatMoved = false;
  function floatDragged() { return __floatMoved; }
  function initFloatDrag(b) {
    const KEY = 'aiFloatPos';
    // 恢复上次位置
    try {
      const p = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') setPos(p.x, p.y);
    } catch (e) { /* 忽略 */ }
    function clamp(x, y) {
      const r = b.getBoundingClientRect();
      const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
      return {
        x: Math.min(Math.max(4, x), w - r.width - 4),
        y: Math.min(Math.max(4, y), h - r.height - 4)
      };
    }
    function setPos(x, y) {
      const c = clamp(x, y);
      b.style.right = 'auto'; b.style.bottom = 'auto';
      b.style.left = c.x + 'px'; b.style.top = c.y + 'px';
    }
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    b.addEventListener('pointerdown', e => {
      if (e.button) return;
      const r = b.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = true; __floatMoved = false;
      b.classList.add('dragging');
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    b.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!__floatMoved && Math.hypot(dx, dy) < 6) return;
      __floatMoved = true;
      setPos(ox + dx, oy + dy);
      e.preventDefault();
    });
    b.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      b.classList.remove('dragging');
      if (__floatMoved) {
        const r = b.getBoundingClientRect();
        try { localStorage.setItem(KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (err) { /* 忽略 */ }
        e.preventDefault(); e.stopPropagation();
      }
    });
    b.addEventListener('pointercancel', () => { dragging = false; b.classList.remove('dragging'); });
    // 视口变化（转屏/缩放）时把球收回可视区
    window.addEventListener('resize', () => {
      if (b.style.left) {
        const r = b.getBoundingClientRect();
        setPos(r.left, r.top);
      }
    });
  }
  function ensureDrawer() {
    if (document.getElementById('aiDrawer')) return;
    const d = document.createElement('div');
    d.id = 'aiDrawer';
    d.className = 'ai-drawer';
    d.innerHTML =
      '<div class="ai-drawer-backdrop" data-close></div>'
      + '<aside class="ai-drawer-panel" role="dialog" aria-label="AI 小助手">'
      + '<div class="ai-drawer-head">'
      + '<span class="t"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg> AI 小助手</span>'
      + '<span class="ai-provider-tag none" id="aiDrawerTag">未配置</span>'
      + '<button class="icon-btn" data-new title="新对话" aria-label="新对话">✚</button>'
      + '<button class="icon-btn" data-cfg title="AI 模型配置" aria-label="AI 模型配置">⚙</button>'
      + '<button class="icon-btn" data-close title="关闭" aria-label="关闭">✕</button>'
      + '</div>'
      + '<div class="ai-drawer-actions" id="aiDrawerActions"></div>'
      + '<div class="ai-drawer-body" id="aiDrawerBody"></div>'
      + '<div class="ai-drawer-input">'
      + '<input type="text" id="aiDrawerInput" placeholder="问任何问题…" maxlength="4000" autocomplete="off">'
      + '<button class="btn btn-primary btn-sm" id="aiDrawerSend">发送</button>'
      + '</div>'
      + '<div class="ai-drawer-foot">AI 生成内容仅供参考，请自行核对重要信息</div>'
      + '</aside>';
    document.body.appendChild(d);
    d.addEventListener('click', e => {
      if (e.target === d || e.target.hasAttribute('data-close') || e.target.closest('[data-close]')) { toggleDrawer(false); return; }
      if (e.target.closest('[data-cfg]')) { openSettings(); return; }
      if (e.target.closest('[data-new]')) { drawerNewChat(); return; }
    });
    document.getElementById('aiDrawerSend').addEventListener('click', drawerSend);
    const inp = document.getElementById('aiDrawerInput');
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); drawerSend(); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.drawerOpen) toggleDrawer(false);
    });
  }
  /* ---------------- 快捷动作图标映射（渲染层：emoji -> Lucide SVG，不改业务数据） ---------------- */
  const CHIP_ICON_SVG = {
    '🌅': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
    '📋': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>',
    '✍': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    '🔁': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    '📝': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    '🔍': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    '👨‍👩‍👧': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    '💖': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    '💰': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>',
    '🎁': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>',
    '📦': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    '📍': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    '🏆': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    '🔐': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    '🏠': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    '🔗': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    '🧭': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>'
  };
  function chipIcon(e) { return CHIP_ICON_SVG[String(e).replace(/\ufe0f/g, '')] || ''; }
  function renderDrawerActions() {
    const box = document.getElementById('aiDrawerActions');
    const acts = actionsOf();
    if (!acts.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = acts.map((a, i) => '<button class="ai-chip" data-i="' + i + '">' + chipIcon(a.icon) + ' ' + escHtml(a.label) + '</button>').join('');
    box.querySelectorAll('.ai-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = acts[+btn.dataset.i];
        if (a.apply) { a.apply(); return; }          // 页面自定义动作（如插入编辑器）
        drawerQuickAsk(a.prompt);
      });
    });
  }
  function drawerWelcome() {
    const body = document.getElementById('aiDrawerBody');
    const acts = actionsOf();
    body.innerHTML = '<div class="ai-drawer-welcome">'
      + '<div class="bot"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg></div>'
      + '<h4>嗨！' + escHtml(getUsername()) + '</h4>'
      + '<p>我知道你正在「' + escHtml(pageTitle()) + '」页面' + (S.active ? '' : '，但还没配置 AI 连接') + '。' +
      (acts.length ? '试试上面的快捷动作，或直接提问。' : '直接提问即可。') + '</p>'
      + (S.active ? '' : '<button class="btn btn-primary btn-sm" id="aiDrawerCfgBtn" style="margin-top:8px;">去配置 API Key</button>')
      + '</div>';
    const cb = document.getElementById('aiDrawerCfgBtn');
    if (cb) cb.addEventListener('click', openSettings);
  }
  function drawerMsg(role, text) {
    const body = document.getElementById('aiDrawerBody');
    const box = body.querySelector('.ai-drawer-msgs') || (() => {
      body.innerHTML = '<div class="ai-drawer-msgs"></div>';
      return body.querySelector('.ai-drawer-msgs');
    })();
    const m = document.createElement('div');
    m.className = 'chat-msg ' + role;
    m.innerHTML = '<div class="chat-avatar">' + (role === 'ai' ? 'AI' : escHtml(getUsername().charAt(0).toUpperCase())) + '</div><div class="chat-bubble"></div>';
    const bub = m.querySelector('.chat-bubble');
    if (role === 'ai') bub.innerHTML = mdToHtml(text); else bub.textContent = text;
    box.appendChild(m);
    body.scrollTop = body.scrollHeight;
    return bub;
  }
  function drawerNewChat() {
    S.currentChatId = null;
    drawerWelcome();
    document.getElementById('aiDrawerInput').focus();
  }
  function toggleDrawer(force) {
    ensureDrawer();
    const open = force === undefined ? !S.drawerOpen : !!force;
    S.drawerOpen = open;
    document.getElementById('aiDrawer').classList.toggle('open', open);
    if (open) {
      const h = providerHealth();
      document.getElementById('aiDrawerTag').textContent = h.text;
      const tag = document.getElementById('aiDrawerTag');
      tag.classList.toggle('none', !S.active);
      tag.classList.toggle('warn', !!h.warn);   // P0-1：模型名有误 → 橙色警示
      if (h.warn) tag.title = '模型名无效，AI 调用会失败，点右侧 ⚙ 修正';
      else tag.removeAttribute('title');
      renderDrawerActions();
      if (!document.getElementById('aiDrawerBody').dataset.built) {
        drawerWelcome();
        document.getElementById('aiDrawerBody').dataset.built = '1';
      }
      setTimeout(() => document.getElementById('aiDrawerInput').focus(), 60);
    }
  }
  function drawerQuickAsk(q) {
    const inp = document.getElementById('aiDrawerInput');
    inp.value = q;
    drawerSend();
  }
  async function drawerSend() {
    const inp = document.getElementById('aiDrawerInput');
    const text = inp.value.trim();
    if (!text || S.busy) return;
    if (!(await ensureProvider())) return;
    S.busy = true;
    const sendBtn = document.getElementById('aiDrawerSend');
    sendBtn.disabled = true;
    inp.value = '';
    drawerMsg('user', text);
    const body = document.getElementById('aiDrawerBody');
    // 打字指示
    let bubble = null, acc = '';
    const typing = document.createElement('div');
    typing.className = 'chat-msg ai typing';
    typing.innerHTML = '<div class="chat-avatar">AI</div><div class="chat-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    (body.querySelector('.ai-drawer-msgs') || body).appendChild(typing);
    body.scrollTop = body.scrollHeight;
    try {
      await stream({
        message: text, chatId: S.currentChatId,
        onMeta: j => {
          S.currentChatId = j.chatId;
          document.getElementById('aiDrawerTag').textContent = (j.provider || '') + ' · ' + (j.model || '');
          document.getElementById('aiDrawerTag').classList.remove('none');
        },
        onDelta: (d, full) => {
          if (!bubble) { typing.remove(); bubble = drawerMsg('ai', ''); }
          acc = full;
          bubble.innerHTML = mdToHtml(acc);
          body.scrollTop = body.scrollHeight;
        },
        onError: msg => { if (typing.parentNode) typing.remove(); drawerMsg('ai', '❌ ' + msg); }
      });
      if (bubble) bubble.innerHTML = mdToHtml(acc);
      if (!bubble && typing.parentNode) typing.remove();
    } catch (e) {
      if (typing.parentNode) typing.remove();
      drawerMsg('ai', '❌ 网络异常：' + (e && e.message ? e.message : e));
    }
    S.busy = false; sendBtn.disabled = false; inp.focus();
  }

  /* ---------------- 结果弹层（页面级动作的非流式结果） ---------------- */
  function ensureResultPop() {
    let el = document.getElementById('aiResultPop');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'aiResultPop';
    el.className = 'ai-result-pop';
    el.innerHTML =
      '<div class="ai-result-head"><span class="t">✨ AI 结果</span>'
      + '<button class="icon-btn" data-copy title="复制">📋</button>'
      + '<button class="icon-btn" data-close title="关闭">✕</button></div>'
      + '<div class="ai-result-body" id="aiResultBody"></div>'
      + '<div class="ai-result-foot"><button class="btn btn-secondary btn-sm" data-insert>插入到光标处</button></div>';
    document.body.appendChild(el);
    el.addEventListener('click', async e => {
      if (e.target.closest('[data-close]')) { el.classList.remove('open'); return; }
      if (e.target.closest('[data-copy]')) {
        try { await navigator.clipboard.writeText(el.querySelector('#aiResultBody').innerText); showToast('已复制'); }
        catch (err) { showToast('复制失败，请手动选择', 'warning'); }
        return;
      }
      if (e.target.closest('[data-insert]')) {
        const handler = insertHandler;
        if (handler) handler(el.querySelector('#aiResultBody').innerHTML);
        else showToast('当前页面不支持插入', 'warning');
      }
    });
    return el;
  }
  let insertHandler = null;
  function setInsertHandler(fn) { insertHandler = fn; }

  async function ask(prompt, opts) {
    const o = opts || {};
    if (!(await ensureProvider())) return;
    if (!o.system) { drawerQuickAsk(prompt); return; }   // 默认走抽屉对话
    const pop = ensureResultPop();
    pop.querySelector('#aiResultBody').innerHTML = '<span class="ai-loading">思考中…</span>';
    pop.classList.add('open');
    try {
      const text = await complete({ prompt, system: o.system, context: o.context, temperature: o.temperature });
      pop.querySelector('#aiResultBody').innerHTML = mdToHtml(text);
    } catch (e) {
      pop.querySelector('#aiResultBody').innerHTML = '<span class="md-error">❌ ' + escHtml(e.message || e) + '</span>';
    }
  }

  /* ---------------- 挂载 ---------------- */
  async function mount(opts) {
    const o = opts || {};
    if (S.inited) return;
    S.inited = true;
    await loadProviders();
    // 悬浮入口：受「系统设置 → AI 悬浮图标」控制，AI 页面自身不显示
    // 抽屉按需在首次打开时创建，避免开屏就往 DOM 里塞一批隐藏的可聚焦控件
    const showFloat = o.showFloat !== false && !o.isAiPage;
    if (showFloat) ensureFloat();
    if (typeof o.onReady === 'function') o.onReady(S.active);
  }

  return {
    state: S, mount, loadProviders, ensureProvider, providerLabel, providerHealth,
    stream, complete, ask, contextOf, registerContext, actionsOf, askActions: PAGE_ACTIONS,
    openSettings, closeSettings, setProviderChangeHandler,
    toggleDrawer, drawerQuickAsk, setInsertHandler, ensureResultPop,
    mdToHtml, escHtml, sanitizeHtml
  };
})();
