'use strict';
/* P1④ 自然语言查询「问驾驶舱」：POST /api/ai/ask —— 把驾驶舱实时数据快照交给 AI 按问题回答。
 * 数据复用 buildAskSnapshot（buildTodayPayload 同口径 + 账本/待办明细），AI 不可用时 ruleAnswer 规则兜底。 */
module.exports = function register(router, app) {
  router.post('/api/ai/ask', async function (ctx) {
    const { req, res, db } = ctx;
    const { aiCompleteOnce, aiProviderStatus, buildAskSnapshot, buildTodayPayload, fail, ok, readBody, ruleAnswer, todayStr } = app;
    const body = await readBody(req);
    const question = String(body.q || '').trim();
    if (!question) return fail(res, '请输入要问的问题');
    if (question.length > 300) return fail(res, '问题过长（上限 300 字）');
    const today = todayStr();
    const snapshot = buildAskSnapshot(db, today);
    let answer = '';
    let aiUsed = false;
    let fallbackReason = '';
    const provStatus = aiProviderStatus();
    if (provStatus.state === 'ok') {
      try {
        const system = '你是「生活驾驶舱」的家庭数据问答助手。只能依据下方快照回答，直接给结论和数字，口语化、简短；快照里没有的数据就明确说"快照里没有这项"，绝不编造。\n\n可用数据：\n' + snapshot;
        answer = (await aiCompleteOnce(question, system, 0.3, 'chat')).trim();
        aiUsed = !!answer;
        if (!aiUsed) fallbackReason = 'AI 未返回有效内容';
      } catch (e) { answer = ''; fallbackReason = (e && e.message) ? String(e.message) : String(e); }
    } else {
      fallbackReason = provStatus.reason || 'AI 未配置';
    }
    if (!answer) {
      const p = buildTodayPayload();
      answer = ruleAnswer(p, db, today, question);
      aiUsed = false;
    }
    return ok(res, { answer, aiUsed, fallbackReason, today });
  }, { auth: 'user', order: 4760 });
};
