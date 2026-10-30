// 下载构建词典所需的官方双语原始数据（来自 ptrlrd/spire-codex）。
// 这些文件是游戏本地化文本的反编译产物，版权归游戏发行商所有，
// 因此不随本仓库分发，需要时用本脚本自行拉取。
//
// 网络说明：Node 的 fetch 不读系统代理。若你处在需要代理的网络环境，
// 设置 HTTPS_PROXY 后脚本会通过 curl 走代理下载。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data-source');
const BASE = 'https://raw.githubusercontent.com/ptrlrd/spire-codex/main/data';
const LANGS = ['eng', 'zhs'];
const FILES = [
  'achievements', 'acts', 'afflictions', 'ascensions', 'badges', 'cards',
  'characters', 'enchantments', 'encounters', 'epochs', 'events', 'glossary',
  'intents', 'keywords', 'messages', 'modifiers', 'monsters', 'orbs',
  'potions', 'powers', 'relics', 'rest_site_options', 'stories', 'translations',
];

const force = process.argv.includes('--force');
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';

/** 先试 fetch，失败再退回 curl（curl 能走系统/环境代理）。 */
async function download(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.text();
    if (res.status === 404) throw new Error(`HTTP 404: ${url}`);
  } catch (err) {
    // 落到 curl 分支
  }
  const args = ['-sS', '--max-time', '60', '-L'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const lang of LANGS) {
  const dir = join(OUT, lang);
  mkdirSync(dir, { recursive: true });
  for (const name of FILES) {
    const dest = join(dir, name + '.json');
    if (existsSync(dest) && !force) {
      skipped += 1;
      continue;
    }
    const url = `${BASE}/${lang}/${name}.json`;
    try {
      const text = await download(url);
      const head = text ? text.trim()[0] : '';
      if (head !== '[' && head !== '{') throw new Error('响应不是 JSON');
      writeFileSync(dest, text, 'utf8');
      downloaded += 1;
      process.stdout.write(`\r下载 ${lang}/${name}.json …            `);
    } catch (err) {
      failed += 1;
      console.error(`\n失败 ${lang}/${name}.json：${err.message}`);
    }
  }
}

console.log(`\n完成：下载 ${downloaded} 个，跳过 ${skipped} 个，失败 ${failed} 个。`);
console.log(`输出目录：${OUT}`);
if (failed > 0) {
  console.error('有文件下载失败，请检查网络或设置 HTTPS_PROXY 后重试（可加 --force 覆盖已有文件）。');
  process.exitCode = 1;
} else {
  console.log('接下来运行：npm run build:glossary');
}
