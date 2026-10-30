/**
 * STS2 中文翻译器 —— 内容脚本
 *
 * 设计要点：
 * 1. 只改文本节点，不动元素、属性、结构 → 布局完全不变。
 * 2. 翻译单元 = 一个「块级容器」内的全部文本节点。站点把关键词拆进
 *    <span class="kw">，一条描述会跨多个节点，必须整块翻译再用锚点分配回去。
 * 3. 每个被改动的节点都记住原文，还原时逐字回填，做到无痕。
 * 4. 优先用内置官方词典（离线、瞬间、100% 官方译名），查不到才走机翻。
 */
(function () {
  'use strict';

  const C = globalThis.STS2Core;
  if (!C) {
    console.warn('[STS2] core.js 未加载，翻译器停用');
    return;
  }

  // ---------------------------------------------------------------- 配置

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'IFRAME',
    'OBJECT', 'EMBED', 'MATH', 'TEMPLATE',
  ]);
  // 用户/站点明确声明不翻译的区域
  const SKIP_ATTR = '[translate="no"], .notranslate, [data-sts2-skip]';

  const state = {
    enabled: false,
    dict: null,
    matcher: null,
    // 文本节点 → 原始字符串
    originals: new WeakMap(),
    // 已处理过的文本节点，避免观察者反复触发
    touched: new WeakSet(),
    // 被改动的节点（WeakSet 不可遍历，还原时需要普通集合）
    changed: [],
    observer: null,
    pending: null,
    stats: { offline: 0, machine: 0, failed: 0, nodes: 0 },
  };

  // ---------------------------------------------------------------- 词典

  async function loadDict() {
    if (state.dict) return state.dict;
    const url = chrome.runtime.getURL('data/sts2-dict.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error('词典加载失败 ' + res.status);
    state.dict = await res.json();
    state.matcher = C.buildMatcher(state.dict);
    return state.dict;
  }

  // ---------------------------------------------------------------- DOM 采集

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.matches && el.matches(SKIP_ATTR)) return true;
    const style = el.getAttribute && el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  /** 从某节点向上看，是否落在应跳过的子树里。 */
  function inSkippedSubtree(node, root) {
    let el = node.parentElement;
    while (el && el !== root) {
      if (isSkipped(el)) return true;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * 收集整页所有非空文本节点（含可见性过滤）。
   * 这里**不能**按单节点跑 shouldTranslate：一条被行内元素切开的描述，
   * 尾部的「.」这类纯标点节点会被判为「不值得翻译」而丢掉，
   * 之后整块中文的标点就无处安放，跨节点分配必然失败。
   * 「是否值得翻译」是整块层面的判断，放到 translatePage 里做。
   */
  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
        if (inSkippedSubtree(node, root || document.body)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // 计算样式拿不到 display 时的兜底（某些环境/未加载 CSS 的文档会返回空串）。
  // 必须按「默认行内」处理，否则 <span> 会被误判成翻译单元边界，
  // 导致一条被关键词切开的描述被拆成三段各自翻译。
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I',
    'KBD', 'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL',
    'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
  ]);

  /** 找最近的「块级祖先」，作为翻译单元的边界。 */
  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body) {
      const d = getComputedStyle(el).display;
      // display 为空串时无法判断，退回标签启发式
      if (!d) {
        if (!INLINE_TAGS.has(el.tagName)) return el;
      } else if (!/^inline/.test(d) && d !== 'contents') {
        return el;
      }
      el = el.parentElement;
    }
    return document.body;
  }

  /** 把文本节点按所属块分组，保持文档顺序。 */
  function groupByBlock(nodes) {
    const groups = new Map();
    for (const n of nodes) {
      const b = blockOf(n);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(n);
    }
    return groups;
  }

  // ---------------------------------------------------------------- 应用译文

  /** 记录原文（只记第一次，避免还原时拿到已翻译的文本）。 */
  function remember(node) {
    if (!state.originals.has(node)) {
      state.originals.set(node, node.nodeValue);
      state.changed.push(node);
    }
  }

  /**
   * 把中文写回一组同块的文本节点。
   * 优先按锚点分配（保留行内元素位置），失败则整块塞进第一个节点。
   */
  function applyGroup(nodes, zh) {
    const metas = nodes.map((n) => {
      const en = state.originals.get(n) ?? n.nodeValue;
      // 该节点英文本身能精确查到官方译名 → 可作锚点
      const solo = C.lookupExact(en, state.matcher) || C.lookupTerm(en, state.matcher);
      return { en, zh: solo };
    });

    const parts = C.distribute(zh, metas);
    if (parts) {
      nodes.forEach((n, i) => {
        remember(n);
        const next = parts[i] ?? '';
        if (n.nodeValue !== next) n.nodeValue = next;
        state.touched.add(n);
      });
      state.stats.nodes += nodes.length;
      return true;
    }

    // 分配失败：整段写入第一个节点，其余清空（仍是纯文本改动，布局不变）
    nodes.forEach((n, i) => {
      remember(n);
      const next = i === 0 ? zh : '';
      if (n.nodeValue !== next) n.nodeValue = next;
      state.touched.add(n);
    });
    state.stats.nodes += nodes.length;
    return true;
  }

  // ---------------------------------------------------------------- 机翻兜底

  const MACHINE_MAX_CHARS = 1200;

  async function machineTranslate(texts) {
    const chunks = C.planChunks(texts.map((t) => ({ text: t })), MACHINE_MAX_CHARS);
    const results = new Map();
    let base = 0;
    for (const chunk of chunks) {
      const payload = C.buildChunk(chunk, base);
      base += chunk.length;
      let translated = null;
      try {
        translated = await requestTranslate(payload);
      } catch (err) {
        translated = null;
      }
      if (translated) {
        const parts = C.splitChunk(translated, base - chunk.length, chunk.length);
        if (parts) {
          chunk.forEach((item, i) => results.set(item.text, parts[i]));
          continue;
        }
      }
      // 分段失败：退化为逐条请求
      for (const item of chunk) {
        try {
          const one = await requestTranslate(item.text);
          if (one) results.set(item.text, one.replace(/\{\{b\d+\}\}/g, '').trim());
        } catch (err) {
          /* 忽略，交给调用方统计失败 */
        }
      }
    }
    return results;
  }

  /** 通过 background 发请求（content script 受 CORS 限制，统一走后端）。 */
  function requestTranslate(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || '翻译失败'));
        resolve(res.text);
      });
    });
  }

  // ---------------------------------------------------------------- 主流程

  async function translatePage() {
    await loadDict();
    const nodes = collectTextNodes(document.body);
    const groups = groupByBlock(nodes);

    const offlineHits = [];
    const machineQueue = [];

    for (const [block, group] of groups) {
      // 整块英文（按文档顺序拼接，保留节点间原有空白）
      const joined = group.map((n) => state.originals.get(n) ?? n.nodeValue).join('');
      // 「是否值得翻译」在整块层面判断：纯数字/URL/邮箱/纯标点整块跳过
      if (!C.shouldTranslate(joined)) continue;
      const hit = C.translateOffline(joined, state.matcher);
      if (hit) {
        offlineHits.push({ group, zh: hit.zh });
      } else {
        // 离线查不到：整块机翻，保持上下文
        machineQueue.push({ group, text: joined });
      }
    }

    for (const h of offlineHits) applyGroup(h.group, h.zh);
    state.stats.offline += offlineHits.length;

    if (machineQueue.length) {
      // 先保护术语，再整块机翻
      const prepared = machineQueue.map((q) => {
        const p = C.protectTerms(q.text, state.matcher, 0);
        return { ...q, payload: p.text, slots: p.slots };
      });
      const map = await machineTranslate(prepared.map((p) => p.payload));
      for (const p of prepared) {
        const raw = map.get(p.payload);
        if (!raw) {
          state.stats.failed += 1;
          continue;
        }
        if (!C.markersIntact(raw, p.slots.map((s) => s.id))) {
          state.stats.failed += 1;
          continue;
        }
        const zh = C.restoreTerms(raw, p.slots);
        applyGroup(p.group, zh);
        state.stats.machine += 1;
      }
    }

    return state.stats;
  }

  /** 逐字还原所有改动。 */
  function restorePage() {
    let count = 0;
    for (const n of collectTouchedNodes()) {
      const orig = state.originals.get(n);
      if (orig === undefined) continue;
      if (n.nodeValue !== orig) {
        n.nodeValue = orig;
        count += 1;
      }
    }
    state.originals = new WeakMap();
    state.touched = new WeakSet();
    state.changed = [];
    state.stats = { offline: 0, machine: 0, failed: 0, nodes: 0 };
    return count;
  }

  /**
   * WeakSet 不可遍历，故额外维护一份普通数组记录被改动的节点。
   * 用数组而非 Set，避免节点被移除后仍被强引用（配合 isConnected 过滤）。
   */
  function collectTouchedNodes() {
    return state.changed.filter((n) => n.isConnected);
  }

  // ---------------------------------------------------------------- 动态内容

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((records) => {
      if (!state.enabled) return;
      let dirty = false;
      for (const r of records) {
        if (r.type === 'characterData') {
          // 我们自己写入的改动不算
          if (state.touched.has(r.target)) continue;
          dirty = true;
        } else if (r.type === 'childList' && r.addedNodes.length) {
          dirty = true;
        }
      }
      if (dirty) scheduleTranslate();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function scheduleTranslate() {
    if (state.pending) return;
    state.pending = setTimeout(async () => {
      state.pending = null;
      if (!state.enabled) return;
      try {
        await translatePage();
      } catch (err) {
        console.warn('[STS2] 增量翻译失败', err);
      }
    }, 250);
  }

  // ---------------------------------------------------------------- 开关

  async function enable() {
    if (state.enabled) return state.stats;
    await loadDict();
    state.enabled = true;
    document.documentElement.setAttribute('data-sts2-translated', 'on');
    const stats = await translatePage();
    startObserver();
    notifyStats(stats);
    return stats;
  }

  function disable() {
    state.enabled = false;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.pending) {
      clearTimeout(state.pending);
      state.pending = null;
    }
    const n = restorePage();
    document.documentElement.removeAttribute('data-sts2-translated');
    return n;
  }

  function notifyStats(stats) {
    try {
      chrome.runtime.sendMessage({ type: 'stats', stats });
    } catch (err) {
      /* 弹窗未打开时忽略 */
    }
  }

  // ---------------------------------------------------------------- 消息

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'toggle') {
      (async () => {
        try {
          if (state.enabled) sendResponse({ ok: true, on: false, restored: disable() });
          else sendResponse({ ok: true, on: true, stats: await enable() });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message) });
        }
      })();
      return true;
    }
    if (msg.type === 'getState') {
      sendResponse({ ok: true, on: state.enabled, stats: state.stats });
      return false;
    }
    return false;
  });

  // ---------------------------------------------------------------- 启动

  (async () => {
    // 不预先加载词典：1MB 的 JSON 只在真正要翻译时才读，
    // 否则每个页面都白白付出一次解析开销。
    const cfg = await chrome.storage.local.get({ autoTranslate: false, sites: {} });
    const host = location.hostname;
    const auto = (cfg.sites && cfg.sites[host]) || cfg.autoTranslate;
    if (!auto) return;
    try {
      await enable();
    } catch (err) {
      console.warn('[STS2] 自动翻译失败', err);
    }
  })();
})();
