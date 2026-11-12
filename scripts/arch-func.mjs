// 函数级架构体检（信息性，不阻断流水线）：统计每个业务模块的导出函数数量与
// 文件体量，标记潜在的「上帝模块」；顺便清点 TODO/FIXME 遗留。结果为观察项。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'lib', 'public/js'];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);

let todo = 0, godModules = 0;
console.log('=== 模块体量 / 函数数（观察项）===');
for (const f of files.sort()) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n').length;
  const exportsN = (src.match(/module\.exports\s*=|\bexports\.[A-Za-z0-9_]+\s*=/g) || []).length;
  todo += (src.match(/\b(TODO|FIXME|XXX)\b/g) || []).length;
  const rel = path.relative(ROOT, f);
  const flag = lines > 1200 ? '  ⚠ 大文件' : '';
  if (lines > 1200) godModules++;
  console.log(rel.padEnd(40), String(lines).padStart(6) + ' 行', String(exportsN).padStart(4) + ' 导出' + flag);
}
console.log('-'.repeat(60));
console.log('源文件数:', files.length, '| TODO/FIXME:', todo, '| 大文件(>1200行):', godModules);
console.log('（本检查为信息性，不阻断 npm run check）');
process.exit(0);
