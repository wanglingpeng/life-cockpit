'use strict';
/* ai —— 由 server.js 的 handleApi() 机械切出，路由体逐字保留。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 * m 是正则路由的 match 数组，与切分前 handleApi 里的局部变量 m 完全一致。
 */

const { quickAddRuleFallback } = require('../services/utils.js');

module.exports = function register(router, app) {


    /* [L1682] if (pathname === '/api/ai/insights' && method === 'GET') */
    router.get('/api/ai/insights', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiInsightCache, aiInsightSummary, aiProviderStatus, buildDailyDigest, buildInsights, ok, todayStr } = app;
    const digest = buildDailyDigest();
    const insights = buildInsights(digest);
    const provStatus = aiProviderStatus();
    const aiReady = provStatus.state === 'ok';
    const force = q.get('refresh') === '1';
    const skipAi = q.get('ai') === '0';

    let summary = '';
    let cached = false;

    if (skipAi) {
      // ?ai=0：跳过 AI；不读不写缓存（防止空串覆盖当天缓存）
      summary = '';
    } else if (!aiReady) {
      // 未配置 AI：不写缓存，正常返回 200（A5）
      summary = '';
    } else if (!force && aiInsightCache.date === digest.date && aiInsightCache.summary) {
      // 命中当天缓存（key = digest.date，与 todayStr() 同本地时区口径）
      summary = aiInsightCache.summary;
      cached = true;
    } else {
      // 未命中 / 强制刷新：实时生成并回写缓存
      try { summary = await aiInsightSummary(digest); } catch (e) { summary = ''; }
      if (summary) {
        aiInsightCache.date = digest.date;
        aiInsightCache.summary = summary;
        aiInsightCache.aiUsed = true;
        aiInsightCache.generatedAt = new Date().toISOString();
      }
    }

    return ok(res, {
      generatedAt: new Date().toISOString(),   // 本次请求时刻（非缓存生成时刻）
      date: digest.date,
      insights,
      summary,
      aiReady,
      aiState: provStatus.state,               // ok | none | bad_model（前端据此区分文案）
      aiReason: provStatus.reason || '',
      aiUsed: !!summary,
      cached,                                  // ← 新增：本次 summary 是否来自缓存
      habit: digest.habit,
      money: { expense: digest.money.expense, deltaPct: digest.money.deltaPct, recordCount: digest.money.recordCount }
    });
    }, { auth: 'user', order: 1682 });

    /* [L1730] if (pathname === '/api/ai/quick-add' && method === 'POST') */
    router.post('/api/ai/quick-add', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiCompleteOnce, aiProviderStatus, applyQuickAdd, fail, ok, parseJsonLoose, readBody, safeSlice, saveDb, todayStr } = app;
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return fail(res, '请输入内容');
    if (text.length > 500) return fail(res, '内容过长（上限 500 字）');
    /* UI 评审 P1-4：「记一下」抽屉的基准日期胶囊可改，用于换算「明天 / 下周三」等
       相对日期。只接受格式合法的 ISO 日期；未传或非法时仍用服务端今天——
       老客户端与小程序不带这个字段，行为完全不变。 */
    const requestedBase = String(body.baseDate || '').trim();
    let today = todayStr();
    if (/^\d{4}-\d{2}-\d{2}$/.test(requestedBase)) {
      const [y, m, d] = requestedBase.split('-').map(Number);
      const probe = new Date(y, m - 1, d);
      // 只做格式校验会被 2026-99-99 这类值骗过去，这里再验一次真实日历日期
      if (probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d) today = requestedBase;
    }
    let plan = null, aiUsed = false, aiError = '';
    const provStatus = aiProviderStatus();
    if (provStatus.state === 'ok') {
      try {
        const sys = [
          '你是「生活驾驶舱」的结构化录入解析器：把用户的一句话拆成一组可直接落库的记录。',
          '今天是 ' + today + '（周' + ['日', '一', '二', '三', '四', '五', '六'][new Date(today + 'T00:00:00').getDay()] + '）。相对日期必须换算成绝对日期（如「下周三」）。',
          '只输出 JSON，不要解释、不要 Markdown 代码块。格式：{"summary":"给用户看的一句话确认","items":[...]}',
          'items 每个元素必须是下列之一（0-5 条，可多类型混合）：',
          '{"type":"task","title":"交电费","date":"YYYY-MM-DD","remindTime":"HH:MM","remark":""} 单次事务/待办',
          '{"type":"scheduled","name":"换滤芯","ruleType":"daily|weekly|monthly|yearly","ruleValue":"周几(1-7)或DD或MM-DD","remindTime":"HH:MM","category":"车辆年检|健康|家居|其他"} 周期性事项',
          '{"type":"anniversary","title":"妈妈生日","date":"YYYY-MM-DD","repeat":"yearly|none"} 生日/纪念日（年份未知用 1900）',
          '{"type":"ledger","kind":"expense|income","amount":38,"categoryName":"餐饮","date":"YYYY-MM-DD","remark":""} 记账',
          '{"type":"gift","direction":"out|in","person":"王阿姨","amount":600,"eventType":"婚礼","date":"YYYY-MM-DD","remark":""} 人情往来',
          '{"type":"expiry","name":"车险","expiryDate":"YYYY-MM-DD","categoryName":""} 物品/证件有效期',
          '{"type":"note","title":"","content":"..."} 随手记',
          '联动规则：一句话往往涉及多个模块，能拆成几项就拆几项（最多5条、多类型混合），不要只落一个；示例「妈下周三生日，预算300」应同时拆出：anniversary(妈妈生日,下周三) + ledger(支出300,当天) + gift(随礼300,妈妈,当天) + scheduled(每年提醒,下周三)。',
          '规则：金额只填数字；缺日期默认今天；不确定的字段留空字符串；绝不编造用户没说的信息。'
        ].join('\n');
        plan = parseJsonLoose(await aiCompleteOnce(text, sys, 0.2, 'quickadd'));
        aiUsed = !!plan;
        if (!aiUsed) aiError = 'AI 返回内容无法解析为结构化记录';
      } catch (e) { plan = null; aiError = (e && e.message) ? String(e.message) : String(e); }
    } else {
      aiError = provStatus.reason || '';
    }
    let fallback = false;
    // P0-1：降级原因必须可区分，不能一律说「未配置 AI」
    let fallbackReason = '';
    // 确认模式：前端回显上一步解析结果，直接落库，不再调 AI
    if (body.items && Array.isArray(body.items) && body.items.length) {
      plan = { summary: String(body.summary || ''), items: body.items };
    } else if (!plan || !Array.isArray(plan.items) || !plan.items.length) {
      fallback = true;
      if (provStatus.state === 'none') fallbackReason = 'none';
      else if (provStatus.state === 'bad_model') fallbackReason = 'bad_model';
      else fallbackReason = 'ai_error';
      const tips = {
        none: '未配置 AI',
        bad_model: 'AI 配置有误',
        ai_error: 'AI 暂不可用'
      };
      /* 无 AI 时规则兜底：识别「花了/买了…+金额」直接记账，不降级成待办（实现见 utils.quickAddRuleFallback） */
      const fbItem = quickAddRuleFallback(text, today);
      if (fbItem) {
        plan = {
          summary: '已记为一笔' + (fbItem.kind === 'income' ? '收入' : '支出') + ' ' + fbItem.amount + ' 元（' + tips[fallbackReason] + '）',
          items: [fbItem]
        };
      } else {
        plan = {
          summary: '已记为今天的事务（' + tips[fallbackReason] + '）',
          items: [{ type: 'task', title: safeSlice(text, 80), date: today }]
        };
      }
    }
    const wantItems = plan.items.slice(0, 8);
    // 预览模式：只解析不写入，把结构化结果返回给前端做确认
    if (body.dryRun) {
      return ok(res, { aiUsed, fallback, fallbackReason, aiError, dryRun: true, items: wantItems, summary: safeSlice(String(plan.summary || ''), 120) || ('将创建 ' + wantItems.length + ' 项') });
    }
    const result = applyQuickAdd(wantItems, uid);
    const created = result.created;
    const failed = result.failed;
    const realFailed = failed.filter(f => !f.skipped);
    saveDb();
    /* 汇总必须如实反映「请求 N / 成功 M / 失败 K」。旧实现无条件采用 AI
       返回的 summary，AI 说「已添加 4 项」而实际只落 1 项时用户无从察觉；
       只要有真实失败项，就用真实计数覆盖 AI 文案。 */
    const countSummary = '请求 ' + wantItems.length + ' 项 / 成功 ' + created.length + ' 项'
      + (realFailed.length ? ' / 失败 ' + realFailed.length + ' 项' : '')
      + (failed.length > realFailed.length ? '（含主动合并 ' + (failed.length - realFailed.length) + ' 项）' : '');
    return ok(res, {
      aiUsed, fallback, fallbackReason, aiError, created, failed,
      requested: wantItems.length, createdCount: created.length, failedCount: realFailed.length,
      summary: realFailed.length
        ? countSummary
        : (safeSlice(String(plan.summary || ''), 120) || countSummary)
    });
    }, { auth: 'user', order: 1730 });

    /* [L1797] if (pathname === '/api/ai/expiry-parse' && method === 'POST') */
    router.post('/api/ai/expiry-parse', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, fail, isVisionModel, ok, parseJsonLoose, readBody, safeSlice, todayStr } = app;
    const body = await readBody(req);
    const hint = safeSlice(String(body.hint || '').trim(), 300);
    const imageDataUrl = String(body.imageDataUrl || '').slice(0, 5000000);
    const categories = Array.isArray(body.categories) ? body.categories.map(String).filter(Boolean).slice(0, 30) : [];
    if (!hint && !imageDataUrl) return fail(res, '请先拍照或输入一句描述');
    const provider = aiActiveProvider('quickadd');
    if (!provider) return fail(res, '尚未配置可用的 AI 提供商，请先在 AI 设置填写 API Key', 400);
    const today = todayStr();
    const sys = [
      '你是「生活驾驶舱」证件效期的结构化录入解析器。今天是 ' + today + '。',
      '把用户的一句话/一张实物照片识别成一条家庭档案（保单/证件/家电/食品/车辆等）。',
      '只输出 JSON，不要解释、不要 Markdown 代码块。',
      'JSON 字段：{"name":"名称","categoryName":"分类","expiryDate":"YYYY-MM-DD(证照有效期/保单截止/食品保质期)","location":"存放位置","warrantyUntil":"YYYY-MM-DD(家电保修到期,无则空)","serialNo":"编号/序列号/证件号","qty":1,"remark":"备注"}',
      '规则：相对日期换算成绝对日期；金额只填数字；绝不编造照片或描述里没有的信息；识别不出就留空字符串。'
    ].join('\n');
    const categoryList = categories.length ? '可用分类（优先匹配）：' + categories.join('、') + '。' : '';
    const promptText = categoryList + '请识别并结构化这条档案：' + (imageDataUrl ? '（附一张实物照片，请从照片读取文字与信息）' : '') + (hint || '');
    const vision = !!imageDataUrl && isVisionModel(provider.model);
    let text = '';
    try {
      const base = (provider.baseUrl || '').replace(/\/+$/, '');
      const userContent = vision
        ? [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: promptText }]
        : promptText;
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
        body: JSON.stringify({ model: provider.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }], stream: false, temperature: 0.2 }),
        signal: AbortSignal.timeout(90000)
      });
      const raw = await up.text();
      if (!up.ok) return fail(res, 'AI 服务返回 ' + up.status + '：' + raw.slice(0, 200), 502);
      text = ((((JSON.parse(raw).choices || [])[0] || {}).message) || {}).content || '';
    } catch (e) {
      return fail(res, 'AI 建档失败：' + (e && e.message ? e.message : e), 502);
    }
    const fields = parseJsonLoose(text) || {};
    const clean = {
      name: safeSlice(String(fields.name || '').trim(), 60),
      categoryName: safeSlice(String(fields.categoryName || '').trim(), 30),
      expiryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.expiryDate || '')) ? fields.expiryDate : '',
      warrantyUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.warrantyUntil || '')) ? fields.warrantyUntil : '',
      location: safeSlice(String(fields.location || '').trim(), 60),
      serialNo: safeSlice(String(fields.serialNo || '').trim(), 60),
      qty: Math.max(1, parseInt(fields.qty, 10) || 1),
      remark: safeSlice(String(fields.remark || '').trim(), 200)
    };
    if (!clean.name) return fail(res, 'AI 未能识别出档案名称，请补充一句描述或手动填写', 422);
    return ok(res, { fields: clean, visionUsed: vision, provider: provider.label, model: provider.model });
    }, { auth: 'user', order: 1797 });

    /* [L1850] if (pathname === '/api/ai/receipt-parse' && method === 'POST') */
    router.post('/api/ai/receipt-parse', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, aiVisionProvider, fail, ok, parseJsonLoose, readBody, safeSlice, todayStr } = app;
    const body = await readBody(req);
    const imageDataUrl = String(body.imageDataUrl || '').slice(0, 5000000);
    const categories = Array.isArray(body.categories) ? body.categories.map(String).filter(Boolean).slice(0, 40) : [];
    if (!imageDataUrl) return fail(res, '请先拍一张票据或收据', 400);
    const provider = aiVisionProvider();
    if (!provider) {
      if (!aiActiveProvider()) return fail(res, '尚未配置可用的 AI 提供商，请先在 AI 设置填写 API Key', 400);
      return fail(res, '未启用支持看图的视觉模型（如 qwen-vl / 豆包视觉），票据识别无法进行，请在 AI 设置启用并配置', 400);
    }
    const today = todayStr();
    const sys = [
      '你是「生活驾驶舱」的票据速记解析器。今天是 ' + today + '。',
      '把一张购物小票 / 收据 / 消费凭证照片识别成一条家庭账本支出记录。',
      '只输出 JSON，不要解释、不要 Markdown 代码块。',
      'JSON 字段：{"date":"YYYY-MM-DD 消费日期(从票面读取,无则今天)","amount":数字金额(单位元)","categoryName":"消费分类(如餐饮/超市/交通/医疗/网购等,尽量匹配可用分类)","method":"支付方式(微信/支付宝/现金/银行卡/信用卡)","remark":"商家名+简要(如:盒马鲜生 日用品)"}',
      '规则：金额只填票面数字（人民币）；日期用票面时间；绝不编造票据上没有的信息；识别不出就留空字符串或 0。'
    ].join('\n');
    const categoryList = categories.length ? '可用分类（优先从里面选 categoryName）：' + categories.join('、') + '。' : '';
    const promptText = categoryList + '请识别这张票据并返回结构化 JSON。';
    let text = '';
    try {
      const base = (provider.baseUrl || '').replace(/\/+$/, '');
      const userContent = [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: promptText }];
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
        body: JSON.stringify({ model: provider.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }], stream: false, temperature: 0.1 }),
        signal: AbortSignal.timeout(90000)
      });
      const raw = await up.text();
      if (!up.ok) return fail(res, 'AI 服务返回 ' + up.status + '：' + raw.slice(0, 200), 502);
      text = ((((JSON.parse(raw).choices || [])[0] || {}).message) || {}).content || '';
    } catch (e) {
      return fail(res, '票据识别失败：' + (e && e.message ? e.message : e), 502);
    }
    const fields = parseJsonLoose(text) || {};
    const clean = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.date || '')) ? fields.date : today,
      amount: Math.max(0, parseFloat(fields.amount) || 0),
      categoryName: safeSlice(String(fields.categoryName || '').trim(), 30),
      method: safeSlice(String(fields.method || '').trim(), 20),
      remark: safeSlice(String(fields.remark || '').trim(), 120)
    };
    return ok(res, { fields: clean, provider: provider.label, model: provider.model });
    }, { auth: 'user', order: 1850 });

    /* [L1898] if (pathname === '/api/asr' && method === 'POST') */
    router.post('/api/asr', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, fail, ok } = app;
    const provider = aiActiveProvider();
    if (!provider) return fail(res, '尚未配置 AI 提供商，请先在 AI 设置填写 API Key', 400);
    // 读原始 body（二进制 base64 JSON）
    const rawBuf = await new Promise(r => { let c=[]; req.on('data',x=>c.push(x)); req.on('end',()=>r(Buffer.concat(c))); });
    let parsed = {};
    try { parsed = JSON.parse(rawBuf.toString('utf8')); } catch(e) {}
    const dataUrl = String(parsed.audio || '');
    const m = dataUrl.match(/^data:audio\/(\w+);base64,(.+)$/);
    if (!m) return fail(res, '音频数据格式错误', 400);
    const mime = 'audio/' + m[1];
    const audioBuf = Buffer.from(m[2], 'base64');
    if (audioBuf.length < 1000) return fail(res, '录音太短，请多说几个字', 400);
    // 构造 multipart/form-data
    const boundary = '----asrboundary' + Date.now();
    const parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nqwen-audio-asr\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="rec.webm"\r\nContent-Type: ' + mime + '\r\n\r\n'));
    parts.push(audioBuf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const bodyBuf = Buffer.concat(parts);
    const base = (provider.baseUrl || '').replace(/\/+$/, '');
    try {
      const r = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + provider.apiKey, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: bodyBuf
      });
      const j = await r.json();
      if (!r.ok) return fail(res, 'ASR 失败：' + (j.error?.message || r.statusText), 502);
      return ok(res, { text: j.text || '' });
    } catch (e) { return fail(res, 'ASR 请求失败：' + e.message, 502); }
    }, { auth: 'user', order: 1898 });

    /* [L4533] if (pathname === '/api/ai/config' && method === 'GET') */
    router.get('/api/ai/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { AI_CONN_MAX, AI_CONN_PRESETS, AI_SCENES, aiBadModel, aiServerProvider, aiSettings, ok } = app;
    const st = aiSettings();
    const list = Array.isArray(db.aiConnections) ? db.aiConnections : [];
    const srv = aiServerProvider ? aiServerProvider() : null;
    const builtinConn = srv ? [{ id: srv.id, label: srv.label, baseUrl: srv.baseUrl, textModel: srv.model, visionModel: '', createdAt: '', hasKey: true, modelValid: true, builtin: true }] : [];
    return ok(res, {
      enabled: st.enabled, defaultId: st.defaultId, timeoutSec: st.timeoutSec, scenes: st.scenes,
      maxConnections: AI_CONN_MAX, presets: AI_CONN_PRESETS, sceneLabels: AI_SCENES,
      connections: builtinConn.concat(list.map(c => ({
        id: c.id, label: c.label, baseUrl: c.baseUrl, textModel: c.textModel || '', visionModel: c.visionModel || '',
        createdAt: c.createdAt || '', hasKey: !!c.apiKeyEnc,
        modelValid: !aiBadModel(c.baseUrl, c.textModel)
      })))
    });
    }, { auth: 'user', order: 4533 });

    /* [L4547] if (pathname === '/api/ai/config' && method === 'PUT') */
    router.put('/api/ai/config', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { AI_SCENES, aiConnOf, aiSettings, fail, ok, readBody, saveDb } = app;
    const body = await readBody(req);
    const st = aiSettings();
    if (body.enabled !== undefined) st.enabled = !!body.enabled;
    if (body.timeoutSec !== undefined) {
      const n = parseInt(body.timeoutSec, 10);
      if (!(n >= 30 && n <= 3600)) return fail(res, '单次请求超时需在 30~3600 秒之间');
      st.timeoutSec = n;
    }
    if (body.defaultId !== undefined) {
      if (body.defaultId === null || body.defaultId === '') { st.defaultId = null; }
      else {
        const c = aiConnOf(body.defaultId);
        if (!c) return fail(res, '默认连接不存在');
        st.defaultId = c.id;
      }
    }
    if (body.scenes && typeof body.scenes === 'object' && !Array.isArray(body.scenes)) {
      for (const k of Object.keys(AI_SCENES)) {
        const v = body.scenes[k];
        if (v === undefined) continue;
        if (v === '' || v === null) { st.scenes[k] = ''; continue; }
        const c = aiConnOf(v);
        if (!c) return fail(res, '场景「' + AI_SCENES[k] + '」指定的连接不存在');
        st.scenes[k] = c.id;
      }
    }
    db.aiSettings = st; saveDb();
    return ok(res, st, 'AI 设置已保存');
    }, { auth: 'user', order: 4547 });

    /* [L4578] if (pathname === '/api/ai/connections' && method === 'POST') */
    router.post('/api/ai/connections', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { AI_CONN_MAX, aesEncrypt, aiSettings, fail, https, newId, nowStr, ok, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const list = Array.isArray(db.aiConnections) ? db.aiConnections : [];
    if (list.length >= AI_CONN_MAX) return fail(res, '最多保留 ' + AI_CONN_MAX + ' 份连接配置');
    const label = safeSlice(String(body.label || '').trim(), 20);
    if (!label) return fail(res, '请填写连接名称');
    const baseUrl = String(body.baseUrl || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) return fail(res, 'API 地址需以 http(s):// 开头');
    const key = String(body.apiKey || '').trim();
    if (!key) return fail(res, '请填写 API Key');
    const textModel = safeSlice(String(body.textModel || '').trim(), 80);
    const visionModel = safeSlice(String(body.visionModel || '').trim(), 80);
    if (!textModel && !visionModel) return fail(res, '请至少填写文本模型或视觉模型');
    const conn = {
      id: newId(db), label, baseUrl,
      apiKeyEnc: aesEncrypt(key, (db.settings.aiSecretKey || '').slice(0, 16)),
      textModel, visionModel, createdAt: nowStr()
    };
    list.push(conn); db.aiConnections = list;
    const st = aiSettings();
    if (st.defaultId === null) { st.defaultId = conn.id; db.aiSettings = st; }   // 第一份连接自动设为默认
    saveDb();
    return ok(res, { id: conn.id, label: conn.label }, '连接已添加');
    }, { auth: 'user', order: 4578 });

    /* [L4603] if (pathname === '/api/ai/connections/test' && method === 'POST') */
    router.post('/api/ai/connections/test', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aesEncrypt, aiConnOf, fail, ok, probeProvider, readBody } = app;
    const body = await readBody(req);
    const conn = body.id ? aiConnOf(body.id) : null;
    if (body.id && !conn) return fail(res, '连接不存在', 404);
    const baseUrl = body.baseUrl !== undefined ? String(body.baseUrl).trim() : (conn ? conn.baseUrl : '');
    const model = body.textModel !== undefined ? String(body.textModel).trim() : (conn ? conn.textModel : '');
    const apiKeyEnc = (body.apiKey && String(body.apiKey).trim())
      ? aesEncrypt(String(body.apiKey).trim(), (db.settings.aiSecretKey || '').slice(0, 16))
      : (conn ? conn.apiKeyEnc : '');
    const r = await probeProvider(baseUrl, model, apiKeyEnc, body.mode === 'full' ? 'full' : 'quick');
    return ok(res, { ok: !!r.ok, mode: body.mode === 'full' ? 'full' : 'quick', message: r.message || '', ms: r.ms || 0, reply: r.reply || '' },
      r.ok ? (body.mode === 'full' ? ('完整测试通过' + (r.reply ? '，模型回复：' + r.reply : '')) : ('连接正常（' + r.ms + 'ms）')) : ('连接失败：' + r.message));
    }, { auth: 'user', order: 4603 });

    /* [L4617] if (pathname === '/api/ai/models' && method === 'POST') */
    router.post('/api/ai/models', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aesDecrypt, aesEncrypt, aiConnOf, aiKey16, aiTimeoutMs, fail, https, ok, readBody } = app;
    const body = await readBody(req);
    const conn = body.connId ? aiConnOf(body.connId) : null;
    if (body.connId && !conn) return fail(res, '连接不存在', 404);
    const baseUrl = body.baseUrl !== undefined ? String(body.baseUrl).trim() : (conn ? conn.baseUrl : '');
    const apiKeyEnc = (body.apiKey && String(body.apiKey).trim())
      ? aesEncrypt(String(body.apiKey).trim(), (db.settings.aiSecretKey || '').slice(0, 16))
      : (conn ? conn.apiKeyEnc : '');
    if (!/^https?:\/\//i.test(baseUrl)) return fail(res, 'API 地址需以 http(s):// 开头');
    if (!apiKeyEnc) return fail(res, '请先填写 API Key');
    let apiKey = '';
    try { apiKey = aesDecrypt(apiKeyEnc, aiKey16()); } catch (e) { }
    try {
      const up = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(Math.min(30000, Math.max(15000, aiTimeoutMs())))
      });
      const raw = await up.text();
      if (!up.ok) return fail(res, '上游返回 ' + up.status + '：' + raw.slice(0, 160), 502);
      const j = JSON.parse(raw);
      const ids = (Array.isArray(j.data) ? j.data : []).map(m => String((m && m.id) || '')).filter(Boolean).slice(0, 200);
      return ok(res, { models: ids });
    } catch (e) {
      return fail(res, '拉取模型列表失败：' + (e && e.message ? e.message : e), 502);
    }
    }, { auth: 'user', order: 4617 });

    /* [L4680] if (pathname === '/api/ai/providers' && method === 'GET') */
    router.get('/api/ai/providers', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiBadModel, aiDefaultConn, aiSettings, ok } = app;
    const st = aiSettings();
    const act = st.enabled ? aiDefaultConn() : null;
    return ok(res, [{
      id: act ? String(act.id) : 'default',
      label: act ? act.label : 'AI 连接',
      enabled: !!act,
      configured: !!act, hasKey: !!act,
      baseUrl: act ? act.baseUrl : '',
      model: act ? (act.textModel || act.visionModel || '') : '',
      modelValid: act ? !aiBadModel(act.baseUrl, act.textModel) : false
    }]);
    }, { auth: 'user', order: 4680 });

    /* [L4694] if (pathname === '/api/ai/chats' && method === 'GET') */
    router.get('/api/ai/chats', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { ok } = app;
    const list = db.aiChats.filter(c => c.userId === uid)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 50)
      .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }));
    return ok(res, list);
    }, { auth: 'user', order: 4694 });

    /* [L4701] if (pathname === '/api/ai/chats' && method === 'POST') */
    router.post('/api/ai/chats', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { newId, nowStr, ok, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const chat = { id: newId(db), userId: uid, title: safeSlice(String(body.title || '新对话'), 30), messages: [], createdAt: nowStr(), updatedAt: nowStr() };
    db.aiChats.push(chat); saveDb();
    return ok(res, chat, '已创建');
    }, { auth: 'user', order: 4701 });

    /* [L4723] if (pathname === '/api/ai/complete' && method === 'POST') */
    router.post('/api/ai/complete', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, aiSettings, aiSystemPrompt, fail, ok, readBody, safeSlice } = app;
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return fail(res, 'prompt 不能为空');
    if (prompt.length > 20000) return fail(res, '内容过长（上限 20000 字）');
    const provider = aiActiveProvider('chat');
    if (!provider) return fail(res, aiSettings().enabled ? '尚未配置可用的 AI 提供商，请先填写 API Key' : 'AI 总开关已关闭，如需使用请到 AI 设置开启', 400);

    const messages = [
      { role: 'system', content: aiSystemPrompt(body.context) + (body.system ? '\n\n' + safeSlice(String(body.system), 2000) : '') },
      { role: 'user', content: prompt }
    ];
    try {
      const base = (provider.baseUrl || '').replace(/\/+$/, '');
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
        body: JSON.stringify({ model: provider.model, messages, stream: false, temperature: +(body.temperature) || 0.6 }),
        signal: AbortSignal.timeout(120000)
      });
      const raw = await up.text();
      if (!up.ok) return fail(res, 'AI 服务返回 ' + up.status + '：' + raw.slice(0, 200), 502);
      let j = {};
      try { j = JSON.parse(raw); } catch (e) { return fail(res, 'AI 返回格式异常', 502); }
      const text = (((j.choices || [])[0] || {}).message || {}).content || '';
      if (!text) return fail(res, 'AI 未返回内容', 502);
      return ok(res, { text, provider: provider.label, model: provider.model });
    } catch (e) {
      return fail(res, '连接 AI 服务失败：' + (e && e.message ? e.message : e), 502);
    }
    }, { auth: 'user', order: 4723 });

    /* [L4755] if (pathname === '/api/ai/chat' && method === 'POST') */
    router.post('/api/ai/chat', async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, aiSettings, aiSystemPrompt, fail, newId, nowStr, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return fail(res, '消息不能为空');
    if (message.length > 4000) return fail(res, '消息过长（上限 4000 字）');

    const provider = aiActiveProvider('chat');
    if (!provider) return fail(res, aiSettings().enabled ? '尚未配置可用的 AI 提供商，请点击右上角 ⚙️ 填写 API Key' : 'AI 总开关已关闭，如需使用请到 AI 设置开启', 400);

    // 会话：带 chatId 用旧会话，否则新建
    let chat = body.chatId ? db.aiChats.find(c => c.id === +body.chatId && c.userId === uid) : null;
    if (!chat) {
      chat = { id: newId(db), userId: uid, title: safeSlice(message, 20), messages: [], createdAt: nowStr(), updatedAt: nowStr() };
      db.aiChats.push(chat);
    }
    chat.messages.push({ role: 'user', content: message, ts: nowStr() });
    if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
    chat.updatedAt = nowStr(); saveDb();

    const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const sys = aiSystemPrompt(body.context);
    const messages = [{ role: 'system', content: sys }].concat(history);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const emit = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { } };
    emit({ chatId: chat.id, title: chat.title, provider: provider.label, model: provider.model });

    let full = '';
    let errored = false;
    try {
      const base = (provider.baseUrl || '').replace(/\/+$/, '');
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
        body: JSON.stringify({ model: provider.model, messages, stream: true, temperature: 0.7 }),
        signal: AbortSignal.timeout(120000)
      });
      if (!up.ok) {
        let detail = '';
        try { detail = (await up.text()).slice(0, 300); } catch (e) { }
        errored = true;
        emit({ error: 'AI 服务返回 ' + up.status + (detail ? '：' + detail : '') });
        res.write('data: [DONE]\n\n'); return res.end();
      }
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
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
          try {
            const j = JSON.parse(payload);
            const delta = (((j.choices || [])[0] || {}).delta || {}).content || '';
            if (delta) { full += delta; emit({ delta }); }
          } catch (e) { }
        }
      }
    } catch (e) {
      errored = true;
      if (!full) emit({ error: '连接 AI 服务失败：' + (e && e.message ? e.message : e) });
      else emit({ error: '连接中断，已保留部分回复' });
    }
    // 上游返回 200 但全程无任何 delta 内容 → 向前端补发一条 error，避免前端等到一个空流
    if (!full && !errored) emit({ error: '模型未返回内容，请重试' });
    if (full) {
      chat.messages.push({ role: 'assistant', content: full, ts: nowStr() });
      if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
      chat.updatedAt = nowStr(); saveDb();
    }
    res.write('data: [DONE]\n\n');
    return res.end();
    }, { auth: 'user', order: 4755 });

    /* [L4644] if (aiConnRoute) */
    router.when(function (ctx) {
      const { pathname, method } = ctx;
      const state = ctx.state;
      const aiConnRoute = pathname.match(/^\/api\/ai\/connections\/(\d+)$/);
      if (!aiConnRoute) return false;
      ctx.m = aiConnRoute;
      return aiConnRoute;
    }, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { aesEncrypt, aiConnOf, aiSettings, fail, https, ok, readBody, safeSlice, saveDb } = app;
    const conn = aiConnOf(m[1]);
    if (!conn) return fail(res, '连接不存在', 404);
    // 编辑连接：apiKey 语义沿用旧约定（空=保留，'-CLEAR-'=清除）
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.label !== undefined) {
        const l = safeSlice(String(body.label).trim(), 20);
        if (!l) return fail(res, '连接名称不能为空');
        conn.label = l;
      }
      if (body.baseUrl !== undefined) {
        const b = String(body.baseUrl).trim();
        if (!/^https?:\/\//i.test(b)) return fail(res, 'API 地址需以 http(s):// 开头');
        conn.baseUrl = b;
      }
      if (body.textModel !== undefined) conn.textModel = safeSlice(String(body.textModel).trim(), 80);
      if (body.visionModel !== undefined) conn.visionModel = safeSlice(String(body.visionModel).trim(), 80);
      if (body.apiKey === '-CLEAR-') delete conn.apiKeyEnc;
      else if (String(body.apiKey || '').trim()) conn.apiKeyEnc = aesEncrypt(String(body.apiKey).trim(), (db.settings.aiSecretKey || '').slice(0, 16));
      if (!conn.textModel && !conn.visionModel) return fail(res, '请至少填写文本模型或视觉模型');
      saveDb();
      return ok(res, { id: conn.id, label: conn.label, baseUrl: conn.baseUrl, textModel: conn.textModel || '', visionModel: conn.visionModel || '', hasKey: !!conn.apiKeyEnc }, '连接已保存');
    }
    // 删除连接：若是默认连接则回落第一份；场景引用同步清空
    if (method === 'DELETE') {
      db.aiConnections = db.aiConnections.filter(c => c.id !== conn.id);
      const st = aiSettings();
      if (st.defaultId === conn.id) st.defaultId = db.aiConnections.length ? db.aiConnections[0].id : null;
      Object.keys(st.scenes).forEach(k => { if (st.scenes[k] === conn.id) st.scenes[k] = ''; });
      db.aiSettings = st;
      saveDb();
      return ok(res, { id: conn.id }, '连接已删除');
    }
    }, { auth: 'user', order: 4644 });

    /* [L4708] if (aiChatRoute) */
    router.when(function (ctx) {
      const { pathname, method } = ctx;
      const state = ctx.state;
      const aiChatRoute = pathname.match(/^\/api\/ai\/chats\/(\d+)$/);
      if (!aiChatRoute) return false;
      ctx.m = aiChatRoute;
      return aiChatRoute;
    }, async function (ctx) {
      const { req, res, q, url, method, pathname, user, uid, db } = ctx;
      const state = ctx.state;
      const m = ctx.m;
      const { fail, ok, readBody, safeSlice, saveDb } = app;
    const chat = db.aiChats.find(c => c.id === +m[1] && c.userId === uid);
    if (!chat) return fail(res, '会话不存在', 404);
    if (method === 'GET') return ok(res, chat);
    if (method === 'DELETE') {
      db.aiChats = db.aiChats.filter(c => c.id !== chat.id); saveDb();
      return ok(res, null, '已删除');
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.title) chat.title = safeSlice(String(body.title), 30);
      saveDb(); return ok(res, chat, '已更新');
    }
    }, { auth: 'user', order: 4708 });
};
