/**
 * 设置页逻辑：自动翻译开关、站点列表、词典信息、缓存清理。
 */

const autoTranslate = document.getElementById('autoTranslate');
const newSite = document.getElementById('newSite');
const addSiteBtn = document.getElementById('addSite');
const siteList = document.getElementById('siteList');
const siteStatus = document.getElementById('siteStatus');
const dictVersion = document.getElementById('dictVersion');
const dictSource = document.getElementById('dictSource');
const dictCounts = document.getElementById('dictCounts');
const clearCacheBtn = document.getElementById('clearCache');
const cacheStatus = document.getElementById('cacheStatus');

function say(el, text) {
  el.textContent = text;
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2600);
}

/** 规范化用户输入的站点：允许带协议、路径、端口，统一存 hostname。 */
function normalizeSite(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s);
    return u.hostname || null;
  } catch (err) {
    return null;
  }
}

async function renderSites() {
  const got = await chrome.storage.local.get({ sites: {} });
  const sites = got.sites || {};
  const hosts = Object.keys(sites).filter((h) => sites[h]).sort();
  siteList.innerHTML = '';
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.background = 'transparent';
    li.style.border = '0';
    li.textContent = '暂无站点，添加后打开该站点会自动翻译。';
    siteList.appendChild(li);
    return;
  }
  for (const host of hosts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = host;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '移除';
    del.addEventListener('click', async () => {
      const cur = await chrome.storage.local.get({ sites: {} });
      const map = cur.sites || {};
      delete map[host];
      await chrome.storage.local.set({ sites: map });
      await renderSites();
      say(siteStatus, '已移除 ' + host);
    });
    li.appendChild(span);
    li.appendChild(del);
    siteList.appendChild(li);
  }
}

async function renderDictInfo() {
  try {
    const res = await fetch(chrome.runtime.getURL('data/sts2-dict.json'));
    const dict = await res.json();
    const meta = dict.meta || {};
    dictVersion.textContent = meta.version || '未知';
    dictSource.textContent = meta.source || '游戏文件反编译数据';
    const c = meta.counts || {};
    const parts = [];
    if (c.names) parts.push('名称 ' + c.names);
    if (c.terms) parts.push('术语 ' + c.terms);
    if (c.exact) parts.push('整句 ' + c.exact);
    if (c.templates) parts.push('模板 ' + c.templates);
    dictCounts.textContent = parts.join(' · ') || '—';
  } catch (err) {
    dictVersion.textContent = '加载失败';
  }
}

addSiteBtn.addEventListener('click', async () => {
  const host = normalizeSite(newSite.value);
  if (!host) {
    say(siteStatus, '请输入有效的域名');
    return;
  }
  const got = await chrome.storage.local.get({ sites: {} });
  const sites = got.sites || {};
  sites[host] = true;
  await chrome.storage.local.set({ sites });
  newSite.value = '';
  await renderSites();
  say(siteStatus, '已添加 ' + host);
});

newSite.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSiteBtn.click();
});

autoTranslate.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoTranslate: autoTranslate.checked });
  say(cacheStatus, autoTranslate.checked ? '已开启全局自动翻译' : '已关闭全局自动翻译');
});

clearCacheBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ trCache: {} });
  say(cacheStatus, '翻译缓存已清空');
});

(async () => {
  const got = await chrome.storage.local.get({ autoTranslate: false });
  autoTranslate.checked = Boolean(got.autoTranslate);
  await renderSites();
  await renderDictInfo();
})();
