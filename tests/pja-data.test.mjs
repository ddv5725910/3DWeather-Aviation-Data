import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pjaZipCandidates } from '../scripts/build-pja.mjs';

test('FAA PJA cycle URLs use the latest effective 28-day cycle and one fallback', () => {
  assert.deepEqual(pjaZipCandidates(Date.UTC(2026, 6, 18)), [
    'https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_PJA_CSV.zip',
    'https://nfdc.faa.gov/webContent/28DaySub/extra/11_Jun_2026_PJA_CSV.zip'
  ]);
  assert.deepEqual(pjaZipCandidates(Date.UTC(2026, 7, 6)), [
    'https://nfdc.faa.gov/webContent/28DaySub/extra/06_Aug_2026_PJA_CSV.zip',
    'https://nfdc.faa.gov/webContent/28DaySub/extra/09_Jul_2026_PJA_CSV.zip'
  ]);
});

test('checked-in PJA fallback is a plausible browser snapshot', () => {
  const text = readFileSync(new URL('../data/pja.js', import.meta.url), 'utf8');
  const snapshot = JSON.parse(text.replace(/^\s*window\.PJA_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
  assert.ok(snapshot.length > 100);
  for (const [index, item] of snapshot.entries()) {
    assert.ok(Array.isArray(item) && item.length >= 6, `PJA ${index} has an invalid row`);
    assert.ok(Number.isFinite(+item[0]) && +item[0] >= -90 && +item[0] <= 90, `PJA ${index} has an invalid latitude`);
    assert.ok(Number.isFinite(+item[1]) && +item[1] >= -180 && +item[1] <= 180, `PJA ${index} has an invalid longitude`);
    assert.ok(Number.isFinite(+item[2]) && +item[2] > 0, `PJA ${index} has an invalid radius`);
    assert.ok(Number.isFinite(+item[3]) && +item[3] > 0, `PJA ${index} has an invalid altitude`);
  }
});
