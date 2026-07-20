import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  airmetAltitude,
  airmetGeometryBounds,
  airmetValidity,
  buildAirmetSnapshot,
  classifyAirmet,
  normalizeAirmetFeature,
  validateAirmetSnapshot
} from '../scripts/build-airmet.mjs';

const VALID_1800 = '2026-07-19T18:00:00.000Z';

function polygonProperties(overrides = {}) {
  return {
    product:'TANGO',
    hazard:'TURB-HI',
    tag:'3W',
    issueTime:'2026-07-19T15:33:00.000Z',
    validTime:VALID_1800,
    receiptTime:'2026-07-19T15:34:00.649Z',
    forecast:3,
    severity:'MOD',
    top:'450',
    base:'340',
    ...overrides
  };
}

function polygonFeature(overrides = {}) {
  return {
    type:'Feature',
    properties:polygonProperties(overrides),
    geometry:{
      type:'Polygon',
      coordinates:[[[-122, 40], [-118, 40], [-119, 44], [-122, 40]]]
    }
  };
}

function freezingFeature(overrides = {}) {
  return {
    type:'Feature',
    properties:polygonProperties({
      product:'ZULU',
      hazard:'FZLVL',
      tag:'1C',
      level:'160',
      top:undefined,
      base:undefined,
      ...overrides
    }),
    geometry:{
      type:'LineString',
      coordinates:[[-124, 32], [-120, 36], [-115, 40]]
    }
  };
}

test('1800WXBrief-style G-AIRMET classification exposes eight hazards directly', () => {
  assert.equal(classifyAirmet({ product:'TANGO', hazard:'TURB-HI' }), 'TURB_HI');
  assert.equal(classifyAirmet({ product:'TANGO', hazard:'TURB-LO' }), 'TURB_LO');
  assert.equal(classifyAirmet({ product:'TANGO', hazard:'LLWS' }), 'LLWS');
  assert.equal(classifyAirmet({ product:'TANGO', hazard:'SFC_WIND' }), 'SFC_WIND');
  assert.equal(classifyAirmet({ product:'SIERRA', hazard:'IFR' }), 'IFR');
  assert.equal(classifyAirmet({ product:'SIERRA', hazard:'MT_OBSC' }), 'MT_OBSC');
  assert.equal(classifyAirmet({ product:'ZULU', hazard:'ICE' }), 'ICE');
  assert.equal(classifyAirmet({ product:'ZULU', hazard:'FZLVL' }), 'FZLVL');
  assert.equal(classifyAirmet({ product:'UNKNOWN', hazard:'ICE' }), null);
});

test('1800Z nominal products use the briefing display window from 1501Z through 2059Z', () => {
  assert.deepEqual(airmetValidity({ validTime:VALID_1800 }), {
    nominal:Date.UTC(2026, 6, 19, 18),
    from:Date.UTC(2026, 6, 19, 15, 1),
    to:Date.UTC(2026, 6, 19, 20, 59)
  });
});

test('AIRMET altitude parser converts hundreds of feet and preserves unknown IFR bounds', () => {
  assert.deepEqual(airmetAltitude({ base:'340', top:'450' }, 'TURB_HI'), {
    lowerVal:34000,
    lowerCode:'STD',
    upperVal:45000,
    upperCode:'STD',
    baseKnown:true,
    topKnown:true,
    levelKnown:false
  });
  assert.deepEqual(airmetAltitude({}, 'IFR'), {
    lowerVal:0,
    lowerCode:'SFC',
    upperVal:500,
    upperCode:'MSL',
    baseKnown:false,
    topKnown:false,
    levelKnown:false
  });
  assert.equal(airmetAltitude({ level:'160' }, 'FZLVL').lowerVal, 16000);
});

test('normalized G-AIRMET polygons and freezing contours retain official geometry semantics', () => {
  const turbulence = normalizeAirmetFeature(polygonFeature());
  assert.equal(turbulence.properties.WX_KIND, 'TURB_HI');
  assert.equal(turbulence.properties.WX_AIRMET, 1);
  assert.equal(turbulence.properties.LOWER_VAL, 34000);
  assert.equal(turbulence.geometry.type, 'Polygon');
  assert.deepEqual(turbulence.properties.WX_BBOX, [-122, 40, -118, 44]);

  const freezing = normalizeAirmetFeature(freezingFeature());
  assert.equal(freezing.properties.WX_KIND, 'FZLVL');
  assert.equal(freezing.properties.WX_FREEZING_LEVEL, 1);
  assert.equal(freezing.properties.WX_LEVEL_FT, 16000);
  assert.equal(freezing.geometry.type, 'LineString');
  assert.deepEqual(airmetGeometryBounds(freezing.geometry), [-124, 32, -115, 40]);
  assert.match(freezing.properties.NAME, /1800Z/);
});

test('AIRMET snapshot builder accepts official GeoJSON field names and counts direct hazard layers', async () => {
  const collection = {
    type:'FeatureCollection',
    validTime:Date.UTC(2026, 6, 19, 18) / 1000,
    features:[
      polygonFeature(),
      polygonFeature({ product:'SIERRA', hazard:'IFR', tag:'4E', top:undefined, base:undefined }),
      polygonFeature({ product:'SIERRA', hazard:'MT_OBSC', tag:'5E', top:undefined, base:undefined }),
      polygonFeature({ product:'TANGO', hazard:'LLWS', tag:'1L', top:'020', base:'SFC' }),
      polygonFeature({ product:'TANGO', hazard:'SFC_WIND', tag:'1W', top:'005', base:'SFC' }),
      polygonFeature({ product:'TANGO', hazard:'TURB-LO', tag:'2W', top:'120', base:'SFC' }),
      polygonFeature({ product:'ZULU', hazard:'ICE', tag:'2C', top:'260', base:'160' }),
      freezingFeature()
    ]
  };
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 6, 19, 17);
  try {
    const snapshot = await buildAirmetSnapshot({
      attempts:1,
      fetchImpl:async () => ({
        ok:true,
        status:200,
        headers:{ get:() => null },
        json:async () => collection
      })
    });
    assert.equal(snapshot.nominalValidTime, VALID_1800);
    assert.deepEqual(validateAirmetSnapshot(snapshot, { now:Date.now() }).counts, {
      IFR:1,
      MT_OBSC:1,
      LLWS:1,
      SFC_WIND:1,
      FZLVL:1,
      TURB_HI:1,
      TURB_LO:1,
      ICE:1
    });
  } finally {
    Date.now = originalNow;
  }
});

test('snapshot validation rejects malformed geometry, duplicates, expired data, and partial replacement', () => {
  const now = Date.UTC(2026, 6, 19, 17);
  const feature = normalizeAirmetFeature(polygonFeature());
  const freezing = normalizeAirmetFeature(freezingFeature());
  const base = {
    schemaVersion:1,
    generatedAt:new Date(now).toISOString(),
    source:'https://aviationweather.gov/data/api/'
  };
  const valid = { ...base, features:[feature, freezing] };
  assert.equal(validateAirmetSnapshot(valid, { now }).features, 2);
  assert.throws(() => validateAirmetSnapshot({ ...base, features:[] }, { now }), /为空/);
  assert.throws(() => validateAirmetSnapshot({ ...base, features:[feature, feature] }, { now }), /重复/);
  const broken = structuredClone(freezing);
  broken.geometry = { type:'Polygon', coordinates:[] };
  assert.throws(() => validateAirmetSnapshot({ ...base, features:[broken] }, { now }), /几何无效/);
  assert.throws(() => validateAirmetSnapshot(valid, { now:Date.UTC(2026, 6, 19, 21) }), /已经过期/);
  const previous = { features:Array.from({ length:30 }, (_, index) => {
    const item = structuredClone(feature);
    item.properties.GLOBAL_ID = `old-${index}`;
    return item;
  }) };
  assert.throws(() => validateAirmetSnapshot({ ...base, features:[feature] }, { now, previous }), /保护阈值/);
});

test('checked-in browser AIRMET snapshot is schema-valid at its generation time', () => {
  const text = readFileSync(new URL('../data/airmet.js', import.meta.url), 'utf8');
  const snapshot = JSON.parse(text.replace(/^\s*window\.AIRMET_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
  const result = validateAirmetSnapshot(snapshot, { now:Date.parse(snapshot.generatedAt) });
  assert.equal(result.features, snapshot.features.length);
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), snapshot.features.length);
});
