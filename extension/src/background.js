/**
 * STS2 中文翻译器 —— 后台服务（MV3 service worker）
 *
 * 职责：
 * 1. 代理机器翻译请求（content script 受 CORS 与 host_permissions 限制，统一走这里）。
 * 2. 内存 + storage 双层缓存，同一句话不重复请求。
 * 3. 右键菜单、工具栏图标点击、快捷键。
 */

const CACHE_KEY = 'trCache';
const CACHE_LIMIT = 4000;
const memCache = new Map();
let cacheLoaded = false;

// ---------------------------------------------------------------- 机翻后端

const BACKENDS = [
  {
    name: 'clients5',
    url: (text) =>
      'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=' +
      encodeURIComponent(text),
    parse(json) {
      // 返回 ["译文"] 或 [["译文", ...]]
      if (typeof json === 'string') return json;
      if (Array.isArray(json)) {
        if (typeof json[0] === 'string') return json[0];
        if (Array.isArray(json[0]) && typeof json[0][0] === 'string') return json[0][0];
      }
      return null;
    },
  },
  {
    name: 'mymemory',
    url: (text) =>
      'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN',
    parse(json) {
      const t = json && json.responseData && json.responseData.translatedText;
      return typeof t === 'string' && t ? t : null;
    },
  },
];

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function translateText(text) {
  const cached = await cacheGet(text);
  if (cached) return cached;

  let lastErr = null;
  for (const b of BACKENDS) {
    try {
      const json = await fetchWithTimeout(b.url(text), 8000);
      const out = b.parse(json);
      if (out && out.trim()) {
        await cacheSet(text, out);
        return out;
      }
      lastErr = new Error(b.name + ' 返回空结果');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('没有可用的翻译后端');
}

// ---------------------------------------------------------------- 缓存

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const got = await chrome.storage.local.get({ [CACHE_KEY]: {} });
    const obj = got[CACHE_KEY] || {};
    for (const [k, v] of Object.entries(obj)) memCache.set(k, v);
  } catch (err) {
    /* 首次运行无缓存 */
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    // 超出上限时按插入顺序淘汰最早的
    while (memCache.size > CACHE_LIMIT) {
      const first = memCache.keys().next();
      if (first.done) break;
      memCache.delete(first.value);
    }
    const obj = {};
    for (const [k, v] of memCache) obj[k] = v;
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: obj });
    } catch (err) {
      /* 配额不足时静默失败，内存缓存仍有效 */
    }
  }, 800);
}

async function cacheGet(text) {
  await loadCache();
  return memCache.get(text) || null;
}

async function cacheSet(text, zh) {
  await loadCache();
  memCache.set(text, zh);
  scheduleSave();
}

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'translate') {
    translateText(String(msg.text || ''))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === 'stats') {
    // 记录最近一次统计，供弹窗读取
    chrome.storage.session
      .set({ lastStats: msg.stats, lastStatsAt: Date.now() })
      .catch(() => {});
    return false;
  }
  return false;
});

// ---------------------------------------------------------------- 菜单与图标

async function toggleOnTab(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (err) {
    // 内容脚本未注入（如 chrome:// 页面）→ 提示
    console.warn('[STS2] 无法在当前页面切换', err && err.message);
  }
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'sts2-toggle',
      title: '翻译 / 还原此页面（杀戮尖塔2）',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: 'sts2-site',
      title: '本页自动翻译（记住此站点）',
      contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sts2-toggle') {
    await toggleOnTab(tab);
    return;
  }
  if (info.menuItemId === 'sts2-site') {
    if (!tab || !tab.url) return;
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch (err) {
      return;
    }
    const got = await chrome.storage.local.get({ sites: {} });
    const sites = got.sites || {};
    sites[host] = true;
    await chrome.storage.local.set({ sites });
    await toggleOnTab(tab);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  await toggleOnTab(tab);
});

// ---------------------------------------------------------------- 快捷键

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-translate') await toggleOnTab(tab);
});
