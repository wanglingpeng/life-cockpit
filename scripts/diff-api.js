/* API 差异：将当前路由清单与基线 scripts/.routes-baseline.json 对比，
 * 报告新增/移除的接口。基线不存在时自动建立（首次运行仅建基线，不告警）。
 * 用于「改了路由却忘了同步文档/前端」的回归捕获。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { allRoutes } = require('./route-inventory');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, '.routes-baseline.json');
const cur = allRoutes();

if (!fs.existsSync(BASE)) {
  fs.writeFileSync(BASE, JSON.stringify({ generatedAt: new Date().toISOString(), routes: cur }, null, 2));
  console.log('✓ 已建立路由基线（' + cur.length + ' 条），下次运行起将检测漂移');
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASE, 'utf8')).routes || [];
const added = cur.filter(r => !base.includes(r));
const removed = base.filter(r => !cur.includes(r));

if (!added.length && !removed.length) {
  console.log('✓ API 路由与基线一致（' + cur.length + ' 条，无漂移）');
  process.exit(0);
}
if (added.length) { console.log('➕ 新增路由：'); added.forEach(r => console.log('   + ' + r)); }
if (removed.length) { console.log('➖ 移除路由：'); removed.forEach(r => console.log('   - ' + r)); }
// 路由增减不一定是错误（功能演进），仅作提示，不阻断流水线
process.exit(0);
