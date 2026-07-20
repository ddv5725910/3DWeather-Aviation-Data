#!/usr/bin/env node
// Build a browser-ready AWC G-AIRMET snapshot for the nominal valid time
// returned by the API (for example 1800Z). Polygon advisories remain
// polygons; freezing levels remain MSL contour lines.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchPayload } from './build-sigmet.mjs';
import { normalizePolygonWinding } from './build-tfr.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'data/airmet.js');
const AWC_URL = 'https://aviationweather.gov/api/data/gairmet?format=geojson';
const SOURCE_URL = 'https://aviationweather.gov/data/api/';
const DISPLAY_HALF_WINDOW_MS = 179 * 60 * 1000;
const FALLBACK_TOP_FT = Object.freeze({
  LLWS: 2000,
  SFC_WIND: 500
});
const AIRMET_KINDS = Object.freeze(['IFR', 'MT_OBSC', 'LLWS', 'SFC_WIND', 'FZLVL', 'TURB_HI', 'TURB_LO', 'ICE']);

function stableHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);
}

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2 &&
    Number.isFinite(+point[0]) && Number.isFinite(+point[1]) &&
    +point[0] >= -540 && +point[0] <= 540 &&
    +point[1] >= -90 && +point[1] <= 90;
}

function normalizeLine(line) {
  const points = [];
  for (const point of line || []) {
    if (!finitePoint(point)) continue;
    const normalized = [+point[0], +point[1]];
    const previous = points.at(-1);
    if (!previous || previous[0] !== normalized[0] || previous[1] !== normalized[1]) points.push(normalized);
  }
  return points.length >= 2 ? points : null;
}

export function normalizeAirmetGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    const coordinates = normalizePolygonWinding(geometry.coordinates);
    return coordinates.length ? { type:'Polygon', coordinates } : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const coordinates = (geometry.coordinates || []).map(normalizePolygonWinding).filter(polygon => polygon.length);
    return coordinates.length ? { type:'MultiPolygon', coordinates } : null;
  }
  if (geometry.type === 'LineString') {
    const coordinates = normalizeLine(geometry.coordinates);
    return coordinates ? { type:'LineString', coordinates } : null;
  }
  if (geometry.type === 'MultiLineString') {
    const coordinates = (geometry.coordinates || []).map(normalizeLine).filter(Boolean);
    return coordinates.length ? { type:'MultiLineString', coordinates } : null;
  }
  return null;
}

export function airmetGeometryBounds(geometry) {
  if (!geometry?.coordinates) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = value => {
    if (finitePoint(value)) {
      const lon = +value[0], lat = +value[1];
      west = Math.min(west, lon); south = Math.min(south, lat);
      east = Math.max(east, lon); north = Math.max(north, lat);
      return;
    }
    if (Array.isArray(value)) for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}

function canonicalHazard(value) {
  let hazard = String(value || '').trim().toUpperCase().replaceAll('-', '_');
  if (hazard === 'MTN_OBS') hazard = 'MT_OBSC';
  return hazard;
}

export function classifyAirmet(properties) {
  const product = String(properties?.product || '').trim().toUpperCase();
  const hazard = canonicalHazard(properties?.hazard);
  if (!['TANGO', 'SIERRA', 'ZULU'].includes(product)) return null;
  return AIRMET_KINDS.includes(hazard) ? hazard : null;
}

function altitudeValue(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (!text) return null;
  if (text === 'SFC' || text === 'GND') return { value:0, code:'SFC' };
  const number = Number(text.replace(/^FL/, ''));
  if (!Number.isFinite(number) || number < 0) return null;
  return { value:number * 100, code:number >= 180 ? 'STD' : 'MSL' };
}

export function airmetAltitude(properties, kind = classifyAirmet(properties)) {
  const p = properties || {};
  if (kind === 'FZLVL') {
    const level = altitudeValue(p.level);
    if (!level) return null;
    return {
      lowerVal:level.value,
      lowerCode:'MSL',
      upperVal:level.value,
      upperCode:'MSL',
      baseKnown:true,
      topKnown:true,
      levelKnown:true
    };
  }
  const base = altitudeValue(p.base);
  const top = altitudeValue(p.top);
  const hazard = canonicalHazard(p.hazard);
  const lowerVal = base?.value ?? 0;
  const fallbackTop = FALLBACK_TOP_FT[hazard] || 500;
  const upperVal = Math.max(lowerVal + 100, top?.value ?? fallbackTop);
  return {
    lowerVal,
    lowerCode:base?.code || 'SFC',
    upperVal,
    upperCode:top?.code || 'MSL',
    baseKnown:!!base,
    topKnown:!!top,
    levelKnown:false
  };
}

export function airmetValidity(properties) {
  const nominal = Date.parse(properties?.validTime);
  if (!Number.isFinite(nominal)) return null;
  return {
    nominal,
    from:nominal - DISPLAY_HALF_WINDOW_MS,
    to:nominal + DISPLAY_HALF_WINDOW_MS
  };
}

function validTimeCode(ms) {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function hazardName(hazard) {
  return ({
    TURB_HI:'TURBULENCE HIGH',
    TURB_LO:'TURBULENCE LOW',
    LLWS:'LOW-LEVEL WIND SHEAR',
    SFC_WIND:'STRONG SURFACE WINDS',
    IFR:'IFR',
    MT_OBSC:'MOUNTAIN OBSCURATION',
    ICE:'ICING',
    FZLVL:'FREEZING LEVEL'
  })[hazard] || hazard.replaceAll('_', ' ');
}

function featureName(kind, hazard, altitude, validity) {
  const time = validTimeCode(validity.nominal);
  if (kind === 'FZLVL') return `FREEZING LEVEL · ${altitude.lowerVal.toLocaleString('en-US')} FT MSL · ${time}`;
  return `G-AIRMET · ${hazardName(hazard)} · ${time}`;
}

export function normalizeAirmetFeature(source) {
  const p = source?.properties || {};
  const kind = classifyAirmet(p);
  const geometry = normalizeAirmetGeometry(source?.geometry);
  const bounds = airmetGeometryBounds(geometry);
  const validity = airmetValidity(p);
  const altitude = airmetAltitude(p, kind);
  if (!kind || !geometry || !bounds || !validity || !altitude) return null;
  if (kind === 'FZLVL' && !['LineString', 'MultiLineString'].includes(geometry.type)) return null;
  if (kind !== 'FZLVL' && !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;

  const hazard = canonicalHazard(p.hazard);
  const tag = String(p.tag || 'UNKNOWN').trim().toUpperCase();
  const issueTime = Date.parse(p.issueTime);
  const forecastHour = Number.isFinite(+p.forecast) ? +p.forecast :
    Number.isFinite(+p.forecastHour) ? +p.forecastHour : null;
  const geometryHash = stableHash(geometry);
  const productKey = `AIRMET|${kind}|${tag}|${hazard}|${validity.nominal}|${p.level || ''}|${geometryHash}`;
  const identity = stableHash([geometry, p.receiptTime || '', p.dueTo || p.due_to || '', altitude]);
  const properties = {
    WX_AIRMET:1,
    WX_KIND:kind,
    NAME:featureName(kind, hazard, altitude, validity),
    WX_HAZARD:hazard,
    WX_PRODUCT:String(p.product || '').toUpperCase(),
    WX_SERIES:tag,
    WX_TAG:tag,
    WX_FORECAST_HOUR:forecastHour,
    WX_ISSUE_TIME:Number.isFinite(issueTime) ? issueTime : 0,
    WX_VALID_TIME:validity.nominal,
    WX_VALID_FROM:validity.from,
    WX_VALID_TO:validity.to,
    WX_BASE_KNOWN:altitude.baseKnown ? 1 : 0,
    WX_TOP_KNOWN:altitude.topKnown ? 1 : 0,
    WX_LEVEL_FT:kind === 'FZLVL' ? altitude.lowerVal : null,
    WX_DUE_TO:String(p.dueTo || p.due_to || ''),
    WX_BBOX:bounds,
    WX_PRODUCT_KEY:productKey,
    GLOBAL_ID:`${productKey}|${identity}`,
    LOWER_VAL:altitude.lowerVal,
    LOWER_UOM:'FT',
    LOWER_CODE:altitude.lowerCode,
    UPPER_VAL:altitude.upperVal,
    UPPER_UOM:'FT',
    UPPER_CODE:altitude.upperCode
  };
  if (kind === 'FZLVL') properties.WX_FREEZING_LEVEL = 1;
  return { type:'Feature', geometry, properties };
}

function validPolygonGeometry(geometry) {
  const polygons = geometry?.type === 'MultiPolygon' ? geometry.coordinates :
    geometry?.type === 'Polygon' ? [geometry.coordinates] : null;
  return Array.isArray(polygons) && polygons.length > 0 &&
    polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 &&
      polygon.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(finitePoint)));
}

function validLineGeometry(geometry) {
  const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates :
    geometry?.type === 'LineString' ? [geometry.coordinates] : null;
  return Array.isArray(lines) && lines.length > 0 &&
    lines.every(line => Array.isArray(line) && line.length >= 2 && line.every(finitePoint));
}

export function validateAirmetSnapshot(snapshot, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      !String(snapshot.source || '').includes('aviationweather.gov') || !Array.isArray(snapshot.features))
    throw new Error('AIRMET 快照缺少有效的 schemaVersion、generatedAt、source 或 features');
  if (!snapshot.features.length) throw new Error('AIRMET 快照为空，拒绝覆盖现有数据');
  const ids = new Set(), counts = Object.fromEntries(AIRMET_KINDS.map(kind => [kind, 0]));
  for (const [index, feature] of snapshot.features.entries()) {
    const p = feature?.properties || {}, kind = p.WX_KIND;
    if (!Object.hasOwn(counts, kind)) throw new Error(`AIRMET 要素 ${index} 的 WX_KIND 无效`);
    if (!p.WX_AIRMET || !p.WX_PRODUCT_KEY) throw new Error(`AIRMET 要素 ${index} 缺少产品元数据`);
    if (!p.GLOBAL_ID || ids.has(p.GLOBAL_ID)) throw new Error(`AIRMET 要素 ${index} 的 GLOBAL_ID 缺失或重复：${p.GLOBAL_ID || '(empty)'}`);
    ids.add(p.GLOBAL_ID); counts[kind]++;
    const geometryValid = kind === 'FZLVL' ? validLineGeometry(feature.geometry) : validPolygonGeometry(feature.geometry);
    if (!geometryValid) throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 的几何无效`);
    if (!Array.isArray(p.WX_BBOX) || p.WX_BBOX.length !== 4 || !p.WX_BBOX.every(Number.isFinite))
      throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 的 WX_BBOX 无效`);
    if (![p.WX_VALID_FROM, p.WX_VALID_TIME, p.WX_VALID_TO].every(Number.isFinite) ||
        p.WX_VALID_FROM >= p.WX_VALID_TIME || p.WX_VALID_TIME >= p.WX_VALID_TO)
      throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 的有效时片无效`);
    if (+p.WX_VALID_TO <= now) throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 在生成时已经过期`);
    if (kind === 'FZLVL') {
      if (!Number.isFinite(+p.WX_LEVEL_FT) || +p.WX_LEVEL_FT < 0 ||
          +p.LOWER_VAL !== +p.WX_LEVEL_FT || +p.UPPER_VAL !== +p.WX_LEVEL_FT)
        throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 的冻结高度无效`);
    } else if (![p.LOWER_VAL, p.UPPER_VAL].every(Number.isFinite) || +p.UPPER_VAL <= +p.LOWER_VAL) {
      throw new Error(`AIRMET 要素 ${p.GLOBAL_ID} 的垂直范围无效`);
    }
  }
  const previous = options.previous;
  if (Array.isArray(previous?.features)) {
    const previousLive = previous.features.filter(feature => +(feature?.properties?.WX_VALID_TO || 0) > now).length;
    const minimum = previousLive >= 20 ? Math.max(5, Math.floor(previousLive * 0.2)) : 1;
    if (snapshot.features.length < minimum)
      throw new Error(`新 AIRMET 快照仅有 ${snapshot.features.length} 个要素，低于现有有效快照保护阈值 ${minimum}`);
  }
  return { features:snapshot.features.length, counts };
}

export async function buildAirmetSnapshot(options = {}) {
  const collection = await fetchPayload(AWC_URL, 'json', options);
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features))
    throw new Error('AWC G-AIRMET 未返回有效的 GeoJSON FeatureCollection');
  const generatedAt = Date.now();
  const features = [...new Map(collection.features
    .map(normalizeAirmetFeature)
    .filter(feature => feature && +feature.properties.WX_VALID_TO > generatedAt)
    .map(feature => [feature.properties.GLOBAL_ID, feature])).values()]
    .sort((a, b) => a.properties.GLOBAL_ID.localeCompare(b.properties.GLOBAL_ID));
  const snapshot = {
    schemaVersion:1,
    generatedAt:new Date(generatedAt).toISOString(),
    source:SOURCE_URL,
    nominalValidTime:Number.isFinite(+collection.validTime) ?
      new Date(+collection.validTime * 1000).toISOString() :
      features[0] ? new Date(+features[0].properties.WX_VALID_TIME).toISOString() : null,
    features
  };
  validateAirmetSnapshot(snapshot, { now:generatedAt });
  return snapshot;
}

function readExistingSnapshot(output) {
  if (!existsSync(output)) return null;
  try {
    return JSON.parse(readFileSync(output, 'utf8').replace(/^\s*window\.AIRMET_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch {
    return null;
  }
}

function writeSnapshotAtomic(output, snapshot) {
  mkdirSync(dirname(output), { recursive:true });
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `window.AIRMET_DATA=${JSON.stringify(snapshot)};\n`);
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function main() {
  const output = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  console.log('正在读取 AWC 当前有效时片的八类 G-AIRMET 危险…');
  const snapshot = await buildAirmetSnapshot();
  const existing = readExistingSnapshot(output);
  validateAirmetSnapshot(snapshot, { previous:existing, now:Date.parse(snapshot.generatedAt) });
  if (JSON.stringify(existing?.features) === JSON.stringify(snapshot.features) && existing?.generatedAt)
    snapshot.generatedAt = existing.generatedAt;
  writeSnapshotAtomic(output, snapshot);
  const { counts } = validateAirmetSnapshot(snapshot, { now:Date.parse(snapshot.generatedAt) });
  const countText = Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' / ');
  console.log(`已写出 ${output}（${countText}，valid ${snapshot.nominalValidTime || 'unknown'}）`);
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main().catch(error => {
  console.error('失败:', error.stack || error.message);
  process.exitCode = 1;
});
