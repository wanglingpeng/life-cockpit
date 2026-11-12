// 鉴权架构护栏：P0-2 修复的核心是「router 声明的 auth/role 不再只是元数据，
// 由 handleApi 统一消费」。本脚本确认：① server.js 存在统一门禁；② 至少存在
// 若干 admin 路由声明（auth:'admin' / role:'admin'），而非靠各 handler 自觉 isAdmin。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const server = read('server.js');
const gateOk = /route\.auth\s*===\s*'admin'\s*\|\|\s*route\.role\s*===\s*'admin'/.test(server);
if (!gateOk) { console.error('✖ server.js 缺少统一管理员门禁'); process.exit(1); }

// 统计所有路由模块里声明了 admin 的接口数
let adminCount = 0, routeCount = 0;
const modDir = path.join(ROOT, 'src/modules');
for (const f of fs.readdirSync(modDir)) {
  if (!/routes\.js$/.test(f)) continue;
  const s = read(path.join('src/modules', f));
  const re = /router\.(get|post|put|delete|del)\(\s*['"][^'"]+['"]/g;
  let m; while ((m = re.exec(s))) routeCount++;
  const adm = s.match(/auth:\s*'admin'|role:\s*'admin'/g) || [];
  adminCount += adm.length;
}

console.log(`✓ 统一管理员门禁存在；共 ${routeCount} 条路由，其中 ${adminCount} 条声明为 admin`);
if (adminCount === 0) { console.error('✖ 没有任何 admin 路由声明，鉴权门禁形同虚设'); process.exit(1); }
console.log('✓ 鉴权架构护栏通过');
process.exit(0);
