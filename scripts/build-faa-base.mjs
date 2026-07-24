#!/usr/bin/env node

import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import {
  arcgisFeatures,
  featureBounds,
  regionKeysForBounds,
  writeJson
} from './base-data-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.BASE_DATA_OUTPUT || resolve(ROOT, 'dist/base'));
const AIRSPACE_STEP = 5;
const AIRPORT_MAP_STEP = 5;
const D2R = Math.PI / 180;
const GEOMETRY_TOLERANCE_M = 5;

function progress({ service, completed, pages, count }) {
  console.log(`${service}: page ${completed}/${pages}, ${count} source features`);
}

function prop(feature, key) {
  return String(feature?.properties?.[key] || '').toUpperCase();
}

function unwrapRing(ring, anchorLon = null) {
  if (!ring || ring.length < 2) return [];
  let length = ring.length;
  const closed = ring[0][0] === ring[length - 1][0] && ring[0][1] === ring[length - 1][1];
  if (closed) length--;
  const out = [];
  let previous = anchorLon == null ? +ring[0][0] : anchorLon;
  for (let index = 0; index < length; index++) {
    let lon = +ring[index][0];
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    out.push([lon, +ring[index][1]]);
    previous = lon;
  }
  if (out.length) out.push(out[0].slice());
  return out;
}

function segmentDistanceSq(point, start, end, scaleX, scaleY) {
  let x = start[0] * scaleX, y = start[1] * scaleY;
  let dx = end[0] * scaleX - x, dy = end[1] * scaleY - y;
  const px = point[0] * scaleX, py = point[1] * scaleY;
  if (dx || dy) {
    const fraction = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (fraction > 1) { x += dx; y += dy; }
    else if (fraction > 0) { x += dx * fraction; y += dy * fraction; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

function ringArea2(ring) {
  let area = 0;
  for (let index = 0; index + 1 < ring.length; index++)
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  return area;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a, b, c, d) {
  const epsilon = 1e-12;
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  const on = (p, q, r) => Math.abs(orient(p, q, r)) <= epsilon &&
    r[0] >= Math.min(p[0], q[0]) - epsilon && r[0] <= Math.max(p[0], q[0]) + epsilon &&
    r[1] >= Math.min(p[1], q[1]) - epsilon && r[1] <= Math.max(p[1], q[1]) + epsilon;
  return (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon)) &&
    ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) ||
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function ringSelfIntersects(ring) {
  const length = ring.length - 1;
  if (length < 4) return false;
  for (let i = 0; i < length; i++) for (let j = i + 2; j < length; j++) {
    if (i === 0 && j === length - 1) continue;
    const a = ring[i], b = ring[i + 1], c = ring[j], d = ring[j + 1];
    if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
        Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
    if (segmentsCross(a, b, c, d)) return true;
  }
  return false;
}

export function simplifyRing(ring, toleranceM = GEOMETRY_TOLERANCE_M) {
  if (!ring || ring.length < 6 || toleranceM <= 0) return ring;
  const unwrapped = unwrapRing(ring), body = unwrapped.slice(0, -1);
  if (body.length < 5) return ring;
  let pivot = 0, latitude = 0;
  for (let index = 0; index < body.length; index++) {
    latitude += body[index][1];
    if (body[index][0] < body[pivot][0] ||
        (body[index][0] === body[pivot][0] && body[index][1] < body[pivot][1])) pivot = index;
  }
  latitude /= body.length;
  const points = body.slice(pivot).concat(body.slice(0, pivot), [body[pivot]]);
  const scaleX = 111320 * Math.max(0.05, Math.cos(latitude * D2R)), scaleY = 111320;
  const toleranceSq = toleranceM * toleranceM, keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let best = toleranceSq, at = -1;
    for (let index = start + 1; index < end; index++) {
      const distance = segmentDistanceSq(points[index], points[start], points[end], scaleX, scaleY);
      if (distance > best) { best = distance; at = index; }
    }
    if (at >= 0) { keep[at] = 1; stack.push([start, at], [at, end]); }
  }
  const out = [];
  for (let index = 0; index < points.length; index++) if (keep[index]) out.push(points[index]);
  if (out.length < 4) return ring;
  out[out.length - 1] = out[0].slice();
  const sourceArea = ringArea2(unwrapped), outputArea = ringArea2(out);
  const ratio = Math.abs(outputArea) / Math.max(1e-18, Math.abs(sourceArea));
  if (sourceArea * outputArea <= 0 || ratio < 0.8 || ratio > 1.25 || ringSelfIntersects(out)) return ring;
  return out.map(point => [(((point[0] + 180) % 360) + 360) % 360 - 180, point[1]]);
}

function simplifyGeometry(geometry) {
  if (!geometry?.coordinates) return geometry;
  const simplifyPolygon = polygon => (polygon || []).map(ring => simplifyRing(ring)).filter(ring => ring?.length >= 4);
  if (geometry.type === 'Polygon') return { type:'Polygon', coordinates:simplifyPolygon(geometry.coordinates) };
  if (geometry.type === 'MultiPolygon') return {
    type:'MultiPolygon', coordinates:geometry.coordinates.map(simplifyPolygon).filter(polygon => polygon.length)
  };
  return geometry;
}

function supportedRegion(west, south, step) {
  const east = west + step, north = south + step;
  const intersects = (minLat, maxLat, minLon, maxLon) =>
    south < maxLat && north > minLat && west < maxLon && east > minLon;
  return intersects(24, 50, -125, -66) ||
    intersects(51, 72, -170, -129) ||
    intersects(18, 23, -161, -154);
}

function compactFaaAirports(features) {
  return features.flatMap(feature => {
    const coordinates = feature.geometry?.coordinates, p = feature.properties || {};
    if (!Array.isArray(coordinates) || !coordinates.slice(0, 2).every(Number.isFinite)) return [];
    return [[+coordinates[1], +coordinates[0], String(p.IDENT || '').trim(), String(p.NAME || '').trim(),
      String(p.TYPE_CODE || '').trim(), Math.round((+p.ELEVATION || 0) * 0.3048)]];
  });
}

function compactNavaids(features) {
  return features.flatMap(feature => {
    const coordinates = feature.geometry?.coordinates, p = feature.properties || {};
    if (!Array.isArray(coordinates) || !coordinates.slice(0, 2).every(Number.isFinite) || !p.IDENT) return [];
    return [[String(p.IDENT).trim().toUpperCase(), String(p.NAME_TXT || '').trim(),
      String(p.COUNTRY || '').trim(), +coordinates[1], +coordinates[0]]];
  });
}

export function clipFeatureToRegion(feature, west, south, step) {
  const geometry = feature?.geometry;
  if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) return null;
  const rectangle = [[[
    [west, south], [west + step, south], [west + step, south + step],
    [west, south + step], [west, south]
  ]]];
  let clipped;
  try {
    clipped = polygonClipping.intersection(
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates,
      rectangle
    );
  } catch (error) {
    throw new Error(`Unable to clip feature ${feature?.properties?.GLOBAL_ID || feature?.properties?.OBJECTID || ''}: ${error.message}`);
  }
  if (!clipped?.length) return null;
  return {
    geometry:clipped.length === 1
      ? { type:'Polygon', coordinates:clipped[0] }
      : { type:'MultiPolygon', coordinates:clipped },
    properties:feature.properties || {}
  };
}

function addLayer(regions, name, features, step) {
  for (const feature of features || []) {
    const simplified = { geometry:simplifyGeometry(feature.geometry), properties:feature.properties || {} };
    for (const region of regionKeysForBounds(featureBounds(simplified), step)) {
      if (!supportedRegion(region.west, region.south, step)) continue;
      const clipped = clipFeatureToRegion(simplified, region.west, region.south, step);
      if (!clipped) continue;
      let target = regions.get(region.key);
      if (!target) regions.set(region.key, target = { ...region, layers:{} });
      (target.layers[name] ||= []).push(clipped);
    }
  }
}

function writeRegions(prefix, regions, step) {
  const keys = [...regions.keys()].sort();
  for (const key of keys) {
    const region = regions.get(key);
    writeJson(resolve(OUTPUT, `${prefix}-${key}.json`), {
      schemaVersion:1,
      region:{ west:region.west, south:region.south, size:step },
      layers:region.layers
    });
  }
  return keys;
}

export async function buildFaaBase(options = {}) {
  const query = options.arcgisFeaturesImpl || arcgisFeatures;
  mkdirSync(OUTPUT, { recursive:true });
  for (const name of readdirSync(OUTPUT))
    if (/^(?:airspace|airport-map)-.+\.json$/.test(name)) unlinkSync(resolve(OUTPUT, name));
  const generatedAt = new Date().toISOString();

  const [airportFeatures, navaidFeatures, classFeatures, suaFeatures] = await Promise.all([
    query('US_Airport', { outFields:'OBJECTID,IDENT,NAME,TYPE_CODE,ELEVATION', pageSize:1000, onProgress:progress }),
    query('NAVAIDSystem', { outFields:'OBJECTID,IDENT,NAME_TXT,COUNTRY', pageSize:1000, onProgress:progress }),
    query('Class_Airspace', {
      outFields:'GLOBAL_ID,NAME,CLASS,IDENT,LOCAL_TYPE,LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE',
      geometryPrecision:5,
      pageSize:250, concurrency:4, timeoutMs:120000, onProgress:progress
    }),
    query('Special_Use_Airspace', {
      outFields:'GLOBAL_ID,NAME,TYPE_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE',
      geometryPrecision:5,
      pageSize:250, concurrency:4, timeoutMs:120000, onProgress:progress
    })
  ]);

  const airports = compactFaaAirports(airportFeatures);
  const navaids = compactNavaids(navaidFeatures);
  if (airports.length < 1000 || navaids.length < 500) throw new Error('FAA point datasets are unexpectedly small');
  writeJson(resolve(OUTPUT, 'faa-airports.json'), {
    schemaVersion:1, generatedAt, source:'FAA ArcGIS US_Airport', rows:airports
  });
  writeJson(resolve(OUTPUT, 'navaids.json'), {
    schemaVersion:1, generatedAt, source:'FAA ArcGIS NAVAIDSystem', rows:navaids
  });

  const airspaceRegions = new Map();
  addLayer(airspaceRegions, 'class', classFeatures.filter(feature => ['B', 'C', 'D'].includes(prop(feature, 'CLASS'))), AIRSPACE_STEP);
  addLayer(airspaceRegions, 'e', classFeatures.filter(feature => prop(feature, 'CLASS') === 'E'), AIRSPACE_STEP);
  addLayer(airspaceRegions, 'sua', suaFeatures, AIRSPACE_STEP);
  const airspaceKeys = writeRegions('airspace', airspaceRegions, AIRSPACE_STEP);

  const airportMapSpecs = [
    ['apron', 'AM_Apron', 'OBJECTID'],
    ['taxiway', 'AM_Taxiway', 'OBJECTID,DESIGNATOR,FAA_ID,ICAO_ID'],
    ['runway', 'RunwayArea', 'OBJECTID,DESIGNATOR_TXT'],
    ['building', 'AM_Building', 'OBJECTID']
  ];
  const airportMapRegions = new Map();
  const airportMapCounts = {};
  for (const [name, service, outFields] of airportMapSpecs) {
    const features = await query(service, {
      outFields, geometryPrecision:6, pageSize:500, concurrency:4, timeoutMs:120000, onProgress:progress
    });
    airportMapCounts[name] = features.length;
    addLayer(airportMapRegions, name, features, AIRPORT_MAP_STEP);
  }
  const airportMapKeys = writeRegions('airport-map', airportMapRegions, AIRPORT_MAP_STEP);
  const assetCount = airspaceKeys.length + airportMapKeys.length + 4;
  if (assetCount > 950) throw new Error(`Base release would contain too many assets: ${assetCount}`);

  const meta = {
    generatedAt,
    faaAirports:airports.length,
    navaids:navaids.length,
    classAirspace:classFeatures.filter(feature => ['B', 'C', 'D'].includes(prop(feature, 'CLASS'))).length,
    eAirspace:classFeatures.filter(feature => prop(feature, 'CLASS') === 'E').length,
    specialUseAirspace:suaFeatures.length,
    airportMap:airportMapCounts,
    airspace:{ step:AIRSPACE_STEP, keys:airspaceKeys },
    airportMapRegions:{ step:AIRPORT_MAP_STEP, keys:airportMapKeys },
    assetCount
  };
  writeJson(resolve(OUTPUT, 'faa-meta.json'), meta);
  return meta;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildFaaBase();
  console.log(`FAA base data: ${result.faaAirports} airports, ${result.navaids} navaids, ${result.assetCount} assets`);
}
