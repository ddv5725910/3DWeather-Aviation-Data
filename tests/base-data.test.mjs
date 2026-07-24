import test from 'node:test';
import assert from 'node:assert/strict';

import {
  featureBounds,
  parseCsv,
  partitionFeatures,
  regionKey,
  regionKeysForBounds
} from '../scripts/base-data-utils.mjs';
import { compactOurAirports, compactOurRunways } from '../scripts/build-ourairports-base.mjs';
import { clipFeatureToRegion } from '../scripts/build-faa-base.mjs';

test('region keys are stable for negative FAA coordinates', () => {
  assert.equal(regionKey(-125, 35), 'm125-p35');
  assert.deepEqual(regionKeysForBounds([-126, 34, -119.5, 41], 5).map(value => value.key), [
    'm130-p30', 'm130-p35', 'm130-p40',
    'm125-p30', 'm125-p35', 'm125-p40',
    'm120-p30', 'm120-p35', 'm120-p40'
  ]);
});

test('features are copied into every intersecting region', () => {
  const feature = { geometry:{ type:'Polygon', coordinates:[[[-126, 37], [-119, 37], [-119, 41], [-126, 41], [-126, 37]]] }, properties:{ id:1 } };
  assert.deepEqual(featureBounds(feature), [-126, 37, -119, 41]);
  assert.equal(partitionFeatures([feature], 5).size, 6);
});

test('FAA polygon geometry is clipped instead of copied across regions', () => {
  const feature = { geometry:{ type:'Polygon', coordinates:[[[-126, 37], [-119, 37], [-119, 41], [-126, 41], [-126, 37]]] }, properties:{ OBJECTID:1 } };
  const clipped = clipFeatureToRegion(feature, -125, 35, 5);
  assert.equal(clipped.geometry.type, 'Polygon');
  assert.deepEqual(featureBounds(clipped), [-125, 37, -120, 40]);
});

test('CSV parser and OurAirports compactors preserve quoted commas', () => {
  const airports = parseCsv('iso_country,type,latitude_deg,longitude_deg,elevation_ft,iata_code,icao_code,ident,name\nUS,small_airport,37.1,-122.1,100,,KRHV,RHV,"Reid, Hillview"\n');
  assert.deepEqual(compactOurAirports(airports), [[2, 37.1, -122.1, 30, 'KRHV', 'Reid, Hillview']]);
  const runways = parseCsv('closed,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,width_ft,le_ident,he_ident\n0,37,-122,37.1,-121.9,75,13,31\n');
  assert.deepEqual(compactOurRunways(runways), [[37, -122, 37.1, -121.9, 75, '13', '31']]);
});
