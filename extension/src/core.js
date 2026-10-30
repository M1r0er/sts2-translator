/**
 * STS2 翻译器核心逻辑（纯函数，无 DOM / 无网络）
 * 经典脚本形式挂到 globalThis.STS2Core，content.js 与 Node 单测共用同一份实现。
 *
 * 数据格式（extension/data/sts2-dict.json）：
 *   { meta, names:{key:zh}, terms:{key:zh}, exact:{key:zh},
 *     templates:[{id,cat,re,flags,zh,vars}] }
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ 文本工具

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const LATIN_RE = /[A-Za-z]{2,}/;
  // 游戏文本标记：[gold]…[/gold]、[blue]…[/blue]、[energy:1]、[star:2]、[E]
  const MARKUP_RE = /\[\/?[a-zA-Z]+(?::[^\[\]]*)?\]/g;

  function stripMarkup(s) {
    return typeof s === 'string' ? s.replace(MARKUP_RE, '') : '';
  }

  function collapse(s) {
    return String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim();
  }

  /** 字典键：去标记 → 折叠空白 → 小写 → 去首尾标点。 */
  function key(s) {
    return collapse(stripMarkup(s))
      .toLowerCase()
      .replace(/^[\s.,;:!?…"'“”‘’·()（）]+|[\s.,;:!?…"'“”‘’·()（）]+$/g, '');
  }

  /** 保留首尾空白，避免替换后行内元素之间粘连或丢空格。 */
  function splitWhitespace(raw) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    if (!m) return { lead: '', core: raw, trail: '' };
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  /** 这段文本是否值得翻译（跳过代码、URL、纯数字、已含中文）。 */
  function shouldTranslate(raw) {
    const t = collapse(raw);
    if (!t || t.length < 2) return false;
    if (!LATIN_RE.test(t)) return false;
    if (/^(https?:\/\/|www\.|mailto:|tel:)/i.test(t)) return false;
    if (/^[\w.+-]+@[\w.-]+$/.test(t)) return false;
    // 已含中文且拉丁内容很少 → 视为已翻译
    if (CJK_RE.test(t) && (t.match(/[A-Za-z]/g) || []).length < 6) return false;
    return true;
  }

  // ------------------------------------------------------------ 匹配器

  /** 把字典编译成可快速查询的结构。 */
  function buildMatcher(dict) {
    const names = (dict && dict.names) || {};
    const terms = (dict && dict.terms) || {};
    const exact = (dict && dict.exact) || {};

    // 名称/术语合并成一张表，名称优先
    const termMap = new Map();
    for (const [k, v] of Object.entries(terms)) if (v) termMap.set(k, v);
    for (const [k, v] of Object.entries(names)) if (v) termMap.set(k, v);

    const exactMap = new Map();
    for (const [k, v] of Object.entries(exact)) if (v) exactMap.set(k, v);

    // 用于在句内保护术语的正则：按长度降序，加词边界
    const termKeys = Array.from(termMap.keys())
      .filter((k) => k.length >= 2 && /[a-z]/.test(k))
      .sort((a, b) => b.length - a.length);
    let termRe = null;
    if (termKeys.length) {
      try {
        termRe = new RegExp(
          '(?<![A-Za-z0-9])(?:' +
            termKeys.map(escapeRegExp).join('|') +
            ')(?![A-Za-z0-9])',
          'gi'
        );
      } catch (err) {
        termRe = null;
      }
    }

    // 模板：长的（更具体的）优先
    const templates = ((dict && dict.templates) || [])
      .filter((t) => t && t.re && t.zh)
      .map((t) => {
        let re = null;
        try {
          re = new RegExp(t.re, t.flags || 'i');
        } catch (err) {
          return null;
        }
        return { id: t.id, cat: t.cat, re, zh: t.zh, weight: t.re.length };
      })
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight);

    return { termMap, exactMap, termRe, templates, meta: (dict && dict.meta) || {} };
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 整段精确查官方中文（最高质量）。 */
  function lookupExact(text, m) {
    if (!m || !m.exactMap) return null;
    const k = key(text);
    if (!k) return null;
    let hit = m.exactMap.get(k);
    if (hit) return hit;
    // 站点可能省略句末标点
    hit = m.exactMap.get(k.replace(/[.!?…]+$/, ''));
    if (hit) return hit;
    return null;
  }

  /** 单词/短语级官方译名。 */
  function lookupTerm(text, m) {
    if (!m || !m.termMap) return null;
    const k = key(text);
    if (!k) return null;
    return m.termMap.get(k) || m.termMap.get(k.replace(/[.!?…]+$/, '')) || null;
  }

  /** 模板匹配：Deal 6 damage. → 造成 6 点伤害。 */
  function matchTemplate(text, m) {
    if (!m || !m.templates || !m.templates.length) return null;
    const clean = stripMarkup(text);
    for (const t of m.templates) {
      const hit = t.re.exec(clean);
      if (!hit) continue;
      const groups = hit.groups || {};
      const out = t.zh.replace(/\$\{v_([A-Za-z0-9_]+)\}/g, (whole, name) => {
        const v = groups['v_' + name];
        return v === undefined ? '' : String(v);
      });
      if (out) return out;
    }
    return null;
  }

  /**
   * 离线翻译一段文本：精确 → 模板 → 名称/术语。
   * 返回 {zh, via} 或 null（需要机翻兜底）。
   */
  function translateOffline(text, m) {
    // 单个词优先走词级术语表：整句词典里的同名单词往往是某条长描述被截断的
    // 残句（例如 power 在 exact 里是「力量……」），不该压过实体译名「能力」。
    if (isSingleWord(text)) {
      const word = lookupTerm(text, m);
      if (word) return { zh: word, via: 'term' };
    }
    const exact = lookupExact(text, m);
    if (exact) return { zh: exact, via: 'exact' };
    const tpl = matchTemplate(text, m);
    if (tpl) return { zh: tpl, via: 'template' };
    const term = lookupTerm(text, m);
    if (term) return { zh: term, via: 'term' };
    return null;
  }

  /** 判断是否为「一个词」（没有空白、不是句子）。 */
  function isSingleWord(text) {
    const t = collapse(String(text || ''));
    return t.length > 0 && t.length <= 24 && !/\s/.test(t);
  }

  // ------------------------------------------------------------ 术语保护（机翻兜底用）

  /**
   * 把句内术语换成 {{tN}}，避免机翻把它们译错。
   * 返回 {text, slots:[{id,zh}], nextBase}。
   */
  function protectTerms(text, m, base) {
    const slots = [];
    let id = base || 0;
    if (!m || !m.termRe || !text) return { text: text || '', slots, nextBase: id };
    const re = new RegExp(m.termRe.source, m.termRe.flags);
    const out = text.replace(re, (hit) => {
      const zh = m.termMap.get(key(hit));
      if (!zh) return hit;
      const token = '{{t' + id + '}}';
      slots.push({ id, zh });
      id += 1;
      return token;
    });
    return { text: out, slots, nextBase: id };
  }

  function restoreTerms(text, slots) {
    if (!slots || !slots.length) return text;
    const map = new Map(slots.map((s) => [s.id, s.zh]));
    return String(text).replace(/\{\{t(\d+)\}\}/g, (whole, id) => {
      const zh = map.get(Number(id));
      return zh === undefined ? whole : zh;
    });
  }

  /** 机翻结果里占位符是否按序完整保留。 */
  function markersIntact(translated, expectedIds) {
    const found = [];
    const re = /\{\{t(\d+)\}\}/g;
    let hit;
    while ((hit = re.exec(String(translated)))) found.push(Number(hit[1]));
    if (found.length !== expectedIds.length) return false;
    for (let i = 0; i < found.length; i += 1) if (found[i] !== expectedIds[i]) return false;
    return true;
  }

  /** 把多段拼成一个请求体，用 {{bN}} 标记段落边界。 */
  function buildChunk(segments, baseBlock) {
    const base = baseBlock || 0;
    return segments.map((s, i) => '{{b' + (base + i) + '}}' + s.text).join('\n');
  }

  /** 从机翻结果按 {{bN}} 切回各段；失败返回 null。 */
  function splitChunk(translated, baseBlock, count) {
    const out = new Array(count).fill(null);
    const re = /\{\{b(\d+)\}\}/g;
    const marks = [];
    let hit;
    const s = String(translated);
    while ((hit = re.exec(s))) marks.push({ id: Number(hit[1]), index: hit.index, len: hit[0].length });
    if (marks.length !== count) return null;
    for (let i = 0; i < marks.length; i += 1) {
      const local = marks[i].id - baseBlock;
      if (local < 0 || local >= count || out[local] !== null) return null;
      const start = marks[i].index + marks[i].len;
      const end = i + 1 < marks.length ? marks[i + 1].index : s.length;
      out[local] = s.slice(start, end).trim();
    }
    return out.some((x) => x === null) ? null : out;
  }

  /** 按字符预算分组，保证单请求不超长。 */
  function planChunks(items, maxChars) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const item of items) {
      const cost = String(item.text).length + 8;
      if (current.length && size + cost > maxChars) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += cost;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  // ------------------------------------------------------------ 跨文本节点分配

  /**
   * 把一段中文按「锚点」分配到块内多个文本节点。
   *
   * 站点把关键词拆进行内元素（如 <span class="kw">Vulnerable</span>），
   * 一条描述因此横跨多个文本节点。中文语序与英文不同，不能逐节点替换。
   * 做法：找出那些「英文本身就能精确查到官方译名」的节点（锚点），
   * 在中文串里按序定位它们，锚点之间/前后的文字分给其余节点。
   *
   * nodes: [{ en: 原文, zh: 已确定的译名|null }]  按文档顺序
   * 返回: 每个节点的中文（字符串数组），无法分配时返回 null。
   */
  function distribute(zh, nodes) {
    const text = String(zh);
    const pins = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const z = nodes[i].zh;
      if (!z || !z.length) continue;
      // 该节点有确定译名，却在中文字串里找不到 → 说明整段译文与节点结构对不上，
      // 继续分配只会把中文塞错位置，直接判失败让调用方回退到整块替换。
      if (!text.includes(z)) return null;
      pins.push({ i, z });
    }

    // 校验锚点在中文里按序出现且不重叠
    let cursor = 0;
    const spans = [];
    for (const p of pins) {
      const at = text.indexOf(p.z, cursor);
      if (at === -1) return null;
      spans.push({ i: p.i, z: p.z, at, end: at + p.z.length });
      cursor = at + p.z.length;
    }

    const out = new Array(nodes.length).fill('');
    // 填充两个锚点之间的空隙：整段给空隙里的第一个节点，其余清空
    const fillGap = (from, to, gapText) => {
      const targets = [];
      for (let i = from; i < to; i += 1) if (!isPin(i)) targets.push(i);
      if (!targets.length) return gapText.length === 0;
      // 空隙文本有内容却无处安放 → 分配失败
      if (gapText.trim() && targets.length === 0) return false;
      out[targets[0]] = gapText;
      for (let k = 1; k < targets.length; k += 1) out[targets[k]] = '';
      return true;
    };
    const pinIndexes = new Set(spans.map((s) => s.i));
    const isPin = (i) => pinIndexes.has(i);

    let prevEnd = 0;
    let prevPin = -1;
    for (const s of spans) {
      if (!fillGap(prevPin + 1, s.i, text.slice(prevEnd, s.at))) return null;
      out[s.i] = s.z;
      prevEnd = s.end;
      prevPin = s.i;
    }
    if (!fillGap(prevPin + 1, nodes.length, text.slice(prevEnd))) return null;

    // 没有任何内容被丢弃才算成功
    if (out.join('').replace(/\s+/g, '') !== text.replace(/\s+/g, '')) {
      // 允许空白差异；差异过大说明分配错位
      const a = out.join('').replace(/\s+/g, '');
      const b = text.replace(/\s+/g, '');
      if (a.length !== b.length) return null;
    }
    return out;
  }

  root.STS2Core = {
    CJK_RE,
    LATIN_RE,
    stripMarkup,
    collapse,
    key,
    splitWhitespace,
    shouldTranslate,
    escapeRegExp,
    buildMatcher,
    lookupExact,
    lookupTerm,
    matchTemplate,
    translateOffline,
    protectTerms,
    restoreTerms,
    markersIntact,
    buildChunk,
    splitChunk,
    planChunks,
    distribute,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
