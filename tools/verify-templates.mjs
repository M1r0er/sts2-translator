/**
 * 自检：用模板正则匹配「渲染后的英文描述」，把回填结果与官方渲染中文比对。
 * 这是词典可靠性的核心验证——模板必须能还原官方中文，否则宁可不用模板。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data-source');
const dict = JSON.parse(readFileSync(join(ROOT, 'extension', 'data', 'sts2-dict.json'), 'utf8'));

const TAG_RE = /\[\/?[a-zA-Z]+(?::[^\[\]]*)?\]/g;
const strip = (s) => (typeof s === 'string' ? s.replace(TAG_RE, '') : '');

const tpls = dict.templates.map((t) => ({ ...t, regex: new RegExp(t.re, t.flags) }));

function applyTemplate(text) {
  // 模板基于「去标记」文本构建，故先剥标记再匹配
  const clean = strip(text);
  for (const t of tpls) {
    const m = t.regex.exec(clean);
    if (!m) continue;
    const vars = m.groups || {};
    const out = t.zh.replace(/\$\{v_([A-Za-z0-9_]+)\}/g, (_, name) => (vars['v_' + name] ?? '').toString());
    return { out, id: t.id, cat: t.cat };
  }
  return null;
}

const norm = (s) =>
  strip(s)
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[。．.]/g, '')
    .trim();

const load = (name) => ({
  en: JSON.parse(readFileSync(join(SRC, 'eng', name + '.json'), 'utf8')),
  zh: JSON.parse(readFileSync(join(SRC, 'zhs', name + '.json'), 'utf8')),
});

const report = {};

function checkSet(label, enList, zhList, field) {
  const zmap = new Map(zhList.map((x) => [x.id, x]));
  let hit = 0;
  let exact = 0;
  let mismatch = 0;
  const misses = [];
  const bad = [];
  for (const e of enList) {
    const enText = e[field];
    if (typeof enText !== 'string' || !enText.trim()) continue;
    const z = zmap.get(e.id);
    if (!z) continue;
    const zhText = z[field];
    if (typeof zhText !== 'string' || !zhText.trim()) continue;
    const r = applyTemplate(enText);
    if (!r) {
      misses.push({ id: e.id, en: enText });
      continue;
    }
    hit += 1;
    if (norm(r.out) === norm(zhText)) exact += 1;
    else {
      mismatch += 1;
      if (bad.length < 8) bad.push({ id: e.id, tpl: r.id, got: r.out, want: zhText });
    }
  }
  report[label] = { total: enList.length, hit, exact, mismatch, miss: misses.length };
  console.log(
    `${label.padEnd(12)} 命中 ${String(hit).padStart(4)}  完全一致 ${String(exact).padStart(4)}  不一致 ${String(mismatch).padStart(3)}  未命中 ${String(misses.length).padStart(3)}`
  );
  for (const b of bad) {
    console.log(`  ✗ ${b.id} [${b.tpl}]`);
    console.log(`    得到: ${JSON.stringify(b.got)}`);
    console.log(`    官方: ${JSON.stringify(b.want)}`);
  }
  if (misses.length) {
    console.log(`  · 未命中示例 (${label}):`);
    for (const m of misses.slice(0, 4)) console.log(`    ${m.id}: ${JSON.stringify(m.en.slice(0, 110))}`);
  }
}

for (const [label, file, field] of [
  ['cards', 'cards', 'description'],
  ['cards:up', 'cards', 'upgrade_description'],
  ['relics', 'relics', 'description'],
  ['potions', 'potions', 'description'],
  ['powers', 'powers', 'description'],
  ['orbs', 'orbs', 'description'],
  ['enchant', 'enchantments', 'description'],
  ['glossary', 'glossary', 'description'],
]) {
  const { en, zh } = load(file);
  checkSet(label, en, zh, field);
}
