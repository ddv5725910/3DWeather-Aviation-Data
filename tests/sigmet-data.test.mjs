import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyDomesticSigmet,
  classifyInternationalSigmet,
  classifySigmetHazard,
  destinationPoint,
  fetchPayload,
  mergeSigmetSnapshots,
  normalizeCwaFeature,
  outlookFeature,
  parseOutlookAreas,
  parseOutlookValidity,
  parseRoutePointToken,
  sigmetAltitude,
  validateSigmetSnapshot
} from '../scripts/build-sigmet.mjs';
import { signedRingArea } from '../scripts/build-tfr.mjs';

test('SIGMET classification exposes pilot-facing hazard layers for domestic and international products', () => {
  assert.equal(classifyDomesticSigmet({ airSigmetType: 'SIGMET', hazard: 'CONVECTIVE' }), 'SIG_CONV');
  assert.equal(classifyDomesticSigmet({ airSigmetType: 'SIGMET', hazard: 'TURB' }), 'SIG_TURB');
  assert.equal(classifyDomesticSigmet({ airSigmetType: 'AIRMET', hazard: 'TURB' }), null);
  assert.equal(classifyInternationalSigmet({ hazard:'TS' }), 'SIG_CONV');
  assert.equal(classifyInternationalSigmet({ hazard:'TC' }), 'SIG_TC');
  assert.equal(classifyInternationalSigmet({ hazard:'MTW' }), 'SIG_TURB');
  assert.equal(classifySigmetHazard('volcanic ash'), 'SIG_VA');
  assert.equal(classifySigmetHazard('dust storm'), 'SIG_DUST');
  assert.equal(classifySigmetHazard('unknown'), null);
});

test('SIGMET altitude envelopes preserve known bounds and flag conservative fallbacks', () => {
  assert.deepEqual(sigmetAltitude({ altitudeLow1: 18000, altitudeHi1: 42000 }, 'SIG_CONV'), {
    lowerVal: 18000, lowerCode: 'MSL', upperVal: 42000, upperCode: 'MSL', baseKnown: true, topKnown: true
  });
  assert.deepEqual(sigmetAltitude({ base: null, top: 38000 }, 'SIG_TURB'), {
    lowerVal: 0, lowerCode: 'SFC', upperVal: 38000, upperCode: 'MSL', baseKnown: false, topKnown: true
  });
  assert.deepEqual(sigmetAltitude({}, 'COUT'), {
    lowerVal: 0, lowerCode: 'SFC', upperVal: 60000, upperCode: 'UNL', baseKnown: false, topKnown: false
  });
});

test('CWA normalization preserves its center, hazard, validity, geometry, and vertical metadata', () => {
  const feature = normalizeCwaFeature({
    type:'Feature',
    properties:{
      cwsu:'ZLC',
      seriesId:'201',
      validTimeFrom:'2026-07-19T18:00:00.000Z',
      validTimeTo:'2026-07-19T20:00:00.000Z',
      hazard:'TS',
      qualifier:'DVLPG',
      cwaText:'ZLC CWA 201 VALID UNTIL 192000',
      base:8000,
      top:42000
    },
    geometry:{ type:'Polygon', coordinates:[[[-112,39],[-110,39],[-111,41],[-112,39]]] }
  });
  assert.equal(feature.properties.WX_KIND, 'CWA');
  assert.equal(feature.properties.WX_CWA, 1);
  assert.equal(feature.properties.WX_CWSU, 'ZLC');
  assert.equal(feature.properties.WX_HAZARD, 'TS');
  assert.equal(feature.properties.LOWER_VAL, 8000);
  assert.equal(feature.properties.UPPER_VAL, 42000);
  assert.match(feature.properties.NAME, /^CWA ZLC 201/);
  assert.deepEqual(feature.properties.WX_BBOX, [-112,39,-110,41]);
});

test('Convective Outlook parser handles wrapped routes and multiple numbered areas', () => {
  const anchor = Date.UTC(2026, 6, 17, 4, 55);
  const raw = `WSUS32 KKCI 170455
SIGC
CONVECTIVE SIGMET 30C
OUTLOOK VALID 170655-171055
AREA 1...FROM ADM-LFK-CRP-LRD-40NW DLF-60SE MRF-60WSW LBB-ADM
WST ISSUANCES POSS.

AREA 2...FROM 60NNE MOT-80WNW INL-60WSW YQT-40SW GIJ-50NNE
MSL-60WNW ARG-DBQ-BRD-40S BIS-60NNE MOT
REF WW 491
WST ISSUANCES EXPD.`;
  const areas = parseOutlookAreas(raw, anchor);
  assert.equal(areas.length, 2);
  assert.deepEqual(areas.map(area => [area.region, area.area]), [['C', 1], ['C', 2]]);
  assert.equal(areas[1].route[0], '60NNE MOT');
  assert.equal(areas[1].route.at(-1), '60NNE MOT');
  assert.deepEqual(parseOutlookValidity(raw, anchor), {
    from: Date.UTC(2026, 6, 17, 6, 55),
    to: Date.UTC(2026, 6, 17, 10, 55),
    code: '170655-171055'
  });
});

test('outlook route offsets use 16-point compass bearings and nautical miles', () => {
  assert.deepEqual(parseRoutePointToken('60WNW DPR'), { ident: 'DPR', distanceNm: 60, bearing: 292.5 });
  assert.deepEqual(parseRoutePointToken('ADM'), { ident: 'ADM', distanceNm: 0, bearing: 0 });
  assert.equal(parseRoutePointToken('NOT VALID'), null);
  const [lon, lat] = destinationPoint(0, 0, 90, 60);
  assert.ok(Math.abs(lat) < 0.001);
  assert.ok(Math.abs(lon - 0.9993) < 0.01);
});

test('generated Convective Outlook polygons face outward and expose unknown altitude metadata', () => {
  const area = {
    area: 1, region: 'W', route: ['AAA', 'BBB', 'CCC', 'AAA'],
    from: Date.UTC(2026, 6, 17, 6), to: Date.UTC(2026, 6, 17, 10), code: '170600-171000'
  };
  const locations = new Map([
    ['AAA', { lat: 35, lon: -120 }],
    ['BBB', { lat: 37, lon: -118 }],
    ['CCC', { lat: 34, lon: -115 }]
  ]);
  const feature = outlookFeature(area, locations);
  assert.ok(feature);
  assert.equal(feature.properties.WX_KIND, 'COUT');
  assert.equal(feature.properties.WX_TOP_KNOWN, 0);
  assert.equal(feature.properties.UPPER_CODE, 'UNL');
  assert.ok(signedRingArea(feature.geometry.coordinates[0]) < 0);
  assert.equal(feature.properties.GLOBAL_ID, outlookFeature(area, locations).properties.GLOBAL_ID);
});

test('AWC fetch retries transient errors and immediately preserves a successful response', async () => {
  let calls = 0, sleeps = 0;
  const payload = await fetchPayload('https://example.invalid/weather', 'json', {
    attempts: 3,
    timeoutMs: 1000,
    sleep: async () => { sleeps++; },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok:false, status:503, headers:{ get:()=>'0' } };
      return { ok:true, status:200, headers:{ get:()=>null }, json:async()=>({ type:'FeatureCollection', features:[] }) };
    }
  });
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(payload.type, 'FeatureCollection');
});

function snapshotFeature(id, validTo, kind = 'SIG_TURB') {
  return {
    type:'Feature',
    geometry:{ type:'Polygon', coordinates:[[[-100,35],[-99,35],[-99,36],[-100,35]]] },
    properties:{
      GLOBAL_ID:id, WX_PRODUCT_KEY:`product-${id}`, WX_WEATHER:1, WX_SIGMET:1,
      WX_KIND:kind, WX_VALID_FROM:validTo-3600000, WX_VALID_TO:validTo,
      WX_BBOX:[-100,35,-99,36], LOWER_VAL:0, UPPER_VAL:10000
    }
  };
}

test('snapshot validation rejects malformed, expired, duplicate, and suspiciously partial updates', () => {
  const now = Date.UTC(2026, 6, 17, 6);
  const base = { schemaVersion:3, generatedAt:new Date(now).toISOString(), source:'https://aviationweather.gov/data/api/' };
  const valid = { ...base, features:[snapshotFeature('one',now+3600000)] };
  assert.deepEqual(validateSigmetSnapshot(valid,{now}).counts,{
    SIG_CONV:0,SIG_TC:0,SIG_TURB:1,SIG_ICE:0,SIG_VA:0,SIG_DUST:0,CWA:0,COUT:0
  });
  assert.throws(()=>validateSigmetSnapshot({...base,features:[]},{now}),/为空/);
  assert.throws(()=>validateSigmetSnapshot({...base,features:[snapshotFeature('old',now)]},{now}),/已经过期/);
  assert.throws(()=>validateSigmetSnapshot({...base,features:[snapshotFeature('same',now+1),snapshotFeature('same',now+2)]},{now}),/重复/);
  const cwa=snapshotFeature('cwa',now+3600000,'CWA'); delete cwa.properties.WX_SIGMET; cwa.properties.WX_CWA=1;
  assert.equal(validateSigmetSnapshot({...base,features:[cwa]},{now}).counts.CWA,1);
  const previous={features:Array.from({length:30},(_,index)=>snapshotFeature(`old-${index}`,now+3600000))};
  assert.throws(()=>validateSigmetSnapshot(valid,{now,previous}),/保护阈值/);
});

test('snapshot merge keeps upstream omissions but lets a new product revision replace the old revision', () => {
  const now=Date.UTC(2026,6,17,6);
  const retained=snapshotFeature('retained-old',now+3600000);
  retained.properties.WX_PRODUCT_KEY='retained';
  const replaced=snapshotFeature('revision-old',now+3600000);
  replaced.properties.WX_PRODUCT_KEY='revision';
  const expired=snapshotFeature('expired-old',now-1);
  expired.properties.WX_PRODUCT_KEY='expired';
  const revision=snapshotFeature('revision-new',now+7200000);
  revision.properties.WX_PRODUCT_KEY='revision';
  const snapshot={features:[revision]},previous={features:[retained,replaced,expired]};
  mergeSigmetSnapshots(snapshot,previous,now);
  assert.deepEqual(snapshot.features.map(feature=>feature.properties.GLOBAL_ID).sort(),['retained-old','revision-new']);
});

test('checked-in browser snapshot is schema-valid at its generation time', () => {
  const text=readFileSync(new URL('../data/sigmet.js',import.meta.url),'utf8');
  const snapshot=JSON.parse(text.replace(/^\s*window\.SIGMET_DATA\s*=\s*/,'').replace(/;\s*$/,''));
  const result=validateSigmetSnapshot(snapshot,{now:Date.parse(snapshot.generatedAt)});
  assert.equal(result.features,snapshot.features.length);
  assert.equal(Object.values(result.counts).reduce((sum,count)=>sum+count,0),snapshot.features.length);
});
