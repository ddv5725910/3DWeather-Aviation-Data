import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignAltitudeDefinitions,
  normalizePolygonWinding,
  parseAltitudeDefinition,
  parseFaaUtc,
  parseTfrDetail,
  signedRingArea
} from '../scripts/build-tfr.mjs';

test('FAA UTC labels are parsed without relying on locale Date parsing', () => {
  assert.equal(
    parseFaaUtc('July 17, 2026 at 0439 UTC'),
    Date.UTC(2026, 6, 17, 4, 39)
  );
  assert.equal(parseFaaUtc('July 20, 2026 UTC', true), Date.UTC(2026, 6, 20, 23, 59, 59));
  assert.equal(parseFaaUtc('July 17, 2026 at 0439 UTC (July 16, 2026 at 2139 PDT)'), Date.UTC(2026, 6, 17, 4, 39));
  assert.equal(parseFaaUtc('Permanent'), null);
  assert.equal(parseFaaUtc('not a date'), null);
});

test('TFR altitude definitions preserve SFC, AGL, MSL, and unlimited datums', () => {
  assert.deepEqual(
    parseAltitudeDefinition('Altitude: From the surface up to and including 11,000 feet MSL'),
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 11000, upperCode: 'MSL' }
  );
  assert.deepEqual(
    parseAltitudeDefinition('From and including 3500 feet MSL up to and including 18000 feet MSL'),
    { lowerVal: 3500, lowerCode: 'MSL', upperVal: 18000, upperCode: 'MSL' }
  );
  assert.deepEqual(
    parseAltitudeDefinition('From the surface up to Unlimited'),
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 60000, upperCode: 'UNL' }
  );
});

test('detail parser keeps each airspace block altitude and its validity window', () => {
  const html = `
    <td>Beginning Date and Time :</td><td>July 17, 2026 at 0439 UTC</td>
    <td>Ending Date and Time :</td><td>July 30, 2026 at 0700 UTC</td>
    Airspace Definition: Altitude: From the surface up to and including 11000 feet MSL
    Airspace Definition: Altitude: From and including 2000 feet AGL up to and including 9000 feet MSL
  `;
  const parsed = parseTfrDetail(html);
  assert.equal(parsed.startAt, Date.UTC(2026, 6, 17, 4, 39));
  assert.equal(parsed.endAt, Date.UTC(2026, 6, 30, 7, 0));
  assert.deepEqual(parsed.altitudes, [
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 11000, upperCode: 'MSL' },
    { lowerVal: 2000, lowerCode: 'AGL', upperVal: 9000, upperCode: 'MSL' }
  ]);
});

test('detail parser handles effective-immediately and date-only FAA validity fields', () => {
  const parsed = parseTfrDetail(`
    Issue Date : June 12, 2026 at 1245 UTC
    Beginning Date and Time : Effective Immediately
    Ending Date and Time : July 21, 2026 UTC
    Reason for NOTAM : Temporary flight restrictions
    Airspace Definition: Altitude: From the surface up to and including 400 feet AGL
  `);
  assert.equal(parsed.startAt, Date.UTC(2026, 5, 12, 12, 45));
  assert.equal(parsed.endAt, Date.UTC(2026, 6, 21, 23, 59, 59));
});

test('generated polygons face outward: outer rings clockwise and holes counter-clockwise', () => {
  const polygon = normalizePolygonWinding([
    [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    [[0.2, 0.2], [0.2, 0.8], [0.8, 0.8], [0.8, 0.2], [0.2, 0.2]]
  ]);
  assert.ok(signedRingArea(polygon[0]) < 0);
  assert.ok(signedRingArea(polygon[1]) > 0);
  assert.deepEqual(polygon[0][0], polygon[0].at(-1));
  assert.deepEqual(polygon[1][0], polygon[1].at(-1));
});

test('mismatched FAA geometry/detail counts use a conservative vertical envelope', () => {
  assert.deepEqual(assignAltitudeDefinitions(2, [
    { lowerVal: 1000, lowerCode: 'AGL', upperVal: 18000, upperCode: 'MSL' },
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 43000, upperCode: 'MSL' },
    { lowerVal: 3000, lowerCode: 'MSL', upperVal: 22000, upperCode: 'MSL' }
  ]), [
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 43000, upperCode: 'MSL' },
    { lowerVal: 0, lowerCode: 'SFC', upperVal: 43000, upperCode: 'MSL' }
  ]);
});
