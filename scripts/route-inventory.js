/* 路由清单：枚举全部 API 路由（server.js + src/modules/*.routes.js），
 * 输出「方法 路径」排序列表。被 npm run arch:routes 与 diff:api 共用。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function collectRoutesFromFile(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const src = fs.readFileSync(file, 'utf8');
  // router.<method>('...', ...) 或 app.<method>('...', ...)
  const re = /\b(?:router|app)\.(get|post|put|delete|del|patch)\(\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(src))) out.push((m[1].toUpperCase()) + ' ' + m[3]);
  return out;
}

function allRoutes() {
  const routes = [];
  routes.push(...collectRoutesFromFile(path.join(ROOT, 'server.js')));
  const modDir = path.join(ROOT, 'src/modules');
  if (fs.existsSync(modDir)) {
    for (const f of fs.readdirSync(modDir)) {
      if (/routes\.js$/.test(f)) routes.push(...collectRoutesFromFile(path.join(modDir, f)));
    }
  }
  return [...new Set(routes)].sort();
}

if (require.main === module) {
  const routes = allRoutes();
  console.log('=== 路由清单（' + routes.length + ' 条）===');
  routes.forEach(r => console.log(r));
  console.log('\n共 ' + routes.length + ' 条路由');
}

module.exports = { allRoutes };
