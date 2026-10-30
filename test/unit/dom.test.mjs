/**
 * DOM 往返测试：在 jsdom 里加载「真实的」core.js + content.js + 真实词典，
 * 验证翻译正确性、结构不变、还原无痕。
 *
 * 这里测的是实际发布的代码，不是替身实现。
 * 运行：node --test "test/unit/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'extension', 'src');
const DICT_PATH = path.join(ROOT, 'extension', 'data', 'sts2-dict.json');
const FIXTURE = path.join(ROOT, 'test', 'fixture', 'page.html');

/**
 * 机翻替身：只覆盖 fixture 里那张不在官方词典的卡。
 * 注意 content.js 会先把术语替换成 {{tN}} 占位符再发出去，
 * 所以这里必须按「带占位符的形态」匹配，并把占位符原样带回译文，
 * 否则 markersIntact 校验会判定占位符丢失。
 */
function fakeMachine(text) {
  // 这句刻意不在官方词典里，用来验证机翻兜底。但 protectTerms 会按当前词典
  // 把 Energy / Card 之类换成 {{tN}}，词典一扩充保护范围就变，所以不能拿
  // 精确字符串做键：这里按「占位符出现顺序」重建译文，占位符原样带回，
  // 后续 restoreTerms 会把它们填成官方中文。
  const PH = /\{\{t\d+\}\}/g;
  const slots = text.match(PH) || [];
  const bare = text.replace(PH, '§');
  if (!/^Whenever you play (?:a card|a §), gain 1 § and draw (?:a card|a §)\.$/i.test(bare)) {
    return null;
  }
  let i = 0;
  const take = () => (i < slots.length ? slots[i++] : null);
  const playCard = /play a card/i.test(bare) ? '一张牌' : take();
  const energy = take();
  const drawCard = /draw a card/i.test(bare) ? '一张牌' : take();
  return `每当你打出${playCard}，获得 1 点${energy}并抽${drawCard}。`;
}

/**
 * 构造一个 jsdom 环境并注入真实的 content script。
 * 返回 { dom, api }，api 用于触发 toggle 与读取状态。
 */
function boot(html) {
  const dom = new JSDOM(html, {
    url: 'https://example.test/cards',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // ---- 词典读取：content.js 用 fetch(chrome.runtime.getURL(...))，这里桥接到本地文件
  window.fetch = async (url) => {
    const p = String(url);
    if (p.includes('sts2-dict.json')) {
      const text = fs.readFileSync(DICT_PATH, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    throw new Error('unexpected fetch ' + p);
  };

  // ---- chrome API 替身
  let listener = null;
  const sent = [];
  const storage = { autoTranslate: false, sites: {} };
  window.chrome = {
    runtime: {
      getURL: (p) => 'https://example.test/' + p,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg && msg.type === 'translate') {
          const zh = fakeMachine(msg.text);
          // 异步回调，贴近真实消息通道
          setTimeout(() => cb && cb(zh ? { ok: true, text: zh } : { ok: false, error: 'no backend' }), 0);
        } else if (cb) {
          setTimeout(() => cb({ ok: true }), 0);
        }
      },
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      lastError: null,
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (obj) => Object.assign(storage, obj),
      },
    },
  };

  // ---- 依次执行 core.js 与 content.js（与 manifest 的注入顺序一致）
  const ctx = dom.getInternalVMContext();
  for (const file of ['core.js', 'content.js']) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, ctx, { filename: file });
  }

  /** 向内容脚本发消息，等价于 popup / 右键菜单的行为。 */
  function send(msg) {
    return new Promise((resolve) => {
      assert.ok(listener, '内容脚本未注册消息监听');
      listener(msg, {}, resolve);
    });
  }

  return { dom, send, sent, storage, window };
}

/** 结构骨架：元素数量、标签、class 序列（不含文本度量）。 */
function skeleton(window) {
  return [...window.document.querySelectorAll('body *')].map((e) => e.tagName + '|' + (e.className || ''));
}

/** 全文（含行内元素切分后的原始拼接）。 */
function allText(window) {
  return window.document.body.textContent.replace(/\s+/g, ' ').trim();
}

const HTML = fs.readFileSync(FIXTURE, 'utf8');

test('翻译后使用官方术语，且不出现机翻错译', async () => {
  const { window, send } = boot(HTML);
  const res = await send({ type: 'toggle' });
  assert.equal(res.ok, true, '切换应成功');
  assert.equal(res.on, true);

  const text = allText(window);
  assert.match(text, /易伤/, 'Vulnerable 应译为「易伤」');
  assert.doesNotMatch(text, /弱势群体|易受伤害/, '不应出现机翻的 Vulnerable 译法');
  assert.doesNotMatch(text, /堵塞/, '不应出现机翻的 Block 译法');
  assert.match(text, /格挡/, 'Block 应译为「格挡」');
  assert.match(text, /弃牌堆/, 'Discard Pile 应译为「弃牌堆」');
  assert.match(text, /痛击/, 'Bash 应译为官方名「痛击」');
  assert.doesNotMatch(text, /重击/, '不应出现机翻的 Bash 译法');
});

test('翻译不改变元素结构（数量、标签、class 完全一致）', async () => {
  const { window, send } = boot(HTML);
  const before = skeleton(window);
  await send({ type: 'toggle' });
  const after = skeleton(window);
  assert.equal(after.length, before.length, '元素数量不变');
  assert.deepEqual(after, before, '标签与 class 序列不变');
});

test('行内关键词元素保留，中文被正确分配到原节点', async () => {
  const { window, send } = boot(HTML);
  await send({ type: 'toggle' });

  // Bash 描述里 Vulnerable 在 <span class="kw"> 内
  const card = window.document.querySelector('[data-testid="card-bash"]');
  const desc = card.querySelector('.game-description');
  const kw = desc.querySelector('.kw');
  assert.ok(kw, '.kw 元素应仍存在');
  assert.equal(kw.textContent, '易伤', '关键词节点应承载「易伤」');
  // 前半句（含数字）应落在关键词之前的文本节点里
  assert.match(desc.textContent, /造成\s*8\s*点伤害/);
  assert.match(desc.textContent, /易伤/);
});

test('升级描述同样翻译，且两段互不串扰', async () => {
  const { window, send } = boot(HTML);
  await send({ type: 'toggle' });
  const up = window.document.querySelector('[data-testid="card-bash"] .upgrade-text');
  assert.match(up.textContent, /造成\s*10\s*点伤害/, '升级数值 10 应保留');
  assert.match(up.textContent, /易伤/);
});

test('还原后正文与原文逐字一致，且结构不变', async () => {
  const { window, send } = boot(HTML);
  const beforeText = allText(window);
  const beforeSkel = skeleton(window);

  await send({ type: 'toggle' });
  const res = await send({ type: 'toggle' });
  assert.equal(res.on, false, '应已关闭');

  assert.equal(allText(window), beforeText, '正文应逐字还原');
  assert.deepEqual(skeleton(window), beforeSkel, '结构应不变');
});

test('二次还原不残留、可再次翻译', async () => {
  const { window, send } = boot(HTML);
  await send({ type: 'toggle' });
  await send({ type: 'toggle' });
  const again = await send({ type: 'toggle' });
  assert.equal(again.on, true);
  assert.match(allText(window), /格挡/, '再次翻译仍应生效');
});

test('不在词典中的句子走机翻兜底', async () => {
  const { window, send } = boot(HTML);
  await send({ type: 'toggle' });
  const machine = window.document.querySelector('[data-testid="card-machine"]');
  assert.match(machine.textContent, /能量/, '机翻兜底应产出中文');
});

test('跳过 script/style/code 与 notranslate 区域', async () => {
  const html = `<!DOCTYPE html><html><body>
    <p id="a">Gain 5 <span class="kw">Block</span>.</p>
    <script>var x = "Gain 5 Block.";</script>
    <style>.x { content: "Gain 5 Block."; }</style>
    <code>Gain 5 Block.</code>
    <p id="b" translate="no">Gain 5 Block.</p>
    <p id="c" class="notranslate">Gain 5 Block.</p>
    <textarea>Gain 5 Block.</textarea>
  </body></html>`;
  const { window, send } = boot(html);
  await send({ type: 'toggle' });

  assert.match(window.document.getElementById('a').textContent, /格挡/, '正常段落应翻译');
  assert.equal(window.document.querySelector('script').textContent, 'var x = "Gain 5 Block.";', 'script 不应改动');
  assert.equal(window.document.querySelector('style').textContent, '.x { content: "Gain 5 Block."; }', 'style 不应改动');
  assert.equal(window.document.querySelector('code').textContent, 'Gain 5 Block.', 'code 不应改动');
  assert.equal(window.document.getElementById('b').textContent, 'Gain 5 Block.', 'translate=no 不应改动');
  assert.equal(window.document.getElementById('c').textContent, 'Gain 5 Block.', '.notranslate 不应改动');
  assert.equal(window.document.querySelector('textarea').textContent, 'Gain 5 Block.', 'textarea 不应改动');
});

test('纯符号/数字/URL 文本不被翻译', async () => {
  const html = `<!DOCTYPE html><html><body>
    <p id="n">12345</p>
    <p id="u">https://example.com/cards/bash</p>
    <p id="e">user@example.com</p>
    <p id="z">Gain 5 <span class="kw">Block</span>.</p>
  </body></html>`;
  const { window, send } = boot(html);
  await send({ type: 'toggle' });
  assert.equal(window.document.getElementById('n').textContent, '12345');
  assert.equal(window.document.getElementById('u').textContent, 'https://example.com/cards/bash');
  assert.equal(window.document.getElementById('e').textContent, 'user@example.com');
  assert.match(window.document.getElementById('z').textContent, /格挡/);
});
