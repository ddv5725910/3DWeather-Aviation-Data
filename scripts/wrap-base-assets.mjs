#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(process.env.BASE_DATA_OUTPUT || resolve(ROOT, 'dist/base'));
const RELEASE_ASSET = /^(?:faa-airports|navaids|ourairports-airports|ourairports-runways|airspace-.+|airport-map-.+)\.json$/;

export function classicAssetSource(filename, payload) {
  return `(function(g){var a=g.__AVIATION_BASE_SCRIPT_ASSETS__||(g.__AVIATION_BASE_SCRIPT_ASSETS__=Object.create(null));a[${JSON.stringify(filename)}]=${JSON.stringify(payload)};})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function wrapBaseAssets(output = OUTPUT) {
  const files = readdirSync(output).filter(filename => RELEASE_ASSET.test(filename)).sort();
  for (const jsonName of files) {
    const jsName = jsonName.replace(/\.json$/, '.js');
    const payload = JSON.parse(readFileSync(resolve(output, jsonName), 'utf8'));
    writeFileSync(resolve(output, jsName), classicAssetSource(jsName, payload));
  }
  if (files.length < 10) throw new Error(`Unexpected base asset count: ${files.length}`);
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Wrapped ${wrapBaseAssets()} aviation base assets as classic scripts`);
}
