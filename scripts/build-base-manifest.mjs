#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.BASE_DATA_OUTPUT || resolve(ROOT, 'dist/base'));
const releaseBaseUrl = String(process.env.BASE_DATA_RELEASE_URL || '').replace(/\/?$/, '/');
const datasetId = String(process.env.BASE_DATASET_ID || '').trim();
if (!releaseBaseUrl || !datasetId) throw new Error('BASE_DATA_RELEASE_URL and BASE_DATASET_ID are required');

const faa = JSON.parse(readFileSync(resolve(OUTPUT, 'faa-meta.json'), 'utf8'));
const our = JSON.parse(readFileSync(resolve(OUTPUT, 'ourairports-meta.json'), 'utf8'));
const manifest = {
  schemaVersion:1,
  datasetId,
  generatedAt:new Date().toISOString(),
  source:'FAA ArcGIS and OurAirports',
  releaseBaseUrl,
  assets:{
    faaAirports:'faa-airports.json',
    ourAirports:'ourairports-airports.json',
    ourRunways:'ourairports-runways.json',
    navaids:'navaids.json',
    airspace:{ step:faa.airspace.step, keys:faa.airspace.keys, template:'airspace-{key}.json' },
    airportMap:{ step:faa.airportMapRegions.step, keys:faa.airportMapRegions.keys, template:'airport-map-{key}.json' }
  },
  counts:{
    faaAirports:faa.faaAirports,
    ourAirports:our.airports,
    ourRunways:our.runways,
    navaids:faa.navaids,
    classAirspace:faa.classAirspace,
    eAirspace:faa.eAirspace,
    specialUseAirspace:faa.specialUseAirspace,
    airportMap:faa.airportMap
  }
};
writeFileSync(resolve(OUTPUT, 'aviation-base-manifest.js'),
  `(function(g){g.AVIATION_BASE_MANIFEST=Object.freeze(${JSON.stringify(manifest)});})(typeof window!=="undefined"?window:globalThis);\n`);
console.log(`Aviation base manifest ${datasetId}: ${faa.assetCount} release assets`);
