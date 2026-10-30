/**
 * 从 spire-codex 官方双语数据（data-source/{eng,zhs}）构建扩展用的翻译词典。
 *
 * 产出 extension/data/：
 *   - sts2-dict.json  { names, terms, exact, templates } 单文件，content.js 一次 fetch
 *
 * 原则：只用官方数据，不做臆造；对齐不上的条目丢弃并记入 research/build-warnings.txt。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data-source');
const OUT = join(ROOT, 'extension', 'data');

// 优先级：数字越小越可信，冲突时保留小的
const P = {
  glossary: 0,
  keyword: 1,
  enum: 2,
  name: 3,
  description: 4,
  ui: 5,
};

// 官方就沿用英文的词：中英两侧相同，但保留原样才是正确译名。
const KEEP_AS_IS = new Set(['Boss', 'HP', 'XP', 'Buff', 'Debuff']);

// 对话/事件/制作名单分组：这里的单词是台词与选项残片（Search=仔细翻找、
// Continue=继续、its=它的），不能当作通用 UI 词汇收进词典。
const DIALOGUE_GROUPS = new Set(['ancients', 'characters', 'credits', 'events', 'epochs', 'rich_presence']);

// ---------------------------------------------------------------- 归一化

// 游戏文本里的标记形如 [gold]…[/gold]、[blue]…[/blue]、[energy:1]、[star:2]、[E]
const TAG_RE = /\[\/?[a-zA-Z]+(?::[^\[\]]*)?\]/g;

function stripMarkup(s) {
  if (typeof s !== 'string') return '';
  return s.replace(TAG_RE, '');
}

/** 字典键：去标记 → 折叠空白 → 小写 → 去首尾标点。 */
function key(s) {
  return stripMarkup(s)
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[\s.,;:!?…"'“”‘’·]+|[\s.,;:!?…"'“”‘’·]+$/g, '');
}

/** 展示值：去标记，保留换行。 */
function display(s) {
  return stripMarkup(s).replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
}

// ---------------------------------------------------------------- 大括号解析

/** s[i] === '{'，返回配对的结束位置与内容。 */
function parseBraced(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') {
      depth -= 1;
      if (depth === 0) {
        const inner = s.slice(i + 1, j);
        const colon = inner.indexOf(':');
        return {
          end: j + 1,
          name: colon === -1 ? inner : inner.slice(0, colon),
          rest: colon === -1 ? '' : inner.slice(colon),
        };
      }
    }
  }
  return null; // 未闭合
}

/** 按顶层 `|` 切分（忽略嵌套括号内的竖线）。 */
function splitTopPipe(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------- 模板编译

const NUM = '(?:[0-9]+(?:\\.[0-9]+)?)';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 英文模板 → 正则源码。
 *   {X:diff()}        → (?<v_X>数字)
 *   {X:plural:a|b}    → (?:a|b)?
 *   {Cond:body|}      → (?:body)?
 */
function compileEnRegex(s, captured) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      const p = parseBraced(s, i);
      if (!p) {
        out += escapeRegExp(s.slice(i));
        break;
      }
      const { name, rest } = p;
      if (/^:plural:/i.test(rest)) {
        const alts = rest.replace(/^:plural:/i, '').split('|');
        out += '(?:' + alts.map(escapeRegExp).join('|') + ')?';
      } else if (/^:diff\(\)$/i.test(rest)) {
        if (captured.has(name)) out += NUM;
        else {
          captured.add(name);
          out += '(?<v_' + name + '>' + NUM + ')';
        }
      } else {
        // 条件块或未知修饰：取 true 分支，整体可选
        const body = splitTopPipe(rest.replace(/^:/, ''))[0];
        if (body && body.trim()) out += '(?:' + compileEnRegex(body, captured) + ')?';
      }
      i = p.end;
    } else {
      out += escapeRegExp(s[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * 中文模板 → 输出串（含 ${v_X} 占位）。
 * 英文里有、中文里没有的变量 → 丢弃；条件块的条件变量未被捕获 → 整块丢弃。
 */
function compileZh(s, captured) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      const p = parseBraced(s, i);
      if (!p) {
        out += s.slice(i);
        break;
      }
      const { name, rest } = p;
      if (/^:diff\(\)$/i.test(rest)) {
        if (captured.has(name)) out += '${v_' + name + '}';
      } else if (/^:plural:/i.test(rest)) {
        // 中文无复数，丢弃
      } else {
        const body = splitTopPipe(rest.replace(/^:/, ''))[0];
        if (captured.has(name) && body && body.trim()) out += compileZh(body, captured);
        // 条件变量未被捕获 → 整块丢弃（中文通常已把条件信息写进正文）
      }
      i = p.end;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** 把正则源码里的空白变成宽容匹配：任意空白或没有。 */
function relaxWhitespace(re) {
  // \ 后跟空格 = 被转义的字面空格；\n 来自原文换行
  return re
    .replace(/\\ /g, '\\s+')
    .replace(/\\n/g, '\\s*')
    .replace(/\\\t/g, '\\s*');
}

function buildTemplate(enRaw, zhRaw, meta) {
  const en = stripMarkup(enRaw);
  const zh = stripMarkup(zhRaw);
  const captured = new Set();
  let src = compileEnRegex(en, captured);
  src = relaxWhitespace(src);
  const zhOut = compileZh(zh, captured)
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
  if (!zhOut) return null;
  return {
    id: meta.id,
    cat: meta.cat,
    re: new RegExp('^\\s*' + src + '\\s*$', 'i'),
    zh: zhOut,
    vars: Array.from(captured),
  };
}

// ---------------------------------------------------------------- 采集

const warnings = [];
const counters = {};

function bump(k, n = 1) {
  counters[k] = (counters[k] || 0) + n;
}

function load(name) {
  return {
    en: JSON.parse(readFileSync(join(SRC, 'eng', name + '.json'), 'utf8')),
    zh: JSON.parse(readFileSync(join(SRC, 'zhs', name + '.json'), 'utf8')),
  };
}

function pairById(name) {
  const { en, zh } = load(name);
  if (!Array.isArray(en) || !Array.isArray(zh)) return [];
  const zmap = new Map(zh.map((x) => [x.id, x]));
  const pairs = [];
  for (const e of en) {
    const z = zmap.get(e.id);
    if (!z) {
      warnings.push(`${name}: 中文缺 ${e.id}`);
      continue;
    }
    pairs.push([e, z]);
  }
  return pairs;
}

/** 带优先级的候选池，冲突时保留优先级高的。 */
function makePool() {
  const map = new Map();
  return {
    add(en, zh, priority, cat) {
      const k = key(en);
      const v = display(zh);
      if (!k || !v) return;
      if (k.length < 2) return;
      if (!/[a-z]/.test(k)) return;
      // events.json 的嵌套文本里混着 IRONCLAD / POTION / RELIC 这类占位 ID，
      // 中英两侧是同一个大写串（等于没翻译）。它们一旦进词典就会压过正确的
      // 实体译名（exact 的查找优先级最高），所以原文照抄的一律丢弃。
      // 例外：Boss 这类官方就沿用英文的词，保留原样也是正确译名。
      if (v === en && !KEEP_AS_IS.has(v)) return;
      const prev = map.get(k);
      if (prev) {
        if (prev.priority <= priority) {
          if (prev.zh !== v) {
            warnings.push(
              `冲突[${cat}] "${k.slice(0, 48)}": 保留 ${prev.zh}（${prev.cat} p${prev.priority}），丢弃 ${v}（${cat} p${priority}）`
            );
          }
          return;
        }
        warnings.push(
          `冲突[${cat}] "${k.slice(0, 48)}": 改用 ${v}（${cat} p${priority}）覆盖 ${prev.zh}（${prev.cat} p${prev.priority}）`
        );
      }
      map.set(k, { zh: v, priority, cat });
    },
    get size() {
      return map.size;
    },
    /** 导出为纯 key→zh 对象。 */
    toObject() {
      const out = {};
      for (const k of Array.from(map.keys()).sort()) out[k] = map.get(k).zh;
      return out;
    },
    has(k) {
      return map.has(k);
    },
  };
}

const names = makePool();
const exact = makePool();
const terms = makePool();
const templates = [];
const tplSeen = new Set();

function addTemplate(e, z, cat) {
  const en = e.description_raw;
  const zh = z.description_raw;
  if (typeof en !== 'string' || typeof zh !== 'string' || !en.trim() || !zh.trim()) return;
  const id = cat + '/' + e.id;
  if (tplSeen.has(id)) return;
  const t = buildTemplate(en, zh, { id: e.id, cat });
  if (!t) return;
  tplSeen.add(id);
  templates.push(t);
  bump('templates.' + cat);
}

// ---------------------------------------------------------------- 各类别

// 先收「最可信」的：关键词与枚举
{
  const kw = load('keywords');
  for (const e of kw.en) {
    const z = kw.zh.find((x) => x.id === e.id);
    if (!z) continue;
    terms.add(e.name, z.name, P.keyword, 'keyword');
    names.add(e.name, z.name, P.keyword, 'keyword');
    exact.add(e.description, z.description, P.keyword, 'keyword');
  }
}

{
  const tr = load('translations');
  for (const [group, dict] of Object.entries(tr.zh)) {
    if (!dict || typeof dict !== 'object') continue;
    for (const [en, zh] of Object.entries(dict)) {
      if (typeof zh !== 'string' || !zh || zh === en) continue;
      // translations.json 的 sections 组有 7 条官方没翻译（Characters / Events /
      // Encounters / Powers …中文侧直接是英文原文）。收进去只会返回英文，
      // 并压掉别处已有的正确译名，所以直接跳过。
      if (!/[\u4e00-\u9fff]/.test(zh)) continue;
      terms.add(en, zh, P.enum, 'enum:' + group);
      names.add(en, zh, P.enum, 'enum:' + group);
    }
  }
}

// glossary：机制词，最可信
for (const [e, z] of pairById('glossary')) {
  terms.add(e.name, z.name, P.glossary, 'glossary');
  names.add(e.name, z.name, P.glossary, 'glossary');
  exact.add(e.description, z.description, P.glossary, 'glossary');
}

// 实体名称与描述
for (const [e, z] of pairById('cards')) {
  names.add(e.name, z.name, P.name, 'card');
  exact.add(e.description, z.description, P.description, 'card');
  exact.add(e.upgrade_description, z.upgrade_description, P.description, 'card:up');
  addTemplate(e, z, 'card');
}
for (const [e, z] of pairById('relics')) {
  names.add(e.name, z.name, P.name, 'relic');
  exact.add(e.description, z.description, P.description, 'relic');
  exact.add(e.flavor, z.flavor, P.description, 'relic:flavor');
  addTemplate(e, z, 'relic');
}
for (const [e, z] of pairById('potions')) {
  names.add(e.name, z.name, P.name, 'potion');
  exact.add(e.description, z.description, P.description, 'potion');
  addTemplate(e, z, 'potion');
}
for (const [e, z] of pairById('powers')) {
  names.add(e.name, z.name, P.name, 'power');
  terms.add(e.name, z.name, P.name, 'power');
  exact.add(e.description, z.description, P.description, 'power');
  addTemplate(e, z, 'power');
}
for (const [e, z] of pairById('monsters')) names.add(e.name, z.name, P.name, 'monster');
for (const [e, z] of pairById('encounters')) {
  names.add(e.name, z.name, P.name, 'encounter');
  exact.add(e.loss_text, z.loss_text, P.description, 'encounter');
}
for (const [e, z] of pairById('characters')) {
  names.add(e.name, z.name, P.name, 'character');
  exact.add(e.description, z.description, P.description, 'character');
}
for (const [e, z] of pairById('acts')) names.add(e.name, z.name, P.name, 'act');
for (const [e, z] of pairById('orbs')) {
  names.add(e.name, z.name, P.name, 'orb');
  exact.add(e.description, z.description, P.description, 'orb');
  addTemplate(e, z, 'orb');
}
for (const [e, z] of pairById('intents')) {
  names.add(e.name, z.name, P.name, 'intent');
  exact.add(e.description, z.description, P.description, 'intent');
}
for (const [e, z] of pairById('afflictions')) {
  names.add(e.name, z.name, P.name, 'affliction');
  exact.add(e.description, z.description, P.description, 'affliction');
}
for (const [e, z] of pairById('enchantments')) {
  names.add(e.name, z.name, P.name, 'enchantment');
  exact.add(e.description, z.description, P.description, 'enchantment');
  exact.add(e.extra_card_text, z.extra_card_text, P.description, 'enchantment:extra');
  addTemplate(e, z, 'enchantment');
}
for (const [e, z] of pairById('rest_site_options')) names.add(e.name, z.name, P.name, 'rest');
for (const [e, z] of pairById('modifiers')) {
  names.add(e.name, z.name, P.name, 'modifier');
  exact.add(e.description, z.description, P.description, 'modifier');
}
for (const [e, z] of pairById('badges')) {
  names.add(e.name, z.name, P.name, 'badge');
  exact.add(e.description, z.description, P.description, 'badge');
}
for (const [e, z] of pairById('achievements')) {
  names.add(e.name, z.name, P.name, 'achievement');
  exact.add(e.description, z.description, P.description, 'achievement');
}
for (const [e, z] of pairById('ascensions')) {
  names.add(e.name, z.name, P.name, 'ascension');
  exact.add(e.description, z.description, P.description, 'ascension');
}
for (const [e, z] of pairById('epochs')) {
  names.add(e.title, z.title, P.name, 'epoch');
  exact.add(e.description, z.description, P.description, 'epoch');
  exact.add(e.unlock_text, z.unlock_text, P.description, 'epoch:unlock');
}

// 事件：递归配对名称/描述/页面正文/选项/对话
for (const [e, z] of pairById('events')) {
  names.add(e.name, z.name, P.name, 'event');
  names.add(e.epithet, z.epithet, P.name, 'event:epithet');
  exact.add(e.description, z.description, P.description, 'event');
  const walk = (a, b) => {
    if (typeof a === 'string') {
      // 单词级片段（选项标题、台词）不收进整句词典：它们是某个事件语境下的
      // 译法，放到网站按钮上就错（Search 在「满室奶酪」里是「仔细翻找」，
      // 而官方按钮文案是「搜索」）。
      if (typeof b === 'string' && /\s/.test(a.trim())) exact.add(a, b, P.description, 'event:text');
      return;
    }
    if (Array.isArray(a)) {
      if (!Array.isArray(b)) return;
      a.forEach((x, i) => walk(x, b[i]));
      return;
    }
    if (a && typeof a === 'object') {
      if (!b || typeof b !== 'object') return;
      for (const k of Object.keys(a)) walk(a[k], b[k]);
    }
  };
  walk(e.pages, z.pages);
  walk(e.options, z.options);
  walk(e.dialogue, z.dialogue);
}

// messages.json：UI 文案（优先级最低，且过滤明显非自然语言的长串）
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string') out.set(p, v);
    else if (v && typeof v === 'object') flatten(v, p, out);
  }
  return out;
}
{
  const { en, zh } = load('messages');
  const E = flatten(en, '', new Map());
  const Z = flatten(zh, '', new Map());
  let pairs = 0;
  let skippedWords = 0;
  for (const [path, ev] of E) {
    const zv = Z.get(path);
    if (typeof zv !== 'string' || !zv.trim()) continue;
    if (!/[A-Za-z]{2,}/.test(ev)) continue;
    if (ev.length > 220 || ev.includes('||')) continue; // 制作人员名单之类
    // 单词级条目只收非对话分组的：事件/对话分组里的单词是台词残片
    // （例如 events.ROOM_FULL_OF_CHEESE.options.SEARCH.title 的 Search
    // 是「仔细翻找」，而真正的按钮文案在 main_menu_ui 里是「搜索」）。
    const single = !/\s/.test(ev.trim());
    if (single && DIALOGUE_GROUPS.has(path.split('.')[0])) {
      skippedWords += 1;
      continue;
    }
    // 单词级 UI 标签常自带标点（"Send!"、"Seed:"）。键归一化会剥掉英文侧
    // 标点，所以中文侧也要剥掉，否则站点上不带冒号的 "Seed" 会得到「种子：」。
    const zhValue = single ? zv.trim().replace(/[：:！!。.？?…]+$/u, '') : zv;
    if (!zhValue) continue;
    pairs += 1;
    exact.add(ev, zhValue, P.ui, 'ui');
  }
  bump('messages.pairs', pairs);
  bump('messages.skippedWords', skippedWords);
}

// ---------------------------------------------------------------- 术语补充

// 正文高频机制词：全部来自官方数据，无臆造
const EXTRA_TERMS = [
  ['Draw Pile', '抽牌堆'],
  ['Discard Pile', '弃牌堆'],
  ['Exhaust Pile', '消耗牌堆'],
  ['Exhausted Cards', '消耗牌堆'],
  ['Card Reward', '卡牌奖励'],
  ['Hit Points', '生命值'],
  // 官方正文里 HP 一律译作「生命」（如 lose 5 HP → 失去5点生命），
  // 与全称 Hit Points 的「生命值」不同，按出现形态分开收录。
  ['HP', '生命'],
  ['Potion Slot', '药水栏位'],
  ['Rest Site', '休息处'],
  ['Treasure Room', '宝箱房'],
  ['Act', '阶段'],
  // 单数实体名词：站点导航与正文常用单数，官方数据里只有复数或大写 ID。
  ['Relic', '遗物'],
  ['Potion', '药水'],
  ['Card', '卡牌'],
  ['Enemy', '敌人'],
  ['Character', '角色'],
  ['Enchantment', '附魔'],
  ['Encounter', '遭遇战'],
  ['Ancient', '先古之民'],
  ['Power', '能力'],
  ['Skill', '技能'],
  ['Attack', '攻击'],
  // 按钮类 UI 用语：官方在 map.SHARE_POPUP.open 里译作「打开」，
  // 而 epochs 的章节标题 Open 译作「开放」，站点按钮应取前者。
  ['Open', '打开'],
];
for (const [en, zh] of EXTRA_TERMS) {
  terms.add(en, zh, P.glossary, 'extra');
  names.add(en, zh, P.glossary, 'extra');
}

// ---------------------------------------------------------------- 输出

mkdirSync(OUT, { recursive: true });

const compiled = [];
for (const t of templates) {
  try {
    // 自检：正则能编译（已在 buildTemplate 里构造），变量名合法
    compiled.push({ id: t.id, cat: t.cat, re: t.re.source, flags: 'i', zh: t.zh, vars: t.vars });
  } catch (err) {
    warnings.push(`模板失败 ${t.cat}/${t.id}: ${err.message}`);
  }
}
bump('templates.compiled', compiled.length);

const dict = {
  meta: {
    version: '1.0.0',
    source: 'ptrlrd/spire-codex (官方游戏文件反编译)',
    generated: new Date().toISOString(),
    counts: {
      names: names.size,
      terms: terms.size,
      exact: exact.size,
      templates: compiled.length,
    },
  },
  names: names.toObject(),
  terms: terms.toObject(),
  exact: exact.toObject(),
  templates: compiled,
};

const json = JSON.stringify(dict);
writeFileSync(join(OUT, 'sts2-dict.json'), json, 'utf8');
writeFileSync(join(ROOT, 'research', 'build-warnings.txt'), warnings.join('\n'), 'utf8');

console.log('=== 构建结果 ===');
console.log('names    :', names.size);
console.log('terms    :', terms.size);
console.log('exact    :', exact.size);
console.log('templates:', compiled.length);
console.log('文件大小 :', (json.length / 1024).toFixed(0), 'KB');
console.log('warnings :', warnings.length);
for (const w of warnings.slice(0, 12)) console.log('  !', w);
