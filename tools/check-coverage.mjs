/**
 * 覆盖率自检：对官方全部「渲染后英文描述」，统计
 *   1) 精确字典能否直接命中（最高质量：整句官方中文）
 *   2) 仅模板能命中（次高质量：官方模板回填）
 *   3) 两者都不能（需机翻兜底）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data-source');
const dict = JSON.parse(readFileSync(join(ROOT, 'extension', 'data', 'sts2-dict.json'), 'utf8'));

const TAG_RE = /\[\/?[a-zA-Z]+(?::[^\[\]]*)?\]/g;
const strip = (s) => (typeof s === 'string' ? s.replace(TAG_RE, '') : '');
const key = (s) =>
  strip(s)
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[\s.,;:!?…"'“”‘’·]+|[\s.,;:!?…"'“”‘’·]+$/g, '');

const tpls = dict.templates.map((t) => ({ ...t, regex: new RegExp(t.re, t.flags) }));

const load = (n) => ({
  en: JSON.parse(readFileSync(join(SRC, 'eng', n + '.json'), 'utf8')),
  zh: JSON.parse(readFileSync(join(SRC, 'zhs', n + '.json'), 'utf8')),
});

let exactHit = 0;
let tplOnly = 0;
let neither = 0;
const neitherList = [];

for (const [file, fields] of [
  ['cards', ['description', 'upgrade_description']],
  ['relics', ['description']],
  ['potions', ['description']],
  ['powers', ['description']],
  ['orbs', ['description']],
  ['enchantments', ['description']],
  ['glossary', ['description']],
  ['intents', ['description']],
  ['afflictions', ['description']],
  ['modifiers', ['description']],
  ['badges', ['description']],
  ['achievements', ['description']],
  ['ascensions', ['description']],
  ['characters', ['description']],
]) {
  const { en } = load(file);
  for (const e of en) {
    for (const f of fields) {
      const t = e[f];
      if (typeof t !== 'string' || !t.trim()) continue;
      if (dict.exact[key(t)]) {
        exactHit += 1;
        continue;
      }
      const clean = strip(t);
      if (tpls.some((x) => x.regex.test(clean))) {
        tplOnly += 1;
        continue;
      }
      neither += 1;
      if (neitherList.length < 20) neitherList.push({ file, id: e.id, f, t });
    }
  }
}

const total = exactHit + tplOnly + neither;
console.log(`总条目 ${total}`);
console.log(`精确字典命中 ${exactHit}  (${((exactHit / total) * 100).toFixed(1)}%)`);
console.log(`仅模板命中   ${tplOnly}  (${((tplOnly / total) * 100).toFixed(1)}%)`);
console.log(`均未命中     ${neither}  (${((neither / total) * 100).toFixed(1)}%)`);
console.log('\n未命中示例:');
for (const x of neitherList) console.log(`  ${x.file}/${x.id}.${x.f}: ${JSON.stringify(x.t.slice(0, 100))}`);
