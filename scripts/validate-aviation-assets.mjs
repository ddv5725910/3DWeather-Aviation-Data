#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateSigmetSnapshot } from './build-sigmet.mjs';
import { validateAirmetSnapshot } from './build-airmet.mjs';

const directory = resolve(process.argv[2] || 'data');

function readClassicScript(filename, globalName) {
  const text = readFileSync(resolve(directory, filename), 'utf8');
  const prefix = new RegExp(`^\\s*window\\.${globalName}\\s*=\\s*`);
  return JSON.parse(text.replace(prefix, '').replace(/;\s*$/, ''));
}

function validPolygonGeometry(geometry) {
  const polygons = geometry?.type === 'MultiPolygon' ? geometry.coordinates :
    geometry?.type === 'Polygon' ? [geometry.coordinates] : null;
  return Array.isArray(polygons) && polygons.length > 0 &&
    polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 &&
      polygon.every(ring => Array.isArray(ring) && ring.length >= 4 &&
        ring.every(point => Array.isArray(point) && point.length >= 2 &&
          Number.isFinite(+point[0]) && Number.isFinite(+point[1]))));
}

function validateTfr(snapshot) {
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      !String(snapshot.source || '').includes('tfr.faa.gov') ||
      !Array.isArray(snapshot.features) || !snapshot.features.length)
    throw new Error('TFR snapshot is missing valid metadata or features');
  const ids = new Set();
  for (const [index, feature] of snapshot.features.entries()) {
    const properties = feature?.properties || {};
    if (!properties.GLOBAL_ID || ids.has(properties.GLOBAL_ID))
      throw new Error(`TFR feature ${index} has a missing or duplicate GLOBAL_ID`);
    ids.add(properties.GLOBAL_ID);
    if (!validPolygonGeometry(feature.geometry))
      throw new Error(`TFR feature ${properties.GLOBAL_ID} has invalid polygon geometry`);
    if (!Array.isArray(properties.TFR_BBOX) || properties.TFR_BBOX.length !== 4 ||
        !properties.TFR_BBOX.every(Number.isFinite))
      throw new Error(`TFR feature ${properties.GLOBAL_ID} has an invalid bounding box`);
    if (![properties.LOWER_VAL, properties.UPPER_VAL].every(Number.isFinite) ||
        properties.UPPER_VAL <= properties.LOWER_VAL)
      throw new Error(`TFR feature ${properties.GLOBAL_ID} has an invalid altitude range`);
  }
  return snapshot.features.length;
}

function validatePja(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length <= 100)
    throw new Error('PJA snapshot is unexpectedly small or malformed');
  for (const [index, item] of snapshot.entries()) {
    if (!Array.isArray(item) || item.length < 6 ||
        !Number.isFinite(+item[0]) || +item[0] < -90 || +item[0] > 90 ||
        !Number.isFinite(+item[1]) || +item[1] < -180 || +item[1] > 180 ||
        !Number.isFinite(+item[2]) || +item[2] <= 0 ||
        !Number.isFinite(+item[3]) || +item[3] <= 0)
      throw new Error(`PJA row ${index} is malformed`);
  }
  return snapshot.length;
}

const tfr = readClassicScript('tfr.js', 'TFR_DATA');
const sigmet = readClassicScript('sigmet.js', 'SIGMET_DATA');
const airmet = readClassicScript('airmet.js', 'AIRMET_DATA');
const pja = readClassicScript('pja.js', 'PJA_DATA');
const tfrCount = validateTfr(tfr);
const sigmetResult = validateSigmetSnapshot(sigmet, { now: Date.parse(sigmet.generatedAt) });
const airmetResult = validateAirmetSnapshot(airmet, { now: Date.parse(airmet.generatedAt) });
const pjaCount = validatePja(pja);

console.log(`Validated aviation assets: TFR ${tfrCount}, SIGMET ${sigmetResult.features}, AIRMET ${airmetResult.features}, PJA ${pjaCount}`);
