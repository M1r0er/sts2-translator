import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 以经典脚本方式加载，和 content script 完全一致
const src = readFileSync(join(ROOT, 'extension', 'src', 'core.js'), 'utf8');
new Function(src)();
const C = globalThis.STS2Core;

const dict = JSON.parse(readFileSync(join(ROOT, 'extension', 'data', 'sts2-dict.json'), 'utf8'));
const M = C.buildMatcher(dict);

test('collapse 与 key 归一化', () => {
  assert.equal(C.collapse('  a \n\t b  '), 'a b');
  assert.equal(C.key('Deal 8 damage. '), 'deal 8 damage');
  assert.equal(C.key('[gold]Vulnerable[/gold].'), 'vulnerable');
  assert.equal(C.key('[energy:1]'), '');
});

test('stripMarkup 去掉所有游戏标记', () => {
  assert.equal(C.stripMarkup('[gold]Block[/gold]'), 'Block');
  assert.equal(C.stripMarkup('Add a 0[energy:1] copy'), 'Add a 0 copy');
  assert.equal(C.stripMarkup('[star:2]'), '');
});

test('shouldTranslate 跳过非自然语言', () => {
  assert.equal(C.shouldTranslate('Deal 8 damage.'), true);
  assert.equal(C.shouldTranslate('https://sts2.app/docs'), false);
  assert.equal(C.shouldTranslate('foo@bar.com'), false);
  assert.equal(C.shouldTranslate('12345'), false);
  assert.equal(C.shouldTranslate(''), false);
  assert.equal(C.shouldTranslate('造成8点伤害。'), false);
});

test('splitWhitespace 保留首尾空白', () => {
  const r = C.splitWhitespace('  Deal 8 damage.  ');
  assert.equal(r.lead, '  ');
  assert.equal(r.core, 'Deal 8 damage.');
  assert.equal(r.trail, '  ');
});

test('精确字典能查到官方中文', () => {
  assert.equal(C.lookupExact('Deal 8 damage. Apply 2 Vulnerable.', M), '造成8点伤害。\n给予2层易伤。');
  assert.equal(C.lookupExact('[gold]Deal[/gold] 8 damage. Apply 2 [gold]Vulnerable[/gold].', M), '造成8点伤害。\n给予2层易伤。');
});

test('术语表给出官方译名', () => {
  assert.equal(C.lookupTerm('Vulnerable', M), '易伤');
  assert.equal(C.lookupTerm('Block', M), '格挡');
  assert.equal(C.lookupTerm('Exhaust', M), '消耗');
  assert.equal(C.lookupTerm('Bash', M), '痛击');
  assert.equal(C.lookupTerm('Defend', M), '防御');
});

test('模板能把数值变体译对', () => {
  const r = C.matchTemplate('Deal 13 damage.', M);
  assert.equal(r, '造成13点伤害。');
});

test('translateOffline 优先级：精确 > 模板 > 术语', () => {
  assert.equal(C.translateOffline('Deal 8 damage.\nApply 2 Vulnerable.', M).via, 'exact');
  assert.equal(C.translateOffline('Deal 999 damage.', M).via, 'template');
  // exact 词典本身包含全部单词级官方译名，故单词也走 exact
  const word = C.translateOffline('Vulnerable', M);
  assert.equal(word.zh, '易伤');
  assert.ok(['exact', 'term'].includes(word.via));
  assert.equal(C.translateOffline('The quick brown fox jumps.', M), null);
});

test('术语保护与回填', () => {
  const p = C.protectTerms('Apply 3 Vulnerable and gain Block.', M, 0);
  assert.ok(p.text.includes('{{t0}}'));
  assert.ok(!/Vulnerable/.test(p.text));
  assert.equal(p.slots.length, 2);
  assert.equal(C.restoreTerms(p.text, p.slots), 'Apply 3 易伤 and gain 格挡.');
});

test('占位符完整性校验', () => {
  assert.equal(C.markersIntact('{{t0}} 和 {{t1}}', [0, 1]), true);
  assert.equal(C.markersIntact('{{t0}} 和 {{t1}}', [0]), false);
  assert.equal(C.markersIntact('{{t1}} 和 {{t0}}', [0, 1]), false);
});

test('分段拼装与切回', () => {
  const segs = [{ text: 'Deal 8 damage.' }, { text: 'Gain 5 Block.' }];
  const chunk = C.buildChunk(segs, 0);
  assert.equal(chunk, '{{b0}}Deal 8 damage.\n{{b1}}Gain 5 Block.');
  const back = C.splitChunk('{{b0}}造成8点伤害。\n{{b1}}获得5点格挡。', 0, 2);
  assert.deepEqual(back, ['造成8点伤害。', '获得5点格挡。']);
  assert.equal(C.splitChunk('只有一段', 0, 2), null);
});

test('planChunks 按预算分组', () => {
  const items = [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(100) }, { text: 'c'.repeat(100) }];
  const chunks = C.planChunks(items, 250);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 2);
});

test('distribute：关键词被行内元素拆开时按锚点回填', () => {
  // 站点实际结构：Deal 8 damage. Apply 2 <span class="kw">Vulnerable</span>.
  const nodes = [{ en: 'Deal 8 damage. Apply 2 ', zh: null }, { en: 'Vulnerable', zh: '易伤' }, { en: '.', zh: null }];
  const out = C.distribute('造成8点伤害。\n给予2层易伤。', nodes);
  assert.ok(out, '应当分配成功');
  assert.equal(out.join('').replace(/\s+/g, ''), '造成8点伤害。给予2层易伤。'.replace(/\s+/g, ''));
  assert.equal(out[1], '易伤');
});

test('distribute：多锚点保持顺序', () => {
  const nodes = [
    { en: 'Gain 5 ', zh: null },
    { en: 'Block', zh: '格挡' },
    { en: '. Deal 6 damage and apply ', zh: null },
    { en: 'Weak', zh: '虚弱' },
    { en: '.', zh: null },
  ];
  const out = C.distribute('获得5点格挡。造成6点伤害并给予虚弱。', nodes);
  assert.ok(out);
  assert.equal(out[1], '格挡');
  assert.equal(out[3], '虚弱');
});

test('distribute：无锚点时整段给第一个节点', () => {
  const nodes = [{ en: 'Hello ', zh: null }, { en: 'world', zh: null }];
  const out = C.distribute('你好世界', nodes);
  assert.ok(out);
  assert.equal(out[0], '你好世界');
  assert.equal(out[1], '');
});

test('distribute：锚点缺失时返回 null 而非错位', () => {
  const nodes = [{ en: 'x', zh: null }, { en: 'Vulnerable', zh: '易伤' }];
  const out = C.distribute('完全不同的一段中文', nodes);
  assert.equal(out, null);
});
