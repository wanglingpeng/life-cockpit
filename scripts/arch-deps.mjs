// 依赖闸门：本项目承诺「零运行时依赖、拷贝即运行」。本脚本扫描全部源码的
// require/import 说明符，凡是非相对（./ ../）、非 node: 内置、非 Node 内建模块的
// 外部依赖一律判为违规并退出码 1——避免有人悄悄引入 npm 包撑破「拷贝即运行」。
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['src', 'lib', 'public/js', 'server.js'];
// 仅匹配真实调用：require('x') 或 import ... from 'x' / import('x')。
// 用 \b 词边界避免把 important / 字符串里的 "import" 误判为依赖。
const RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files = [];
for (const s of SCAN) { const p = path.join(ROOT, s); if (fs.statSync(p, { bigint: false }).isDirectory()) walk(p, files); else files.push(p); }

const builtin = new Set(builtinModules);
const violations = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith('.') || spec.startsWith('/')) continue;          // 相对/绝对路径
    if (spec.startsWith('node:')) continue;                             // node: 内置
    if (builtin.has(spec)) continue;                                    // 内建模块
    violations.push(`${path.relative(ROOT, f)}  ->  ${spec}`);
  }
}

if (violations.length) {
  console.error('✖ 发现外部运行时依赖（违反零依赖承诺）：');
  violations.forEach(v => console.error('   ' + v));
  process.exit(1);
}
console.log('✓ 依赖闸门通过：零外部运行时依赖（仅 node: 内置 + 相对模块）');
process.exit(0);
