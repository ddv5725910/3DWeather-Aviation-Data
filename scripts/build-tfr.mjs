#!/usr/bin/env node
// Build the browser-ready Temporary Flight Restriction snapshot from FAA TFR data.
// Node 18+ is required (built-in fetch).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'data/tfr.js');
const WFS_URL = 'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326';
const LIST_URL = 'https://tfr.faa.gov/tfrapi/getTfrList';
const DETAIL_URL = 'https://tfr.faa.gov/tfrapi/getWebText?notamId=';
const SOURCE_URL = 'https://tfr.faa.gov/tfr3/';
const MONTHS = new Map([
  ['jan', 0], ['january', 0], ['feb', 1], ['february', 1], ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3], ['may', 4], ['jun', 5], ['june', 5], ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7], ['sep', 8], ['sept', 8], ['september', 8],
  ['oct', 9], ['october', 9], ['nov', 10], ['november', 10], ['dec', 11], ['december', 11]
]);

function decodeHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|tr|td|div|li|table)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFaaUtc(value, endOfDay = false) {
  const text = decodeHtml(value);
  if (!text || /^permanent$/i.test(text)) return null;
  const match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{2})(\d{2})\s+UTC(?:\b|$)/i);
  const dateOnly = match ? null : text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+UTC(?:\b|$)/i);
  const parts = match || dateOnly;
  if (!parts) return null;
  const month = MONTHS.get(parts[1].toLowerCase());
  if (month == null) return null;
  const hour = match ? +match[4] : endOfDay ? 23 : 0;
  const minute = match ? +match[5] : endOfDay ? 59 : 0;
  const second = !match && endOfDay ? 59 : 0;
  const timestamp = Date.UTC(+parts[3], month, +parts[2], hour, minute, second);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseAltitudeDefinition(value) {
  const text = decodeHtml(value).replace(/(\d),(?=\d{3}\b)/g, '$1');
  const match = text.match(/From\s+(the surface|and including\s+([\d.]+)\s+feet\s+(MSL|AGL))\s+up to\s+(?:(?:and including\s+)?([\d.]+)\s+feet\s+(MSL|AGL)|(Unlimited))/i);
  if (!match) return null;
  const unlimited = !!match[6];
  return {
    lowerVal: match[1].toLowerCase() === 'the surface' ? 0 : +match[2],
    lowerCode: match[1].toLowerCase() === 'the surface' ? 'SFC' : match[3].toUpperCase(),
    upperVal: unlimited ? 60000 : +match[4],
    upperCode: unlimited ? 'UNL' : match[5].toUpperCase()
  };
}

export function parseTfrDetail(html) {
  const raw = String(html || '');
  const clean = decodeHtml(raw);
  const fieldNames = [
    'NOTAM Number', 'Issue Date', 'Location', 'Beginning Date and Time', 'Ending Date and Time',
    'Reason for NOTAM', 'Type', 'Replaced NOTAM\\(s\\)', 'Pilots May Contact', 'Jump To'
  ];
  const valueAfter = label => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nextField = fieldNames.filter(name => name !== escaped).join('|');
    const match = clean.match(new RegExp(escaped + '\\s*:\\s*(.*?)(?=\\s+(?:' + nextField + ')\\s*:|$)', 'i'));
    return match ? match[1].trim() : '';
  };
  const blocks = raw.split(/Airspace Definition\s*:/i).slice(1);
  const altitudes = blocks.map(block => parseAltitudeDefinition(block)).filter(Boolean);
  if (!altitudes.length) {
    const fallback = parseAltitudeDefinition(clean);
    if (fallback) altitudes.push(fallback);
  }
  const startText = valueAfter('Beginning Date and Time');
  const issueAt = parseFaaUtc(valueAfter('Issue Date'));
  return {
    startAt: /^effective immediately$/i.test(startText) ? issueAt : parseFaaUtc(startText),
    endAt: parseFaaUtc(valueAfter('Ending Date and Time'), true),
    altitudes
  };
}

export function signedRingArea(ring) {
  let area = 0;
  for (let i = 0, n = ring?.length || 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    area += (+a[0] || 0) * (+b[1] || 0) - (+b[0] || 0) * (+a[1] || 0);
  }
  return area / 2;
}

function closedRing(ring) {
  const out = (ring || []).map(point => [Number(point[0]), Number(point[1])])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (out.length < 3) return [];
  const first = out[0], last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
  return out;
}

export function normalizePolygonWinding(polygon) {
  return (polygon || []).map((input, index) => {
    const ring = closedRing(input);
    if (ring.length < 4) return [];
    const shouldBeClockwise = index === 0;
    const isClockwise = signedRingArea(ring) < 0;
    return shouldBeClockwise === isClockwise ? ring : ring.reverse();
  }).filter(ring => ring.length >= 4);
}

function normalizeGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    const coordinates = normalizePolygonWinding(geometry.coordinates);
    return coordinates.length ? { type: 'Polygon', coordinates } : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const coordinates = geometry.coordinates.map(normalizePolygonWinding).filter(polygon => polygon.length);
    return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
  }
  return null;
}

function geometryBounds(geometry) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
    west = Math.min(west, lon); south = Math.min(south, lat);
    east = Math.max(east, lon); north = Math.max(north, lat);
  }
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}

function altitudeEnvelope(altitudes) {
  if (!altitudes.length) return { lowerVal: 0, lowerCode: 'SFC', upperVal: 3000, upperCode: 'AGL' };
  const lowerSurface = altitudes.some(item => item.lowerCode === 'SFC');
  const lowerVal = lowerSurface ? 0 : Math.min(...altitudes.map(item => item.lowerVal));
  const lowerCode = lowerSurface ? 'SFC' :
    (altitudes.find(item => item.lowerVal === lowerVal)?.lowerCode || 'MSL');
  const upperVal = Math.max(...altitudes.map(item => item.upperVal));
  const upperItems = altitudes.filter(item => item.upperVal === upperVal);
  const upperCode = upperItems.some(item => item.upperCode === 'MSL') ? 'MSL' :
    (upperItems[0]?.upperCode || 'MSL');
  return { lowerVal, lowerCode, upperVal, upperCode };
}

export function assignAltitudeDefinitions(featureCount, altitudes) {
  if (featureCount === altitudes.length && featureCount > 0) return altitudes;
  const envelope = altitudeEnvelope(altitudes);
  return Array.from({ length: featureCount }, () => ({ ...envelope }));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': '3DWeather TFR snapshot builder (https://github.com/ddv5725910/3DWeather-Aviation-Data)' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function mapConcurrent(values, concurrency, fn) {
  const out = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      out[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return out;
}

function notamIdOf(feature) {
  return String(feature?.properties?.NOTAM_KEY || feature?.id || '').split('-')[0].trim();
}

export async function buildTfrSnapshot() {
  const [collection, list] = await Promise.all([fetchJson(WFS_URL), fetchJson(LIST_URL)]);
  const sourceFeatures = Array.isArray(collection?.features) ? collection.features : [];
  const listItems = Array.isArray(list) ? list : [];
  const listById = new Map(listItems.map(item => [String(item.notam_id || item.gid || '').trim(), item]));
  const groups = new Map();
  for (const feature of sourceFeatures) {
    const notamId = notamIdOf(feature);
    if (!notamId) continue;
    if (!groups.has(notamId)) groups.set(notamId, []);
    groups.get(notamId).push(feature);
  }

  const groupEntries = [...groups.entries()];
  const details = await mapConcurrent(groupEntries, 8, async ([notamId]) => {
    try {
      const payload = await fetchJson(DETAIL_URL + encodeURIComponent(notamId));
      return parseTfrDetail(Array.isArray(payload) ? payload[0]?.text : payload?.text);
    } catch (error) {
      console.warn(`警告：无法读取 ${notamId} 详情，使用保守高度：${error.message}`);
      return { startAt: null, endAt: null, altitudes: [] };
    }
  });

  const features = [];
  for (let groupIndex = 0; groupIndex < groupEntries.length; groupIndex++) {
    const [notamId, group] = groupEntries[groupIndex];
    const detail = details[groupIndex];
    const metadata = listById.get(notamId) || {};
    const altitudes = assignAltitudeDefinitions(group.length, detail.altitudes);
    for (let featureIndex = 0; featureIndex < group.length; featureIndex++) {
      const source = group[featureIndex], geometry = normalizeGeometry(source.geometry);
      if (!geometry) continue;
      const bounds = geometryBounds(geometry), altitude = altitudes[featureIndex];
      if (!bounds || !altitude) continue;
      const properties = source.properties || {};
      features.push({
        type: 'Feature',
        geometry,
        properties: {
          GLOBAL_ID: `TFR|${notamId}|${properties.GID ?? featureIndex}`,
          TFR: 1,
          NAME: `TFR ${notamId}`,
          TFR_NOTAM: notamId,
          TFR_TITLE: String(properties.TITLE || '').trim(),
          TFR_TYPE: String(metadata.type || properties.LEGAL || '').trim(),
          TFR_DESCRIPTION: String(metadata.description || '').trim(),
          TFR_START_AT: detail.startAt,
          TFR_END_AT: detail.endAt,
          TFR_URL: `${SOURCE_URL}?page=detail_${notamId.replace('/', '_')}`,
          TFR_BBOX: bounds,
          LOWER_VAL: altitude.lowerVal,
          LOWER_UOM: 'FT',
          LOWER_CODE: altitude.lowerCode,
          UPPER_VAL: altitude.upperVal,
          UPPER_UOM: 'FT',
          UPPER_CODE: altitude.upperCode
        }
      });
    }
  }
  features.sort((a, b) => a.properties.GLOBAL_ID.localeCompare(b.properties.GLOBAL_ID));

  return {
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    features
  };
}

async function main() {
  const output = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  console.log('正在读取 FAA TFR 几何、列表和垂直范围…');
  const snapshot = await buildTfrSnapshot();
  if (existsSync(output)) {
    try {
      const text = readFileSync(output, 'utf8');
      const existing = JSON.parse(text.replace(/^\s*window\.TFR_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
      if (JSON.stringify(existing.features) === JSON.stringify(snapshot.features) && existing.generatedAt)
        snapshot.generatedAt = existing.generatedAt; // 数据未变化时保持文件字节稳定，避免定时任务制造空更新
    } catch {}
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `window.TFR_DATA=${JSON.stringify(snapshot)};\n`);
  console.log(`已写出 ${output}（${snapshot.features.length} 个 TFR 几何）`);
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main().catch(error => {
  console.error('失败:', error.stack || error.message);
  process.exitCode = 1;
});
