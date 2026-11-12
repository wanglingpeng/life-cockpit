'use strict';
/* ledger-import —— 由 ledger.routes.js 按域内主题切出（§7.1 点名的首个切片）。
 *
 * 只注册 /api/ledger/import-csv 一条路由；路由体逐字保留，order 3204 不变，
 * 路由表零变化（route-inventory 前后逐字节相等）。
 *
 * 每个 handler 收到的 ctx：
 *   { req, res, q, method, pathname, m, user, uid, db, app }
 */

module.exports = function register(router, app) {

    /* [L3204] if (pathname === '/api/ledger/import-csv' && method === 'POST') */
    router.post('/api/ledger/import-csv', async function (ctx) {
      const { req, res, q, url, pathname, user, uid, db } = ctx;
      const { aiActiveProvider, aiCompleteOnce, defaultLedgerBookId, fail, newId, nowStr, ok, parseJsonLoose, readBody, safeSlice, saveDb } = app;
    const body = await readBody(req);
    const csv = String(body.csv || '').replace(/^﻿/, '').trim();
    if (!csv) return fail(res, '请粘贴账单 CSV 内容');
    if (!aiActiveProvider()) return fail(res, '尚未配置 AI，无法自动分类。请先在 AI 设置填写 Key', 400);

    // 1) 解析 CSV：找到表头行（含"交易时间"或"交易创建时间"），其后为数据
    const lines = csv.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let headerIdx = -1;
    lines.forEach((l, i) => { if (headerIdx < 0 && /交易时间|交易创建时间|交易发起时间/.test(l)) headerIdx = i; });
    if (headerIdx < 0) return fail(res, '未识别到账单表头（需包含"交易时间"列），请确认是支付宝/微信导出的 CSV');

    const parseCsvLine = line => {
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      out.push(cur.trim()); return out;
    };
    const headers = parseCsvLine(lines[headerIdx]);
    const col = name => headers.findIndex(h => h.includes(name));
    const cDate = col('交易时间') >= 0 ? col('交易时间') : col('交易创建时间');
    const cAmount = col('金额') >= 0 ? col('金额') : col('金额(元)');
    const cKind = col('收/支') >= 0 ? col('收/支') : col('收/支方向');
    const cDesc = col('商品') >= 0 ? col('商品') : (col('交易对方') >= 0 ? col('交易对方') : col('商品说明'));
    const cMethod = col('支付方式');
    if (cDate < 0 || cAmount < 0) return fail(res, 'CSV 缺少"交易时间"或"金额"列');

    // 2) 提取数据行，过滤掉不计收支的（中性/退款/交易关闭）
    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      if (cells.length < Math.max(cDate, cAmount) + 1) continue;
      let dateStr = (cells[cDate] || '').trim().slice(0, 10);
      // 日期归一：2026-10-04 23:59:59 → 2026-10-04
      dateStr = dateStr.replace(/[年月]/g, '-').replace(/日.*/, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      const amount = parseFloat((cells[cAmount] || '').replace(/[¥￥,]/g, ''));
      if (!amount || amount <= 0) continue;
      let kind = (cells[cKind] || '').trim();
      // 支付宝/微信：收/支 列含"支出"/"收入"
      let k = 'expense';
      if (/收/.test(kind) && !(/支/.test(kind) && kind.length <= 2)) k = /收入|^收$/.test(kind) ? 'income' : 'expense';
      // 微信有"其他"列，跳过
      if (/其他|中性/.test(kind)) continue;
      const desc = safeSlice((cells[cDesc] || '').trim(), 80);
      const method = cMethod >= 0 ? (cells[cMethod] || '').trim() : '';
      rows.push({ date: dateStr, amount: Math.round(amount * 100) / 100, kind: k, desc, method });
    }
    if (!rows.length) return fail(res, '未解析到有效交易记录');

    // 3) AI 批量分类：给可用分类 + 一批交易描述
    const cats = db.ledgerCategories.filter(c => c.builtin || true);
    const catList = cats.map(c => c.name + '(' + c.kind + ')').join('、');
    const descList = rows.map((r, i) => (i + 1) + '.[' + r.kind + '] ' + r.desc).join('\n');
    const sys = [
      '你是家庭账本的自动分类器。把每笔交易归入给定分类之一。',
      '可用分类：' + catList,
      '只输出 JSON 数组，不要解释。格式：[{"i":1,"cat":"餐饮","remark":"简短备注"}]',
      'i 对应输入序号；cat 必须是上面可用分类里的一个；remark 不超过 15 字。'
    ].join('\n');
    let aiResult = [];
    try {
      const raw = await aiCompleteOnce(descList, sys, 0.1, 'insights');
      const j = parseJsonLoose(raw);
      if (Array.isArray(j)) aiResult = j;
      else if (Array.isArray(j.items)) aiResult = j.items;
    } catch (e) { /* AI 失败则全部归为"其他" */ }
    const catMap = {};
    aiResult.forEach(a => { if (a && a.i) catMap[a.i] = { cat: String(a.cat || '').trim(), remark: String(a.remark || '') }; });

    // 4) 写入
    const created = [];
    rows.forEach((r, i) => {
      const c = catMap[i + 1] || {};
      let cat = cats.find(x => x.name === c.cat && x.kind === r.kind) || cats.find(x => x.kind === r.kind && /其他/.test(x.name));
      if (!cat) cat = cats.find(x => x.kind === r.kind && x.builtin) || cats[0];
      const row = {
        id: newId(db), createdAt: nowStr(), source: 'ai-import', date: r.date, kind: r.kind,
        categoryId: cat ? cat.id : null, amount: r.amount, method: r.method.slice(0, 20),
        memberId: null, remark: safeSlice((c.remark || r.desc || ''), 100),
        /* 迭代 2：批量导入的流水统一落默认账本，避免出现「不属于任何账本」的孤儿 */
        bookId: defaultLedgerBookId()
      };
      db.ledgerRecords.push(row);
      created.push(row);
    });
    saveDb();
    const expenseSum = created.filter(x => x.kind === 'expense').reduce((s, x) => s + x.amount, 0);
    const incomeSum = created.filter(x => x.kind === 'income').reduce((s, x) => s + x.amount, 0);
    return ok(res, {
      total: created.length,
      expense: Math.round(expenseSum * 100) / 100,
      income: Math.round(incomeSum * 100) / 100,
      categorized: Object.keys(catMap).length
    }, '已导入 ' + created.length + ' 笔');
    }, { auth: 'user', order: 3204 });

};
