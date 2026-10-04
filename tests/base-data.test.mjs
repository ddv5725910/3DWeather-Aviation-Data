import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  arcgisFeatures,
  featureBounds,
  fetchJson,
  parseCsv,
  partitionFeatures,
  regionKey,
  regionKeysForBounds
} from '../scripts/base-data-utils.mjs';
import { compactOurAirports, compactOurRunways } from '../scripts/build-ourairports-base.mjs';
import { clipFeatureToRegion, simplifyRing } from '../scripts/build-faa-base.mjs';
import { classicAssetSource } from '../scripts/wrap-base-assets.mjs';

function sourceFeatures(offset, count, attributes = false) {
  return Array.from({ length:count }, (_, index) => ({
    geometry:null,
    [attributes ? 'attributes' : 'properties']:{ OBJECTID:offset + index + 1 }
  }));
}

function mockArcgis(count, pageResponse, extra = {}) {
  const calls = [], delays = [], progress = [], attempts = new Map();
  const options = {
    pageSize:2, concurrency:1, ...extra,
    sleep:async delay => { delays.push(delay); },
    onProgress:value => { progress.push(value); },
    fetchImpl:async (url, request) => {
      const params = new URL(url).searchParams;
      const offset = params.has('resultOffset') ? +params.get('resultOffset') : null;
      const attempt = (attempts.get(offset) || 0) + 1;
      attempts.set(offset, attempt);
      calls.push({ offset, attempt, params, request });
      if (offset == null) return Response.json({ count });
      return pageResponse({ offset, attempt, params, request });
    }
  };
  return { options, calls, delays, progress, attempts };
}

test('FAA pagination accepts all 6045 features, including the final 45-feature page', async () => {
  const mock = mockArcgis(6045, ({ offset }) =>
    Response.json({ features:sourceFeatures(offset, Math.min(250, 6045 - offset)) }),
  { pageSize:250, concurrency:4 });
  const features = await arcgisFeatures('Class_Airspace', mock.options);
  assert.equal(features.length, 6045);
  assert.deepEqual(features.map(feature => feature.properties.OBJECTID), Array.from({ length:6045 }, (_, i) => i + 1));
  assert.equal(mock.calls.length, 26);
  assert.equal(mock.attempts.get(6000), 1);
  assert.equal(mock.progress.length, 25);
  assert.deepEqual(mock.progress.at(-1), { service:'Class_Airspace', completed:25, pages:25, count:6045 });
  assert.deepEqual(mock.delays, []);
});

const invalidPageResponses = [
  ['ArcGIS business error', () => Response.json({ error:{ code:500, message:'Query failed', details:['Temporary failure'] } })],
  ['missing features', () => Response.json({})],
  ['non-array features', () => Response.json({ features:{} })],
  ['empty page', () => Response.json({ features:[] })],
  ['short page', () => Response.json({ features:sourceFeatures(0, 1) })],
  ['oversized page', () => Response.json({ features:sourceFeatures(0, 3) })],
  ['invalid feature', () => Response.json({ features:[null, {}] })],
  ['invalid JSON', () => new Response('{"features":')],
  ['invalid payload', () => Response.json(null)],
  ['HTTP 503', () => new Response('Unavailable', { status:503, headers:{ 'retry-after':'2' } })],
  ['network error', () => { throw new Error('Connection reset'); }]
];

for (const [name, invalidResponse] of invalidPageResponses) {
  test(`FAA pagination retries ${name} at the same offset before accepting a page`, async () => {
    const mock = mockArcgis(4, ({ offset, attempt }) =>
      offset === 2 && attempt === 1 ? invalidResponse() : Response.json({ features:sourceFeatures(offset, 2) }));
    const features = await arcgisFeatures('Class_Airspace', mock.options);
    assert.equal(features.length, 4);
    assert.deepEqual(mock.calls.map(call => call.offset), [null, 0, 2, 2]);
    assert.equal(mock.progress.length, 2);
    assert.deepEqual(mock.delays, [name === 'HTTP 503' ? 2000 : 700]);
  });
}

test('FAA pagination retries a short final page but allows its expected remainder', async () => {
  const mock = mockArcgis(5, ({ offset, attempt }) => Response.json({
    features:sourceFeatures(offset, offset === 4 && attempt === 1 ? 0 : Math.min(2, 5 - offset))
  }));
  assert.equal((await arcgisFeatures('Class_Airspace', mock.options)).length, 5);
  assert.deepEqual(mock.calls.map(call => call.offset), [null, 0, 2, 4, 4]);
  assert.equal(mock.progress.length, 3);
});

test('FAA pagination fails closed with offset and actual count after the retry budget', async () => {
  const mock = mockArcgis(4, ({ offset }) => Response.json({ features:sourceFeatures(offset, offset === 2 ? 1 : 2) }));
  await assert.rejects(arcgisFeatures('Class_Airspace', mock.options),
    /Class_Airspace page at offset 2 after 4 attempts: ArcGIS returned 1\/2 expected features/);
  assert.deepEqual(mock.calls.map(call => call.offset), [null, 0, 2, 2, 2, 2]);
  assert.deepEqual(mock.delays, [700, 1400, 2800]);
  assert.equal(mock.progress.length, 1);
});

test('FAA error diagnostics preserve the service, offset and ArcGIS error details', async () => {
  const mock = mockArcgis(2, () => Response.json({ error:{ code:500, message:'Query failed', details:['Try again'] } }), { attempts:2 });
  await assert.rejects(arcgisFeatures('Class_Airspace', mock.options),
    /Class_Airspace page at offset 0 after 2 attempts: ArcGIS error 500: Query failed \(Try again\)/);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.progress.length, 0);
});

test('FAA non-retryable HTTP errors fail immediately with the actual attempt count', async () => {
  const mock = mockArcgis(2, () => new Response('Not found', { status:404 }));
  await assert.rejects(arcgisFeatures('MissingService', mock.options), /MissingService page at offset 0 after 1 attempts: HTTP 404/);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.delays, []);
});

test('FAA attribute-only responses and query options stay compatible', async () => {
  const mock = mockArcgis(2, ({ offset }) => Response.json({ features:sourceFeatures(offset, 2, true) }), {
    returnGeometry:false, where:'ACTIVE = 1', outFields:'OBJECTID', orderByFields:'OBJECTID ASC',
    geometryPrecision:5, maxAllowableOffset:0.001
  });
  assert.deepEqual(await arcgisFeatures('US_Airport', mock.options), sourceFeatures(0, 2));
  const params = mock.calls[1].params;
  assert.equal(params.get('f'), 'json');
  assert.equal(params.get('returnGeometry'), 'false');
  assert.equal(params.get('where'), 'ACTIVE = 1');
  assert.equal(params.get('outFields'), 'OBJECTID');
  assert.equal(params.get('orderByFields'), 'OBJECTID ASC');
  assert.equal(params.get('geometryPrecision'), '5');
  assert.equal(params.get('maxAllowableOffset'), '0.001');
});

test('FAA count validation retries invalid counts and ArcGIS errors rather than accepting empty data', async t => {
  const payloads = [{}, { count:null }, { count:'' }, { count:'2' }, { count:-1 }, { count:1.5 },
    { count:Number.MAX_SAFE_INTEGER + 1 }, { error:{ code:500, message:'Count failed' } }];
  for (const payload of payloads) await t.test(JSON.stringify(payload), async () => {
    let calls = 0;
    const delays = [];
    const features = await arcgisFeatures('Class_Airspace', {
      fetchImpl:async () => Response.json(++calls === 1 ? payload : { count:0 }),
      sleep:async delay => { delays.push(delay); }
    });
    assert.deepEqual(features, []);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [700]);
  });
});

test('FAA invalid count responses exhaust a single bounded retry budget', async () => {
  let calls = 0;
  await assert.rejects(arcgisFeatures('Class_Airspace', {
    attempts:2,
    fetchImpl:async () => { calls++; return Response.json({}); },
    sleep:async () => {}
  }), /Class_Airspace count after 2 attempts: ArcGIS returned an invalid count/);
  assert.equal(calls, 2);
});

test('JSON body read errors are retried without a nested request retry loop', async () => {
  let calls = 0;
  const payload = await fetchJson('https://example.test/data', {
    attempts:3,
    fetchImpl:async () => ({ ok:true, json:async () => {
      if (++calls < 3) throw new Error('Body stream interrupted');
      return { count:2 };
    } }),
    sleep:async () => {}
  });
  assert.deepEqual(payload, { count:2 });
  assert.equal(calls, 3);
});

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

test('FAA arc sampling is simplified while preserving closure and winding', () => {
  const ring = [[-122, 37], [-121.99999, 37.000001], [-121.99998, 37.000002], [-121, 37], [-121, 38], [-122, 38], [-122, 37]];
  const simplified = simplifyRing(ring, 5);
  assert.ok(simplified.length < ring.length);
  assert.deepEqual(simplified[0], simplified.at(-1));
});

test('base assets are classic scripts that load without cross-origin fetch', () => {
  const context = { Object };
  context.globalThis = context;
  vm.runInNewContext(classicAssetSource('airspace-test.js', { schemaVersion:1, layers:{ class:[1] } }), context);
  assert.equal(context.__AVIATION_BASE_SCRIPT_ASSETS__['airspace-test.js'].layers.class[0], 1);
});

test('CSV parser and OurAirports compactors preserve quoted commas', () => {
  const airports = parseCsv('iso_country,type,latitude_deg,longitude_deg,elevation_ft,iata_code,icao_code,ident,name\nUS,small_airport,37.1,-122.1,100,,KRHV,RHV,"Reid, Hillview"\n');
  assert.deepEqual(compactOurAirports(airports), [[2, 37.1, -122.1, 30, 'KRHV', 'Reid, Hillview']]);
  const runways = parseCsv('closed,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg,width_ft,le_ident,he_ident\n0,37,-122,37.1,-121.9,75,13,31\n');
  assert.deepEqual(compactOurRunways(runways), [[37, -122, 37.1, -121.9, 75, '13', '31']]);
});
