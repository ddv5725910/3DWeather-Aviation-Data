import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
