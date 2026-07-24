#!/usr/bin/env node
// Build a browser-ready AWC advisory snapshot:
// hazard-specific domestic/international SIGMETs, Center Weather Advisories,
// and the 2–6 hour Convective SIGMET Outlook polygons embedded in domestic
// Convective SIGMET bulletins.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizePolygonWinding } from './build-tfr.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'data/sigmet.js');
const AWC_BASE = 'https://aviationweather.gov/api/data/';
const DOMESTIC_URL = AWC_BASE + 'airsigmet?format=geojson';
const INTERNATIONAL_URL = AWC_BASE + 'isigmet?format=geojson';
const CWA_URL = AWC_BASE + 'cwa?format=geojson';
const RAW_URL = AWC_BASE + 'airsigmet?format=raw';
const NAVAID_QUERY = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/NAVAIDSystem/FeatureServer/0/query';
const NAVAID_SNAPSHOT_URL =
  'https://github.com/ddv5725910/3DWeather-Aviation-Data/releases/download/aviation-base-data/navaids.json';
const SOURCE_URL = 'https://aviationweather.gov/data/api/';
const USER_AGENT = '3DWeather SIGMET snapshot builder (https://github.com/ddv5725910/3DWeather-Aviation-Data)';
const OUTLOOK_TOP_FT = 60000;
const FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 20000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const SIGMET_KINDS = Object.freeze([
  'SIG_CONV', 'SIG_TC', 'SIG_TURB', 'SIG_ICE', 'SIG_VA', 'SIG_DUST', 'CWA', 'COUT'
]);
const SIGMET_HAZARD_KIND = Object.freeze({
  CONVECTIVE:'SIG_CONV',
  TS:'SIG_CONV',
  THUNDERSTORM:'SIG_CONV',
  THUNDERSTORMS:'SIG_CONV',
  TC:'SIG_TC',
  TROPICAL_CYCLONE:'SIG_TC',
  TURB:'SIG_TURB',
  TURBULENCE:'SIG_TURB',
  MTW:'SIG_TURB',
  MOUNTAIN_WAVE:'SIG_TURB',
  ICE:'SIG_ICE',
  ICING:'SIG_ICE',
  VA:'SIG_VA',
  VOLCANIC_ASH:'SIG_VA',
  DS:'SIG_DUST',
  SS:'SIG_DUST',
  DU:'SIG_DUST',
  BD:'SIG_DUST',
  DUST:'SIG_DUST',
  SAND:'SIG_DUST',
  DUST_STORM:'SIG_DUST',
  SAND_STORM:'SIG_DUST',
  BLOWING_DUST_SAND:'SIG_DUST'
});
const COMPASS_BEARING = Object.freeze({
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  const seconds = retryAfter && Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30000, seconds * 1000);
  return Math.min(8000, 600 * 2 ** attempt);
}

export async function fetchPayload(url, format = 'json', options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || wait;
  const attempts = Math.max(1, options.attempts || FETCH_ATTEMPTS);
  const timeoutMs = Math.max(1, options.timeoutMs || FETCH_TIMEOUT_MS);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`请求超时 ${timeoutMs}ms`)), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      return format === 'text' ? await response.text() : await response.json();
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt + 1 >= attempts) break;
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`读取天气数据失败（已尝试 ${attempts} 次）：${lastError?.message || url}`, { cause: lastError });
}

function finiteNumbers(values) {
  return values.map(Number).filter(Number.isFinite);
}

function canonicalSigmetHazard(value) {
  return String(value || '').trim().toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function classifySigmetHazard(value) {
  return SIGMET_HAZARD_KIND[canonicalSigmetHazard(value)] || null;
}

export function classifyDomesticSigmet(properties) {
  const p = properties || {};
  if (String(p.airSigmetType || '').toUpperCase() !== 'SIGMET') return null;
  return classifySigmetHazard(p.hazard);
}

export function classifyInternationalSigmet(properties) {
  return classifySigmetHazard(properties?.hazard);
}

export function sigmetAltitude(properties, kind) {
  const p = properties || {};
  if (kind === 'COUT') {
    return { lowerVal: 0, lowerCode: 'SFC', upperVal: OUTLOOK_TOP_FT, upperCode: 'UNL', baseKnown: false, topKnown: false };
  }
  const domestic = Object.hasOwn(p, 'altitudeHi1') || Object.hasOwn(p, 'altitudeLow1');
  const lows = domestic ? finiteNumbers([p.altitudeLow1, p.altitudeLow2].filter(value => value != null)) :
    finiteNumbers([p.base].filter(value => value != null));
  const highs = domestic ? finiteNumbers([p.altitudeHi1, p.altitudeHi2].filter(value => value != null)) :
    finiteNumbers([p.top].filter(value => value != null));
  const lowerVal = lows.length ? Math.max(0, Math.min(...lows)) : 0;
  const upperVal = highs.length ? Math.max(...highs) : OUTLOOK_TOP_FT;
  return {
    lowerVal,
    lowerCode: lows.length && lowerVal > 0 ? 'MSL' : 'SFC',
    upperVal: Math.max(lowerVal + 100, upperVal),
    upperCode: highs.length ? 'MSL' : 'UNL',
    baseKnown: lows.length > 0,
    topKnown: highs.length > 0
  };
}

function normalizeGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    const coordinates = normalizePolygonWinding(geometry.coordinates);
    return coordinates.length ? { type: 'Polygon', coordinates } : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const coordinates = (geometry.coordinates || []).map(normalizePolygonWinding).filter(polygon => polygon.length);
    return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
  }
  return null;
}

function stableHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);
}

export function geometryBounds(geometry) {
  if (!geometry) return null;
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const polygon of polygons || []) for (const ring of polygon || []) for (const point of ring || []) {
    const lon = +point[0], lat = +point[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    west = Math.min(west, lon); south = Math.min(south, lat);
    east = Math.max(east, lon); north = Math.max(north, lat);
  }
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}

function nearestUtcDay(code, anchorMs) {
  const match = String(code || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const anchor = new Date(anchorMs);
  const candidates = [];
  for (let monthDelta = -1; monthDelta <= 1; monthDelta++) {
    candidates.push(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + monthDelta, +match[1], +match[2], +match[3]));
  }
  return candidates.reduce((best, value) =>
    Math.abs(value - anchorMs) < Math.abs(best - anchorMs) ? value : best, candidates[0]);
}

export function parseOutlookValidity(text, anchorMs = Date.now()) {
  const match = String(text || '').match(/OUTLOOK\s+VALID\s+(\d{6})-(\d{6})/i);
  if (!match) return null;
  const from = nearestUtcDay(match[1], anchorMs);
  let to = nearestUtcDay(match[2], from ?? anchorMs);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to <= from) {
    const d = new Date(to);
    to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  }
  return { from, to, code: `${match[1]}-${match[2]}` };
}

export function parseOutlookAreas(raw, anchorMs = Date.now()) {
  const text = String(raw || '').replace(/\r/g, '');
  const validity = parseOutlookValidity(text, anchorMs);
  if (!validity) return [];
  const start = text.search(/OUTLOOK\s+VALID\s+\d{6}-\d{6}/i);
  const outlook = start >= 0 ? text.slice(start).replace(/^.*?\n/, '') : '';
  const region = (text.match(/^\s*SIG([WCE])\s*$/m)?.[1] || '').toUpperCase();
  const areas = [];
  const areaRe = /(?:^|\n)\s*AREA\s+(\d+)\.\.\.FROM\s+([\s\S]*?)(?=\n\s*(?:WST\s+ISSUANCES|REF\s+WW|AREA\s+\d+\.\.\.FROM)|$)/gi;
  let match;
  while ((match = areaRe.exec(outlook))) {
    areas.push({ area: +match[1], region, route: cleanOutlookRoute(match[2]), ...validity });
  }
  if (!areas.length) {
    const single = outlook.match(/(?:^|\n)\s*FROM\s+([\s\S]*?)(?=\n\s*(?:WST\s+ISSUANCES|REF\s+WW)|$)/i);
    if (single) areas.push({ area: 1, region, route: cleanOutlookRoute(single[1]), ...validity });
  }
  return areas.filter(area => area.route.length >= 3);
}

function cleanOutlookRoute(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/\s*-\s*/)
    .map(token => token.trim().toUpperCase()).filter(Boolean);
}

export function parseRoutePointToken(token) {
  const match = String(token || '').trim().toUpperCase()
    .match(/^(?:(\d{1,3})(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+)?([A-Z0-9]{3})$/);
  if (!match) return null;
  return {
    ident: match[3],
    distanceNm: match[1] ? +match[1] : 0,
    bearing: match[2] ? COMPASS_BEARING[match[2]] : 0
  };
}

export function destinationPoint(lat, lon, bearing, distanceNm) {
  if (!distanceNm) return [lon, lat];
  const angularDistance = distanceNm * 1852 / 6371008.8;
  const phi1 = lat * Math.PI / 180, lambda1 = lon * Math.PI / 180, theta = bearing * Math.PI / 180;
  const sinPhi2 = Math.sin(phi1) * Math.cos(angularDistance) +
    Math.cos(phi1) * Math.sin(angularDistance) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(angularDistance) * Math.cos(phi1),
    Math.cos(angularDistance) - Math.sin(phi1) * Math.sin(phi2)
  );
  const outLon = ((lambda2 * 180 / Math.PI + 540) % 360) - 180;
  return [outLon, phi2 * 180 / Math.PI];
}

async function resolveRouteLocations(areas) {
  const idents = [...new Set(areas.flatMap(area => area.route.map(parseRoutePointToken).filter(Boolean).map(point => point.ident)))];
  const locations = new Map();
  try {
    const path = process.env.NAVAID_SNAPSHOT;
    const snapshot = path && existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : await fetchPayload(NAVAID_SNAPSHOT_URL);
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length < 500)
      throw new Error('invalid navaid snapshot');
    const wanted = new Set(idents);
    for (const row of snapshot.rows) {
      const ident = String(row?.[0] || '').toUpperCase();
      const lat = +row?.[3], lon = +row?.[4];
      if (!wanted.has(ident) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const current = locations.get(ident);
      const preferred = String(row?.[2] || '').toUpperCase() === 'UNITED STATES';
      if (!current || preferred) locations.set(ident, { lat, lon });
    }
  } catch (error) {
    console.warn(`警告：基础 NAVAID 快照不可用，将查询 FAA：${error.message}`);
  }

  const unresolvedNavaids = idents.filter(ident => !locations.has(ident));
  for (let i = 0; i < unresolvedNavaids.length; i += 70) {
    const chunk = unresolvedNavaids.slice(i, i + 70);
    const params = new URLSearchParams({
      where: `IDENT IN (${chunk.map(value => `'${value}'`).join(',')})`,
      outFields: 'IDENT,NAME_TXT,COUNTRY',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    });
    const collection = await fetchPayload(`${NAVAID_QUERY}?${params}`);
    for (const feature of collection.features || []) {
      const ident = String(feature.properties?.IDENT || '').toUpperCase();
      const coordinates = feature.geometry?.coordinates;
      if (!ident || !Array.isArray(coordinates) || !coordinates.slice(0, 2).every(Number.isFinite)) continue;
      const current = locations.get(ident);
      const preferred = String(feature.properties?.COUNTRY || '').toUpperCase() === 'UNITED STATES';
      if (!current || preferred) locations.set(ident, { lon: +coordinates[0], lat: +coordinates[1] });
    }
  }

  const missing = idents.filter(ident => !locations.has(ident));
  for (let i = 0; i < missing.length; i += 15) {
    const chunk = missing.slice(i, i + 15);
    const ids = chunk.flatMap(ident => [ident, `K${ident}`, `C${ident}`, `P${ident}`]).join(',');
    try {
      const airports = await fetchPayload(`${AWC_BASE}airport?ids=${encodeURIComponent(ids)}&format=json`);
      for (const airport of Array.isArray(airports) ? airports : []) {
        const icao = String(airport.icaoId || '').toUpperCase(), ident = icao.slice(-3);
        const lat = +airport.lat, lon = +airport.lon;
        if (chunk.includes(ident) && Number.isFinite(lat) && Number.isFinite(lon) && !locations.has(ident))
          locations.set(ident, { lat, lon });
      }
    } catch (error) {
      console.warn(`警告：机场回退查询失败：${error.message}`);
    }
  }
  return locations;
}

function commonProperties(kind, name, hazard, series, validity, altitude, raw, bounds) {
  return {
    WX_WEATHER: 1,
    WX_KIND: kind,
    NAME: name,
    WX_HAZARD: hazard,
    WX_SERIES: series,
    WX_VALID_FROM: validity.from,
    WX_VALID_TO: validity.to,
    WX_BASE_KNOWN: altitude.baseKnown ? 1 : 0,
    WX_TOP_KNOWN: altitude.topKnown ? 1 : 0,
    WX_RAW: raw,
    WX_BBOX: bounds,
    LOWER_VAL: altitude.lowerVal,
    LOWER_UOM: 'FT',
    LOWER_CODE: altitude.lowerCode,
    UPPER_VAL: altitude.upperVal,
    UPPER_UOM: 'FT',
    UPPER_CODE: altitude.upperCode
  };
}

function sigmetName(kind, properties) {
  const p = properties || {};
  if (kind === 'SIG_CONV' && canonicalSigmetHazard(p.hazard) === 'CONVECTIVE')
    return `CONVECTIVE SIGMET ${p.seriesId || ''}`.trim();
  const hazard = String(p.hazard || '').trim().toUpperCase();
  return `SIGMET ${p.seriesId || ''}${hazard ? ` · ${hazard}` : ''}`.trim();
}

function normalizeSigmetFeature(source, kind, prefix) {
  const p = source.properties || {}, geometry = normalizeGeometry(source.geometry), altitude = sigmetAltitude(p, kind);
  const bounds = geometryBounds(geometry);
  const from = Date.parse(p.validTimeFrom), to = Date.parse(p.validTimeTo);
  if (!geometry || !bounds || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const series = String(p.seriesId || 'UNKNOWN');
  const properties = commonProperties(kind, sigmetName(kind, p), String(p.hazard || '').toUpperCase(), series,
    { from, to }, altitude, String(p.rawAirSigmet || p.rawSigmet || ''), bounds);
  properties.WX_SIGMET = 1;
  properties.WX_PRODUCT_KEY = `WX|${kind}|${prefix}|${p.icaoId || p.firId || ''}|${series}|${from}`;
  const identity = stableHash([geometry, properties.WX_RAW, altitude, from, to]);
  properties.GLOBAL_ID = `${properties.WX_PRODUCT_KEY}|${identity}`;
  return { type: 'Feature', geometry, properties };
}

export function normalizeCwaFeature(source) {
  const p = source?.properties || {};
  const geometry = normalizeGeometry(source?.geometry), bounds = geometryBounds(geometry);
  const from = Date.parse(p.validTimeFrom), to = Date.parse(p.validTimeTo);
  const altitude = sigmetAltitude(p, 'CWA');
  if (!geometry || !bounds || !Number.isFinite(from) || !Number.isFinite(to) || !altitude) return null;
  const center = String(p.cwsu || 'CWSU').trim().toUpperCase();
  const series = String(p.seriesId || 'UNKNOWN').trim().toUpperCase();
  const hazard = canonicalSigmetHazard(p.hazard);
  const properties = commonProperties('CWA', `CWA ${center} ${series}${hazard ? ` · ${hazard}` : ''}`,
    hazard, series, { from, to }, altitude, String(p.cwaText || p.rawText || ''), bounds);
  properties.WX_CWA = 1;
  properties.WX_CWSU = center;
  properties.WX_QUALIFIER = String(p.qualifier || '').trim();
  properties.WX_PRODUCT_KEY = `WX|CWA|${center}|${series}|${from}`;
  properties.GLOBAL_ID = `${properties.WX_PRODUCT_KEY}|${stableHash([geometry, properties.WX_RAW, altitude, from, to])}`;
  return { type:'Feature', geometry, properties };
}

export function outlookFeature(area, locations) {
  const coordinates = [];
  for (const token of area.route || []) {
    const point = parseRoutePointToken(token), location = point && locations.get(point.ident);
    if (!point || !location) return null;
    coordinates.push(destinationPoint(location.lat, location.lon, point.bearing, point.distanceNm));
  }
  if (coordinates.length < 3) return null;
  const first = coordinates[0], last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
  const geometry = normalizeGeometry({ type: 'Polygon', coordinates: [coordinates] }), bounds = geometryBounds(geometry);
  if (!geometry || !bounds) return null;
  const regionName = { W: 'WEST', C: 'CENTRAL', E: 'EAST' }[area.region] || 'US';
  const altitude = sigmetAltitude({}, 'COUT');
  const properties = commonProperties('COUT', `CONVECTIVE OUTLOOK · ${regionName} ${area.area}`,
    'CONVECTIVE OUTLOOK', `${area.region || 'US'}${area.area}`, area, altitude, area.raw || '', bounds);
  properties.WX_SIGMET = 1;
  properties.WX_PRODUCT_KEY = `WX|COUT|${area.code}|${area.region || 'US'}|${area.area}`;
  properties.GLOBAL_ID = `${properties.WX_PRODUCT_KEY}|${stableHash(area.route)}`;
  properties.WX_OUTLOOK = 1;
  return { type: 'Feature', geometry, properties };
}

function validateFeatureCollection(collection, label) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features))
    throw new Error(`${label} 未返回有效的 GeoJSON FeatureCollection`);
}

function validPolygonGeometry(geometry) {
  const polygons = geometry?.type === 'MultiPolygon' ? geometry.coordinates :
    geometry?.type === 'Polygon' ? [geometry.coordinates] : null;
  if (!Array.isArray(polygons) || !polygons.length) return false;
  return polygons.every(polygon => Array.isArray(polygon) && polygon.length &&
    polygon.every(ring => Array.isArray(ring) && ring.length >= 4 &&
      ring.every(point => Array.isArray(point) && point.length >= 2 &&
        Number.isFinite(+point[0]) && Number.isFinite(+point[1]) &&
        +point[0] >= -540 && +point[0] <= 540 && +point[1] >= -90 && +point[1] <= 90))); // AWC 跨日期变更线要素会用 181° 等展开经度保持环连续
}

export function validateSigmetSnapshot(snapshot, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!snapshot || snapshot.schemaVersion !== 3 || !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      !String(snapshot.source || '').includes('aviationweather.gov') || !Array.isArray(snapshot.features))
    throw new Error('SIGMET 快照缺少有效的 schemaVersion、generatedAt、source 或 features');
  if (!snapshot.features.length) throw new Error('SIGMET 快照为空，拒绝覆盖现有数据');
  const ids = new Set(), counts = Object.fromEntries(SIGMET_KINDS.map(kind => [kind, 0]));
  for (const [index, feature] of snapshot.features.entries()) {
    const p = feature?.properties || {}, kind = p.WX_KIND;
    if (!Object.hasOwn(counts, kind)) throw new Error(`SIGMET 要素 ${index} 的 WX_KIND 无效`);
    if (!p.WX_WEATHER || !p.WX_PRODUCT_KEY) throw new Error(`SIGMET 要素 ${index} 缺少产品元数据`);
    if (kind === 'CWA' ? !p.WX_CWA : !p.WX_SIGMET)
      throw new Error(`SIGMET 要素 ${index} 的产品类型标记无效`);
    if (!p.GLOBAL_ID || ids.has(p.GLOBAL_ID)) throw new Error(`SIGMET 要素 ${index} 的 GLOBAL_ID 缺失或重复：${p.GLOBAL_ID || '(empty)'}`);
    ids.add(p.GLOBAL_ID); counts[kind]++;
    if (!validPolygonGeometry(feature.geometry)) throw new Error(`SIGMET 要素 ${p.GLOBAL_ID} 的多边形无效`);
    if (!Array.isArray(p.WX_BBOX) || p.WX_BBOX.length !== 4 || !p.WX_BBOX.every(Number.isFinite))
      throw new Error(`SIGMET 要素 ${p.GLOBAL_ID} 的 WX_BBOX 无效`);
    if (!Number.isFinite(+p.WX_VALID_FROM) || !Number.isFinite(+p.WX_VALID_TO) || +p.WX_VALID_TO <= +p.WX_VALID_FROM)
      throw new Error(`SIGMET 要素 ${p.GLOBAL_ID} 的有效期无效`);
    if (+p.WX_VALID_TO <= now) throw new Error(`SIGMET 要素 ${p.GLOBAL_ID} 在生成时已经过期`);
    if (![p.LOWER_VAL, p.UPPER_VAL].every(Number.isFinite) || p.UPPER_VAL <= p.LOWER_VAL)
      throw new Error(`SIGMET 要素 ${p.GLOBAL_ID} 的垂直范围无效`);
  }
  const previous = options.previous;
  if (Array.isArray(previous?.features)) {
    const previousLive = previous.features.filter(feature => +(feature?.properties?.WX_VALID_TO || 0) > now).length;
    const minimum = previousLive >= 20 ? Math.max(5, Math.floor(previousLive * 0.2)) : 1;
    if (snapshot.features.length < minimum)
      throw new Error(`新快照仅有 ${snapshot.features.length} 个要素，低于现有有效快照保护阈值 ${minimum}`);
  }
  return { features:snapshot.features.length, counts };
}

export function mergeSigmetSnapshots(snapshot, previous, now = Date.now()) {
  if (!Array.isArray(snapshot?.features) || !Array.isArray(previous?.features)) return snapshot;
  const currentKeys = new Set(snapshot.features.map(feature => feature?.properties?.WX_PRODUCT_KEY).filter(Boolean));
  const byId = new Map(snapshot.features.map(feature => [feature.properties.GLOBAL_ID, feature]));
  for (const feature of previous.features) {
    const p = feature?.properties || {};
    if (!SIGMET_KINDS.includes(p.WX_KIND) || !p.WX_WEATHER || !p.GLOBAL_ID || !p.WX_PRODUCT_KEY ||
        +p.WX_VALID_TO <= now || currentKeys.has(p.WX_PRODUCT_KEY)) continue;
    byId.set(p.GLOBAL_ID, feature); // AWC 后端节点偶发漏项：仍有效且未被同产品新修订覆盖时沿用上一份
  }
  snapshot.features = [...byId.values()].sort((a,b)=>a.properties.GLOBAL_ID.localeCompare(b.properties.GLOBAL_ID));
  return snapshot;
}

export async function buildSigmetSnapshot() {
  const [domesticCollection, internationalCollection, cwaCollection, rawText] = await Promise.all([
    fetchPayload(DOMESTIC_URL), fetchPayload(INTERNATIONAL_URL), fetchPayload(CWA_URL), fetchPayload(RAW_URL, 'text')
  ]);
  validateFeatureCollection(domesticCollection, 'AWC Domestic SIGMET');
  validateFeatureCollection(internationalCollection, 'AWC International SIGMET');
  validateFeatureCollection(cwaCollection, 'AWC CWA');
  const features = [];
  for (const source of domesticCollection.features) {
    const kind = classifyDomesticSigmet(source.properties);
    if (!kind) continue;
    const feature = normalizeSigmetFeature(source, kind, 'DOM');
    if (feature) features.push(feature);
  }
  for (const source of internationalCollection.features) {
    const kind = classifyInternationalSigmet(source.properties);
    if (!kind) continue;
    const feature = normalizeSigmetFeature(source, kind, 'INTL');
    if (feature) features.push(feature);
  }
  for (const source of cwaCollection.features) {
    const feature = normalizeCwaFeature(source);
    if (feature) features.push(feature);
  }

  const outlookByKey = new Map();
  for (const bulletin of String(rawText || '').split(/\n-{10,}\n/)) {
    for (const area of parseOutlookAreas(bulletin)) {
      const key = `${area.code}|${area.region}|${area.area}|${area.route.join('-')}`;
      if (!outlookByKey.has(key)) outlookByKey.set(key, { ...area, raw: bulletin.trim() });
    }
  }
  const outlooks = [...outlookByKey.values()];
  const locations = await resolveRouteLocations(outlooks);
  for (const area of outlooks) {
    const feature = outlookFeature(area, locations);
    if (feature) features.push(feature);
    else console.warn(`警告：跳过无法完整解析的 Convective Outlook ${area.region}${area.area}: ${area.route.join('-')}`);
  }

  const generatedAt = Date.now();
  const currentFeatures = [...new Map(features
    .filter(feature => +feature.properties.WX_VALID_TO > generatedAt)
    .map(feature => [feature.properties.GLOBAL_ID, feature])).values()]; // AWC 偶尔重复返回完全相同的国际 SIGMET
  currentFeatures.sort((a, b) => a.properties.GLOBAL_ID.localeCompare(b.properties.GLOBAL_ID));
  const snapshot = { schemaVersion:3, generatedAt:new Date(generatedAt).toISOString(), source:SOURCE_URL, features:currentFeatures };
  validateSigmetSnapshot(snapshot, { now:generatedAt });
  return snapshot;
}

function readExistingSnapshot(output) {
  if (!existsSync(output)) return null;
  try {
    return JSON.parse(readFileSync(output, 'utf8').replace(/^\s*window\.SIGMET_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch {
    return null;
  }
}

function writeSnapshotAtomic(output, snapshot) {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `window.SIGMET_DATA=${JSON.stringify(snapshot)};\n`);
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function main() {
  const output = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  console.log('正在读取 AWC 国内/国际 SIGMET、CWA 与 Convective SIGMET Outlook…');
  const snapshot = await buildSigmetSnapshot();
  const existing = readExistingSnapshot(output);
  mergeSigmetSnapshots(snapshot, existing, Date.parse(snapshot.generatedAt));
  validateSigmetSnapshot(snapshot, { previous:existing });
  writeSnapshotAtomic(output, snapshot);
  const { counts } = validateSigmetSnapshot(snapshot);
  const countText = Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' / ');
  console.log(`已写出 ${output}（${countText}）`);
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main().catch(error => {
  console.error('失败:', error.stack || error.message);
  process.exitCode = 1;
});
