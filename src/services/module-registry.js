/* 模块注册表与商店演示数据：内置模块清单、按需播种、商店兜底列表。
 *
 * 为什么单独一个服务：BUILTIN_MODULES（20 条内置模块的权威清单）、
 * ensureModules（把清单播种进 rt.db.modules）、STORE_DEMO（模块商店的
 * 兜底演示数据）是「模块市场」这一个关注点的三件套——清单定义「有哪些
 * 模块」、播种保证「库里一定有这些键」、演示数据保证「远程商店拉不到时
 * 页面不空」。三者唯一的消费方都是 settings.routes.js（经 app 面）。
 *
 * 为什么 ensureModules 是懒播种而不是启动时跑：它只被 /api/modules 相关
 * 路由调用，冷启动路径（db-lifecycle）不经过它；放进启动序列会让「打开
 * 模块管理页」这件事变成每次开机都做的无用功。路由内先 ensure 再读，
 * 幂等，重复调用零成本。
 *
 * 所有对 db 的访问都走 rt.db（见 src/core/runtime.js）。
 *
 * 从 server.js「从 handleApi 上提的局部常量与函数」区搬入——静态注册数据
 * 占 42 行，是组装根里最与「组装」无关的一块。 */
const rt = require('../core/runtime');

const BUILTIN_MODULES = [
  { module_id: 'dashboard', name: '今日驾驶舱', group: '今天', desc: '首页一屏总览：今天要处理、关键指标、倒计时', version: '1.0.0' },
  { module_id: 'tasks', name: '事务清单', group: '今天', desc: '待办事项、今日任务、完成打卡', version: '1.0.0' },
  { module_id: 'scheduled-tasks', name: '循环事务', group: '今天', desc: '每天/每周/每月自动提醒：滤芯、体检、年检', version: '1.0.0' },
  { module_id: 'anniversaries', name: '纪念日', group: '家底', desc: '生日、纪念日倒数、人情提醒', version: '1.0.0' },
  { module_id: 'expiries', name: '证件效期', group: '家底', desc: '证件/家电/食品效期、保修、附件', version: '1.0.0' },
  { module_id: 'family', name: '家庭成员', group: '家底', desc: '家人信息、生日、家庭地址', version: '1.0.0' },
  { module_id: 'networth', name: '家底总览', group: '家底', desc: '净资产仪表盘、资产构成', version: '1.0.0' },
  { module_id: 'vault', name: '保险库', group: '家底', desc: '保单、证件、密码加密存储', version: '1.0.0', defaultDisabled: true },
  { module_id: 'ledger', name: '家庭账本', group: '钱', desc: '收支记账、分类、预算', version: '1.0.0' },
  { module_id: 'gift-records', name: '人情记账', group: '钱', desc: '随礼收支、回礼提醒', version: '1.0.0' },
  { module_id: 'mortgage', name: '贷款计算', group: '钱', desc: '房贷月供、还款计划', version: '1.0.0' },
  { module_id: 'notes', name: '备忘手记', group: '我', desc: '快速笔记、文本记录', version: '1.0.0' },
  { module_id: 'health', name: '健康记录', group: '我', desc: '家人健康、复诊用药、BMI', version: '1.0.0' },
  { module_id: 'report', name: '生活月报', group: '我', desc: '月度收支、记录量、健康度汇总', version: '1.0.0' },
  { module_id: 'location', name: '位置轨迹', group: '我', desc: 'GPS打卡、轨迹记录', version: '1.0.0' },
  { module_id: 'footprint', name: '我的足迹', group: '我', desc: '去过的地方地图', version: '1.0.0' },
  { module_id: 'ai', name: 'AI 小助手', group: '我', desc: '对话记账、一句话全模块联动', version: '1.0.0' },
  { module_id: 'general-config', name: '通用配置', group: '我', desc: '功能开关、feat 配置', version: '1.0.0' },
  { module_id: 'help-center', name: '帮助中心', group: '我', desc: '使用指引、FAQ', version: '1.0.0' },
  { module_id: 'admin-store', name: '模块商店', group: '我', desc: '浏览和安装扩展模块', version: '1.0.0' }
];

function ensureModules() {
  if (!rt.db.modules) rt.db.modules = {};
  BUILTIN_MODULES.forEach(m => {
    if (!rt.db.modules[m.module_id]) {
      rt.db.modules[m.module_id] = { status: m.defaultDisabled ? 'disabled' : 'enabled', config: {}, installedAt: new Date().toISOString().slice(0,10) };
    }
  });
}

/* 模块商店兜底数据：远程商店（settings.storeUrl）拉不到时展示。
   与 BUILTIN_MODULES 刻意分开：这里是「可能安装的扩展」，清单里是
   「一定存在的内置」——混在一张表里会让「禁用内置模块」与「安装扩展」
   共用同一套校验，而两者的权限语义不同。

   ⚠ 这 6 条里只有 vault 是真实模块（在 BUILTIN_MODULES 里，有页面有路由）。
   其余 5 条是**路线图占位**：没有页面、没有路由、没有实现，标 planned: true。
   谁要把 /api/store 接进界面，必须先过滤 planned !== true —— 否则用户点了
   「安装」，/api/modules 的 PUT 会照单建一条 db.modules 记录，然后这个模块
   指向一个不存在的页面，点进去 404。
   现状（v1.48.39）：/api/store 全站无前端消费方（admin-store.html 是更新日志
   与规划页，不读这个接口），所以这 5 条今天不会造成任何可见问题——但它是
   一个埋着的坑，标记比删除更有用：删除会丢掉「打算做什么」。 */
const STORE_DEMO = [
  { module_id: 'vault', name: '保险库', version: 'v1.0.0', desc: '保单、证件、密码加密存储，AES 加密', author: '大鹏', category: '安全', require_license: false, icon: '🔐' },
  { module_id: 'health_wearable', name: '穿戴设备同步', version: 'v0.1.0', desc: '同步华为/小米手环心率、睡眠、步数数据', author: '大鹏', category: '健康', require_license: false, icon: '⌚', planned: true },
  { module_id: 'ai_bill_extract', name: 'AI 票据识别增强', version: 'v0.2.0', desc: '拍照自动识别发票/小票，提取金额商家日期', author: '大鹏', category: 'AI', require_license: false, icon: '🧾', planned: true },
  { module_id: 'family_calendar', name: '家庭共享日历', version: 'v0.1.0', desc: '多人共享日历，家人自动同步生日/预约', author: '大鹏', category: '协作', require_license: false, icon: '📅', planned: true },
  { module_id: 'stock_watch', name: '持仓盯盘', version: 'v0.1.0', desc: '股票/基金持仓监控，涨跌提醒', author: '大鹏', category: '理财', require_license: false, icon: '📈', planned: true },
  { module_id: 'home_iot', name: '智能家居面板', version: 'v0.1.0', desc: '接入 Home Assistant，远程控制家电', author: '大鹏', category: '生活', require_license: false, icon: '🏠', planned: true }
];

module.exports = {
  BUILTIN_MODULES,
  STORE_DEMO,
  ensureModules,
};
