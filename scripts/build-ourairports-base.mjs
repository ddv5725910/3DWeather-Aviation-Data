#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText, parseCsv, writeJson } from './base-data-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.BASE_DATA_OUTPUT || resolve(ROOT, 'dist/base'));
const AIRPORTS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const RUNWAYS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv';

export function compactOurAirports(rows) {
  const types = new Map([['large_airport', 0], ['medium_airport', 1], ['small_airport', 2]]);
  return rows.flatMap(row => {
    if (row.iso_country !== 'US' || !types.has(row.type)) return [];
    const lat = +row.latitude_deg, lon = +row.longitude_deg;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const name = String(row.name || '').slice(0, 30);
    return [[types.get(row.type), lat, lon, Math.round((+row.elevation_ft || 0) * 0.3048),
      row.iata_code || row.icao_code || row.ident || '', name]];
  });
}

export function compactOurRunways(rows) {
  return rows.flatMap(row => {
    if (row.closed === '1') return [];
    const lat1 = +row.le_latitude_deg, lon1 = +row.le_longitude_deg;
    const lat2 = +row.he_latitude_deg, lon2 = +row.he_longitude_deg;
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite) ||
        (lat1 === 0 && lon1 === 0) || (lat2 === 0 && lon2 === 0)) return [];
    return [[+lat1.toFixed(6), +lon1.toFixed(6), +lat2.toFixed(6), +lon2.toFixed(6),
      Math.round(+row.width_ft || 75), String(row.le_ident || '').trim(), String(row.he_ident || '').trim()]];
  });
}

export async function buildOurAirportsBase(options = {}) {
  const generatedAt = new Date().toISOString();
  const fetchTextImpl = options.fetchTextImpl || fetchText;
  const [airportsText, runwaysText] = await Promise.all([
    fetchTextImpl(AIRPORTS_URL),
    fetchTextImpl(RUNWAYS_URL)
  ]);
  const airports = compactOurAirports(parseCsv(airportsText));
  const runways = compactOurRunways(parseCsv(runwaysText));
  if (airports.length < 1000) throw new Error(`Unexpected OurAirports airport count: ${airports.length}`);
  if (runways.length < 10000) throw new Error(`Unexpected OurAirports runway count: ${runways.length}`);
  mkdirSync(OUTPUT, { recursive:true });
  writeJson(resolve(OUTPUT, 'ourairports-airports.json'), {
    schemaVersion:1, generatedAt, source:'OurAirports airports.csv', rows:airports
  });
  writeJson(resolve(OUTPUT, 'ourairports-runways.json'), {
    schemaVersion:1, generatedAt, source:'OurAirports runways.csv', rows:runways
  });
  writeJson(resolve(OUTPUT, 'ourairports-meta.json'), {
    generatedAt, airports:airports.length, runways:runways.length
  });
  return { airports:airports.length, runways:runways.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildOurAirportsBase();
  console.log(`OurAirports base data: ${result.airports} airports, ${result.runways} runways`);
}
