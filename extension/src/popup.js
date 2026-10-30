/**
 * 弹窗逻辑：查询当前标签页状态、切换翻译、记住站点、打开设置。
 */

const toggleBtn = document.getElementById('toggle');
const hostEl = document.getElementById('host');
const siteAuto = document.getElementById('siteAuto');
const statsEl = document.getElementById('stats');
const shortcutEl = document.getElementById('shortcut');

let currentHost = '';
let currentTabId = null;

/** 向内容脚本发消息，失败时返回 null（如 chrome:// 页面未注入）。 */
function sendToTab(msg) {
  return new Promise((resolve) => {
    if (currentTabId == null) return resolve(null);
    chrome.tabs.sendMessage(currentTabId, msg, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res || null);
    });
  });
}

function renderStats(stats) {
  if (!stats) {
    statsEl.hidden = true;
    return;
  }
  statsEl.hidden = false;
  statsEl.innerHTML =
    '离线精确命中 <b>' + (stats.offline || 0) + '</b> 处<br>' +
    '机器翻译兜底 <b>' + (stats.machine || 0) + '</b> 处<br>' +
    '未能翻译 <b>' + (stats.failed || 0) + '</b> 处';
}

function renderToggle(on, usable) {
  toggleBtn.disabled = !usable;
  if (!usable) {
    toggleBtn.textContent = '此页面不支持翻译';
    return;
  }
  toggleBtn.textContent = on ? '还原为英文' : '翻译成中文';
}

async function init() {
  // 快捷键实际值（用户可能改过）
  const cmds = await chrome.commands.getAll();
  const toggleCmd = cmds.find((c) => c.name === 'toggle-translate');
  if (toggleCmd && toggleCmd.shortcut) shortcutEl.textContent = toggleCmd.shortcut;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    renderToggle(false, false);
    return;
  }
  currentTabId = tab.id;

  try {
    currentHost = new URL(tab.url).hostname;
    hostEl.textContent = currentHost;
  } catch (err) {
    hostEl.textContent = tab.url || '未知页面';
    renderToggle(false, false);
    return;
  }

  const got = await chrome.storage.local.get({ sites: {} });
  siteAuto.checked = Boolean(got.sites && got.sites[currentHost]);

  const st = await sendToTab({ type: 'getState' });
  if (!st || !st.ok) {
    // 内容脚本未注入：chrome://、扩展页、PDF 阅读器等
    renderToggle(false, false);
    return;
  }
  renderToggle(Boolean(st.on), true);
  renderStats(st.stats);
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  toggleBtn.textContent = '翻译中…';
  const res = await sendToTab({ type: 'toggle' });
  if (!res || !res.ok) {
    renderToggle(false, true);
    return;
  }
  renderToggle(Boolean(res.on), true);
  renderStats(res.on ? res.stats : null);
});

siteAuto.addEventListener('change', async () => {
  const got = await chrome.storage.local.get({ sites: {} });
  const sites = got.sites || {};
  if (siteAuto.checked) sites[currentHost] = true;
  else delete sites[currentHost];
  await chrome.storage.local.set({ sites });
});

document.getElementById('options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
