// 代码体量统计：按目录累计行数（.js/.mjs/.css/.html）。零依赖，仅用 node: 内置模块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['src', 'public/js', 'public/css', 'lib'];

function countLines(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countLines(p);
    else if (/\.(js|mjs|css|html)$/.test(e.name)) {
      try { n += fs.readFileSync(p, 'utf8').split('\n').length; } catch (e) {}
    }
  }
  return n;
}

console.log('=== 代码体量（行）===');
let total = 0;
for (const d of TARGETS) { const c = countLines(path.join(ROOT, d)); total += c; console.log(d.padEnd(14), c); }
console.log('-'.repeat(22));
console.log('TOTAL'.padEnd(14), total);
process.exit(0);
