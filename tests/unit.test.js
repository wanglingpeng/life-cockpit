/* P0 行为级回归（无需起服务、不碰 data/，毫秒级）。
 * 覆盖：P0-1 静默丢数据、P0-2 微信默认不再伪登录、P0-5 到点提醒扫描、P0-6 备份纯函数。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const rt = require(path.join(ROOT, 'src/core/runtime'));
const { todayStr } = require(path.join(ROOT, 'src/services/utils'));

test('P0-1 applyQuickAdd 不再静默吞掉失败项，且周期/任务均落库', () => {
  rt.setDb({
    nextId: 100, settings: { telemetry: false }, stats: {},
    tasks: [], scheduledTasks: [], anniversaries: [], ledgerCategories: [],
    ledgerBooks: [{ id: 1, name: '日常账本' }], ledgerRecords: [],
    giftPersons: [], giftRecords: [], expiryItems: [], notes: []
  });
  const { applyQuickAdd } = require(path.join(ROOT, 'src/services/today'));
  const items = [
    { type: 'scheduled', name: '每月交物业费', ruleType: 'monthly', ruleValue: '5', remindTime: '09:00' },
    { type: 'task', title: '买牛奶', date: '2026-11-10' },
    { type: 'ledger', amount: 20, categoryName: '餐饮', remark: '午饭' },
    { type: 'unknown', title: '应被上报为失败' },
    { type: 'task' },                 // 缺标题 → 失败
    { type: 'ledger', amount: 0 }     // 金额为 0 → 失败
  ];
  const r = applyQuickAdd(items, 1);
  assert.equal(r.created.length, 3, '成功 3 项（周期+任务+记账）');
  assert.equal(r.failed.length, 3, '失败 3 项均被上报');
  assert.ok(r.failed.every(f => f.reason), '每条失败都有原因');
  assert.equal(rt.db.scheduledTasks.length, 1);
  assert.equal(rt.db.tasks.length, 1);
  assert.equal(rt.db.ledgerRecords.length, 1);
  const kinds = r.created.map(x => x.kind);
  assert.ok(kinds.includes('scheduled'), '周期提醒确实落库');
});

test('P0-2 微信默认 MOCK 已关闭：MOCK_WECHAT 未置 1 时 wxMockMode 返回 false', () => {
  // 默认测试进程未设置 MOCK_WECHAT → 绝不能回退到“任意 code 都能登录”
  delete process.env.MOCK_WECHAT;
  const { wxMockMode } = require(path.join(ROOT, 'src/services/wechat'));
  assert.equal(wxMockMode(), false, '默认非 MOCK，微信登录走真实校验');
  process.env.MOCK_WECHAT = '1';
  assert.equal(wxMockMode(), true, '显式开启才 MOCK');
  delete process.env.MOCK_WECHAT;
});

test('P0-5 collectDueReminders 在指定时刻正确挑出到期条目', () => {
  const TODAY = todayStr();
  rt.setDb({
    nextId: 100, settings: {}, tasks: [
      { id: 1, title: '晨会', date: TODAY, remindTime: '09:07', statusId: 1 },
      { id: 2, title: '已完成', date: TODAY, remindTime: '09:07', statusId: 3 },
      { id: 3, title: '昨天', date: '2000-01-01', remindTime: '09:07', statusId: 1 },
      { id: 4, title: '下午', date: TODAY, remindTime: '14:30', statusId: 1 }
    ],
    scheduledTasks: [
      { id: 11, name: '每日吃药', ruleType: 'daily', enabled: true, remindTime: '09:07' },
      { id: 12, name: '每月缴费', ruleType: 'monthly', ruleValue: String(new Date().getDate()), enabled: true, remindTime: '14:30' },
      { id: 13, name: '停用', ruleType: 'daily', enabled: false, remindTime: '09:07' }
    ]
  });
  const { collectDueReminders } = require(path.join(ROOT, 'src/services/push'));
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const k1 = collectDueReminders(at(9, 7)).map(x => x.key).sort();
  const k2 = collectDueReminders(at(14, 30)).map(x => x.key).sort();
  const k3 = collectDueReminders(at(8, 0));
  assert.deepEqual(k1, [TODAY + '|scheduled|11', TODAY + '|task|1'].sort());
  assert.deepEqual(k2, [TODAY + '|scheduled|12', TODAY + '|task|4'].sort());
  assert.equal(k3.length, 0, '无匹配返回空');
  assert.ok(!k1.includes(TODAY + '|task|2'), '已完成被排除');
  assert.ok(!k1.includes(TODAY + '|task|3'), '非今日被排除');
  assert.ok(!k1.includes(TODAY + '|scheduled|13'), '已停用被排除');
});

test('P0-6 备份保留策略与同盘判定为纯函数且正确', () => {
  const { keepBackupDates, isSameDisk } = require(path.join(ROOT, 'src/services/backup'));
  // 近 7 日全留
  const daily = ['2026-11-10', '2026-11-09', '2026-11-08'];
  // 6 个彼此相隔约 10 天（分属不同 ISO 周）的更早日期，用于触发“周层只留 4 个”
  const older = ['2026-08-10', '2026-08-20', '2026-08-30', '2026-09-09', '2026-09-19', '2026-09-29'];
  const dates = [...daily, ...older];
  const keep = keepBackupDates(dates, { keepDays: 7, keepWeeks: 4, keepMonths: 6, maxDirs: 24, ref: '2026-11-10' });
  assert.ok(keep.has('2026-11-10') && keep.has('2026-11-09') && keep.has('2026-11-08'), '近 7 日全留');
  assert.ok(keep.has('2026-09-29') && keep.has('2026-09-19') && keep.has('2026-09-09') && keep.has('2026-08-30'), '周层保留 4 个最新周副本');
  assert.ok(!keep.has('2026-08-10'), '最早的一个旧周副本被淘汰');
  // 月度层会把“每月最新一个”补回：2026-08 的最新副本 08-20 仍保留（符合设计）
  assert.ok(keep.has('2026-08-20'), '月度层保留每月最新一个（08-20 为 8 月最新）');
  assert.ok(isSameDisk('C:\\a', 'C:\\b') === true, '同盘判定 true');
  assert.ok(isSameDisk('C:\\a', 'D:\\b') === false, '异盘判定 false');
});
