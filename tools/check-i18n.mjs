// 静态校验 i18n 字典：中文/英文 key 是否对齐、代码里用到的 key 是否存在、是否有没人用的 key
// 用法：node tools/check-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const i18nPath = path.join(root, 'src/shared/i18n.js');

const I18n = require(i18nPath);
const zh = Object.keys(I18n.dicts['zh-CN']);
const en = Object.keys(I18n.dicts['en-US']);

const onlyZh = zh.filter((k) => !en.includes(k));
const onlyEn = en.filter((k) => !zh.includes(k));

// 扫源码里 t('key' / T('key' / data-i18n="key" 的用法
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); continue; }
    if (/\.(js|html)$/.test(e.name) && p !== i18nPath) files.push(p);
  }
})(path.join(root, 'src'));

const used = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b[Tt]\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) used.add(m[1]);
}

const unknown = [...used].filter((k) => !I18n.has(k)).sort();
const unused = zh.filter((k) => !used.has(k)).sort();

const line = (s) => `  ${s}`;
let bad = 0;
if (onlyZh.length) { bad++; console.log(`✗ 英文缺 ${onlyZh.length} 个 key:`); onlyZh.forEach((k) => console.log(line(k))); }
if (onlyEn.length) { bad++; console.log(`✗ 中文缺 ${onlyEn.length} 个 key:`); onlyEn.forEach((k) => console.log(line(k))); }
if (unknown.length) { bad++; console.log(`✗ 代码里用了不存在的 key ${unknown.length} 个:`); unknown.forEach((k) => console.log(line(k))); }
if (unused.length) { console.log(`· 暂未被使用的 key ${unused.length} 个（提醒，不算失败）:`); unused.forEach((k) => console.log(line(k))); }

console.log(`\n中文 ${zh.length} 条 / 英文 ${en.length} 条 / 代码引用 ${used.size} 条`);
console.log(bad ? '✗ 字典不一致' : '✓ 字典一致');
process.exit(bad ? 1 : 0);
