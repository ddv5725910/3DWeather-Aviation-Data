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

function progress({ service, completed, pages, count }) {
  console.log(`${service}: page ${completed}/${pages}, ${count} source features`);
}

function prop(feature, key) {
  return String(feature?.properties?.[key] || '').toUpperCase();
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
    for (const region of regionKeysForBounds(featureBounds(feature), step)) {
      if (!supportedRegion(region.west, region.south, step)) continue;
      const clipped = clipFeatureToRegion(feature, region.west, region.south, step);
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
      geometryPrecision:5, maxAllowableOffset:0.00005,
      pageSize:250, concurrency:4, timeoutMs:120000, onProgress:progress
    }),
    query('Special_Use_Airspace', {
      outFields:'GLOBAL_ID,NAME,TYPE_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE',
      geometryPrecision:5, maxAllowableOffset:0.00005,
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
