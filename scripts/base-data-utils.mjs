import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FAA_ARCGIS_ROOT =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services';
export const BASE_DATA_USER_AGENT =
  '3DWeather aviation base data builder (https://github.com/ddv5725910/3DWeather-Aviation-Data)';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = header && Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30000, seconds * 1000);
  return Math.min(10000, 700 * 2 ** attempt);
}

export async function fetchResponse(url, options = {}) {
  const attempts = Math.max(1, options.attempts || 4);
  const timeoutMs = Math.max(1000, options.timeoutMs || 30000);
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || wait;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers:{ 'User-Agent':BASE_DATA_USER_AGENT, ...(options.headers || {}) },
        signal:controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt + 1 >= attempts) break;
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Unable to download base data after ${attempts} attempts: ${lastError?.message || url}`, {
    cause:lastError
  });
}

export async function fetchJson(url, options = {}) {
  return (await fetchResponse(url, options)).json();
}

export async function fetchText(url, options = {}) {
  return (await fetchResponse(url, options)).text();
}

export async function arcgisFeatures(service, options = {}) {
  const endpoint = `${FAA_ARCGIS_ROOT}/${service}/FeatureServer/0/query`;
  const where = options.where || '1=1';
  const countParams = new URLSearchParams({ where, returnCountOnly:'true', f:'json' });
  const fetchOptions = { timeoutMs:options.timeoutMs || 60000, attempts:options.attempts || 4 };
  const count = +(await fetchJson(`${endpoint}?${countParams}`, fetchOptions)).count;
  if (!Number.isFinite(count) || count < 0) throw new Error(`${service} returned an invalid count: ${count}`);
  if (!count) return [];

  const pageSize = Math.max(1, Math.min(2000, options.pageSize || 1000));
  const offsets = [];
  for (let offset = 0; offset < count; offset += pageSize) offsets.push(offset);
  const pages = new Array(offsets.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const pageIndex = cursor++;
      if (pageIndex >= offsets.length) return;
      const params = new URLSearchParams({
        where,
        outFields:options.outFields || '*',
        returnGeometry:options.returnGeometry === false ? 'false' : 'true',
        outSR:'4326',
        orderByFields:options.orderByFields || 'OBJECTID',
        resultOffset:String(offsets[pageIndex]),
        resultRecordCount:String(pageSize),
        f:options.returnGeometry === false ? 'json' : 'geojson'
      });
      if (options.geometryPrecision != null) params.set('geometryPrecision', String(options.geometryPrecision));
      if (options.maxAllowableOffset != null) params.set('maxAllowableOffset', String(options.maxAllowableOffset));
      const payload = await fetchJson(`${endpoint}?${params}`, fetchOptions);
      const features = payload.features || [];
      pages[pageIndex] = features.map(feature => ({
        geometry:feature.geometry || null,
        properties:feature.properties || feature.attributes || {}
      }));
      options.onProgress?.({ service, completed:pages.filter(Boolean).length, pages:pages.length, count });
    }
  };
  await Promise.all(Array.from({ length:Math.min(options.concurrency || 3, offsets.length) }, worker));
  const features = pages.flat();
  if (features.length < count) throw new Error(`${service} returned ${features.length}/${count} features`);
  return features;
}

function visitCoordinates(value, callback) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(+value[0]) && Number.isFinite(+value[1])) {
    callback(+value[0], +value[1]);
    return;
  }
  for (const child of value) visitCoordinates(child, callback);
}

export function featureBounds(feature) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  visitCoordinates(feature?.geometry?.coordinates, (lon, lat) => {
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  });
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}

export function coordinateToken(value) {
  const number = Math.trunc(+value || 0);
  return number < 0 ? `m${Math.abs(number)}` : `p${number}`;
}

export function regionKey(west, south) {
  return `${coordinateToken(west)}-${coordinateToken(south)}`;
}

export function regionKeysForBounds(bounds, step) {
  if (!bounds || !Number.isFinite(step) || step <= 0) return [];
  const [west, south, east, north] = bounds;
  const x0 = Math.floor(west / step) * step;
  const y0 = Math.floor(south / step) * step;
  const x1 = Math.floor((east - 1e-9) / step) * step;
  const y1 = Math.floor((north - 1e-9) / step) * step;
  const keys = [];
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step)
    keys.push({ key:regionKey(x, y), west:x, south:y });
  return keys;
}

export function partitionFeatures(features, step) {
  const regions = new Map();
  for (const feature of features || []) {
    const bounds = featureBounds(feature);
    for (const region of regionKeysForBounds(bounds, step)) {
      let list = regions.get(region.key);
      if (!list) regions.set(region.key, list = { ...region, features:[] });
      list.features.push(feature);
    }
  }
  return regions;
}

export function parseCsvLine(line) {
  const fields = [];
  let current = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else if (character !== '\r') current += character;
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line), row = {};
    headers.forEach((header, index) => { row[header] = values[index] || ''; });
    return row;
  });
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive:true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
