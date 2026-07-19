#!/usr/bin/env node
// ============================================================================
// scripts/build-pja.mjs — 自动更新美国跳伞区(PJA)数据
//
// 作用：从 FAA NASR 28 天订阅自动抓取最新 PJA_CSV.zip → 解析 PJA_BASE.csv
//       → 生成紧凑的 data/pja.js（window.PJA_DATA），供 index.html 直接 <script> 引用。
//
// 用法：
//   node scripts/build-pja.mjs                      # 联网自动抓取当前周期并生成 data/pja.js
//   node scripts/build-pja.mjs path/PJA_BASE.csv    # 用本地 CSV 生成（离线）
//   node scripts/build-pja.mjs path/xxx_PJA_CSV.zip # 用本地 zip 生成（需系统 unzip）
//
// 发布自动化：公开 3DWeather-Aviation-Data 仓库每周检查一次，并覆盖固定 Release asset。
// 自定义输出：PJA_OUTPUT=/tmp/pja.js node scripts/build-pja.mjs
//
// 依赖：Node 18+（内置 fetch）。解压 zip 需系统 `unzip`（macOS/Linux 自带）。
// ============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.PJA_OUTPUT ? resolve(process.env.PJA_OUTPUT) : join(ROOT, 'data', 'pja.js');
const SUB = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const EXTRA = 'https://nfdc.faa.gov/webContent/28DaySub/extra/';
const USER_AGENT = '3DWeather PJA snapshot builder (https://github.com/ddv5725910/3DWeather-Aviation-Data)';
const UNZIP = process.env.PJA_UNZIP || (existsSync('/usr/bin/unzip') ? '/usr/bin/unzip' : 'unzip');
const DAY_MS = 86400000;
const NASR_CYCLE_ANCHOR = Date.UTC(2026, 6, 9);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// —— 极简 CSV 解析（处理带引号、含逗号的字段）——
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// —— CSV → 紧凑数组 [lat, lon, radius_nm, max_alt_ft, alt_type, name] ——
//    alt_type: 'M'=MSL 绝对 / 'A'=AGL 离地 / 'U'=无上限(封顶显示)
function convert(csv) {
  const rows = parseCSV(csv);
  const out = [];
  for (const r of rows) {
    const la = parseFloat(r.LAT_DECIMAL), lo = parseFloat(r.LONG_DECIMAL);
    if (!isFinite(la) || !isFinite(lo)) continue;
    let rad = parseFloat(r.PJA_RADIUS);
    if (!isFinite(rad) || rad <= 0) rad = 1;                       // 无半径 → 默认 1 NM
    let a = parseInt(r.MAX_ALTITUDE, 10);
    const tc = (r.MAX_ALTITUDE_TYPE_CODE || '').toUpperCase();
    let t = tc === 'AGL' ? 'A' : tc === 'MSL' ? 'M' : 'U';
    if (!isFinite(a) || t === 'U') { a = 15000; t = 'M'; }          // UNR/空 → 默认封顶 15000 MSL
    const n = (r.DROP_ZONE_NAME || r.CITY || r.PJA_ID || '').trim();
    out.push([+la.toFixed(5), +lo.toFixed(5), rad, a, t, n]);
  }
  return { js: 'window.PJA_DATA=' + JSON.stringify(out) + ';\n', count: out.length };
}

async function fetchResponse(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url);
  return response;
}

async function fetchText(url) {
  return (await fetchResponse(url)).text();
}

function cycleZipUrl(timestamp) {
  const date = new Date(timestamp);
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${EXTRA}${day}_${MONTH_NAMES[date.getUTCMonth()]}_${date.getUTCFullYear()}_PJA_CSV.zip`;
}

export function pjaZipCandidates(now = Date.now()) {
  const cycle = Math.floor((now - NASR_CYCLE_ANCHOR) / (28 * DAY_MS));
  return [cycle, cycle - 1].map(offset => cycleZipUrl(NASR_CYCLE_ANCHOR + offset * 28 * DAY_MS));
}

async function resolveZipUrl() {
  let page = await fetchText(SUB);
  let m = page.match(/https:\/\/nfdc\.faa\.gov\/webContent\/28DaySub\/extra\/[^"']*PJA_CSV\.zip/);
  if (m) return m[0];
  const cyc = [...page.matchAll(/NASR_Subscription\/(\d{4}-\d{2}-\d{2})\//g)].map(x => x[1]).sort();
  if (!cyc.length) throw new Error('未能在订阅页找到周期链接');
  page = await fetchText(SUB + cyc[cyc.length - 1] + '/');
  m = page.match(/https:\/\/nfdc\.faa\.gov\/webContent\/28DaySub\/extra\/[^"']*PJA_CSV\.zip/);
  if (!m) throw new Error('未能在周期页找到 PJA_CSV.zip 链接');
  return m[0];
}

async function downloadCurrentZip() {
  const candidates = pjaZipCandidates();
  try {
    const discovered = await resolveZipUrl();
    if (!candidates.includes(discovered)) candidates.unshift(discovered);
  } catch (error) {
    console.warn('警告：FAA 订阅索引不可解析，改用 28 天周期直链：', error.message);
  }
  let lastError;
  for (const zipUrl of candidates) {
    try {
      const buf = Buffer.from(await (await fetchResponse(zipUrl)).arrayBuffer());
      if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b)
        throw new Error(`下载内容不是有效 ZIP（${buf.length} bytes）`);
      return { buf, zipUrl };
    } catch (error) {
      lastError = error;
      console.warn('警告：PJA 周期文件不可用：', zipUrl, error.message);
    }
  }
  throw new Error(`未能下载当前或上一周期 PJA CSV：${lastError?.message || 'unknown error'}`);
}

async function main() {
  const arg = process.argv[2];
  let csv;
  if (arg && arg.endsWith('.csv')) {
    console.log('读取本地 CSV:', arg); csv = readFileSync(arg, 'utf8');
  } else if (arg && arg.endsWith('.zip')) {
    console.log('解压本地 zip:', arg); csv = execFileSync(UNZIP, ['-p', arg, 'PJA_BASE.csv']).toString('utf8');
  } else {
    console.log('解析当前 NASR 周期…');
    const { buf, zipUrl } = await downloadCurrentZip();
    console.log('下载:', zipUrl);
    const zp = join(mkdtempSync(join(tmpdir(), 'pja-')), 'pja.zip');
    writeFileSync(zp, buf);
    csv = execFileSync(UNZIP, ['-p', zp, 'PJA_BASE.csv']).toString('utf8');
  }
  const { js, count } = convert(csv);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, js);
  console.log(`已写出 ${OUT}（${count} 个跳伞区）`);
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main().catch(e => { console.error('失败:', e.message); process.exit(1); });
