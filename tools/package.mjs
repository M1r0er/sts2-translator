/**
 * 把 extension/ 打包成可分发的 zip。
 *
 * 只打包运行时需要的文件：manifest、src、data、icons。
 * 构建中间产物（sts2-names.json 等）和开发脚本不进包。
 *
 * 用法：node tools/package.mjs
 * 产物：dist/sts2-translator-<version>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

/** 扩展运行必需的文件（相对 extension/）。 */
const INCLUDE = [
  'manifest.json',
  'src/core.js',
  'src/content.js',
  'src/background.js',
  'src/popup.html',
  'src/popup.js',
  'src/options.html',
  'src/options.js',
  'data/sts2-dict.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 用一个最小的 ZIP 写入器，避免为了打包引入额外依赖。 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store，不压缩
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const entries = [];
  const missing = [];

  for (const rel of INCLUDE) {
    const abs = path.join(EXT, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    entries.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) });
  }

  if (missing.length) {
    console.error('缺少必需文件：\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, `sts2-translator-${manifest.version}.zip`);
  fs.writeFileSync(out, buildZip(entries));

  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`打包完成：${path.relative(ROOT, out)}（${entries.length} 个文件，${kb} KB）`);
  for (const e of entries) console.log('  ' + e.name);
}

main();
