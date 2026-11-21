#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var geo = require('../engine/geo');
var engineMod = require('../engine/fanfields2-engine');

var failed = 0;
var passed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok  ' + msg);
  } else {
    failed++;
    console.log('  FAIL  ' + msg);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function undirectedSet(plan) {
  var set = {};
  (plan.links || []).forEach(function (lk) {
    set[lk.fromId < lk.toId ? lk.fromId + '|' + lk.toId : lk.toId + '|' + lk.fromId] = true;
  });
  return set;
}

function directedSet(plan) {
  var set = {};
  (plan.links || []).forEach(function (lk) {
    set[lk.fromId + '>' + lk.toId] = true;
  });
  return set;
}

function setsEqual(a, b) {
  var ka = Object.keys(a).sort();
  var kb = Object.keys(b).sort();
  return deepEqual(ka, kb);
}

function loadBuxingjie() {
  var raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../testdata/buxingjie-41.json'), 'utf8'));
  var portals = [];
  Object.keys(raw.portals).forEach(function (folderId) {
    var folder = raw.portals[folderId];
    Object.keys(folder.bkmrk).forEach(function (bid) {
      var b = folder.bkmrk[bid];
      var parts = b.latlng.split(',');
      portals.push({
        guid: b.guid,
        lat: parseFloat(parts[0]),
        lng: parseFloat(parts[1]),
        name: b.label
      });
    });
  });
  return portals;
}

function planOf(engine, portals, opts) {
  opts = opts || {};
  return engine.plan({
    portals: portals,
    startingpointIndex: opts.startingpointIndex || 0,
    is_clockwise: opts.is_clockwise !== false,
    stardirection: opts.stardirection != null ? opts.stardirection : engineMod.CENTRALIZING,
    availableSBUL: opts.availableSBUL == null ? 2 : opts.availableSBUL,
    respectIntel: false
  });
}

var engine = engineMod.createEngine(geo.createEnv());

/* ---------- 1. small deterministic fixtures ---------- */
console.log('1. small fixtures: hull, bearing sort, max-gap rotate, CW/CCW, In/Out');

// A compact triangle + 2 interior-ish points in Liuzhou, far enough to not be collinear.
var A = { guid: 'A', name: 'AnchorA', lat: 24.32000, lng: 109.40000 };
var B = { guid: 'B', name: 'HullB',   lat: 24.32000, lng: 109.40200 };
var C = { guid: 'C', name: 'HullC',   lat: 24.32160, lng: 109.40100 };
var D = { guid: 'D', name: 'InnerD',  lat: 24.32050, lng: 109.40090 };
var E = { guid: 'E', name: 'InnerE',  lat: 24.32090, lng: 109.40120 };
var small = [A, B, C, D, E];

var hullSmall = engine.hullOf(small);
ok(hullSmall.length === 3, 'small set convex hull has 3 vertices, got ' + hullSmall.length);
var hullIds = hullSmall.map(function (h) { return h.guid; }).sort().join(',');
ok(hullIds === 'A,B,C', 'small hull vertices are A,B,C: ' + hullIds);

var p0 = planOf(engine, small, { startingpointIndex: 0, is_clockwise: true });
ok(p0.ok, 'small plan ok');
ok(p0.stations[0].isStart, 'index 0 is START / anchor');
ok(p0.stations[0].portal.guid === p0.startingpointGUID, 'start guid matches startingpointGUID');
ok(p0.portalCount === 5, 'portalCount is all selected portals (5)');
ok(p0.linkCount >= 3 && p0.fieldCount >= 1, 'small plan has links and fields: L=' + p0.linkCount + ' F=' + p0.fieldCount);

// Visit order: after max-gap rotate, the start stays first.
ok(p0.stations[0].portal.guid === hullSmall[0].guid, 'default index 0 uses first hull vertex as anchor');

// Bearings of sortedFanpoints[0] should be 0 (self).
ok(p0.sortedFanpoints[0].bearing === 0, 'anchor bearing is 0, got ' + p0.sortedFanpoints[0].bearing);

// CW vs CCW: visit order after the anchor is reversed.
var pCw = planOf(engine, small, { startingpointIndex: 0, is_clockwise: true });
var pCcw = planOf(engine, small, { startingpointIndex: 0, is_clockwise: false });
ok(pCw.stations[0].portal.guid === pCcw.stations[0].portal.guid, 'CW and CCW share the same anchor');
var cwTail = pCw.stations.slice(1).map(function (s) { return s.portal.guid; }).join(',');
var ccwTail = pCcw.stations.slice(1).map(function (s) { return s.portal.guid; }).join(',');
ok(cwTail !== ccwTail, 'CW and CCW visit tails differ: CW=' + cwTail + ' CCW=' + ccwTail);
ok(cwTail.split(',').reverse().join(',') === ccwTail, 'CCW tail is the reverse of the CW tail');

// Irregular cluster where the greedy candidate order depends on sweep
// direction, so CW and CCW accept different mesh links.
var rich = [
  { guid: 'H1', name: 'H1', lat: 24.31, lng: 109.39 },
  { guid: 'H2', name: 'H2', lat: 24.31, lng: 109.41 },
  { guid: 'H3', name: 'H3', lat: 24.33, lng: 109.4 },
  { guid: 'P0', name: 'P0', lat: 24.31514, lng: 109.39632 },
  { guid: 'P1', name: 'P1', lat: 24.31566, lng: 109.39750 },
  { guid: 'P2', name: 'P2', lat: 24.31550, lng: 109.39182 },
  { guid: 'P3', name: 'P3', lat: 24.32814, lng: 109.40094 },
  { guid: 'P4', name: 'P4', lat: 24.31110, lng: 109.39438 },
  { guid: 'P5', name: 'P5', lat: 24.31738, lng: 109.40074 },
  { guid: 'P6', name: 'P6', lat: 24.31834, lng: 109.40142 },
  { guid: 'P7', name: 'P7', lat: 24.31586, lng: 109.40646 },
  { guid: 'P8', name: 'P8', lat: 24.31222, lng: 109.40470 },
  { guid: 'P9', name: 'P9', lat: 24.32062, lng: 109.40114 },
  { guid: 'P10', name: 'P10', lat: 24.31614, lng: 109.40406 },
  { guid: 'P11', name: 'P11', lat: 24.32646, lng: 109.39798 }
];
var richCw = planOf(engine, rich, { startingpointIndex: 0, is_clockwise: true });
var richCcw = planOf(engine, rich, { startingpointIndex: 0, is_clockwise: false });
var cwLinks = undirectedSet(richCw);
var ccwLinks = undirectedSet(richCcw);
var meshDiffers = !setsEqual(cwLinks, ccwLinks);
ok(meshDiffers, 'CW and CCW produce different undirected link sets on the richer fixture (CW ' +
  Object.keys(cwLinks).length + ' vs CCW ' + Object.keys(ccwLinks).length + ')');

// Inbound vs Outbound: undirected set the same, spoke directions flip (when SBUL allows).
var pIn = planOf(engine, small, { startingpointIndex: 0, stardirection: engineMod.CENTRALIZING });
var pOut = planOf(engine, small, { startingpointIndex: 0, stardirection: engineMod.RADIATING, availableSBUL: 2 });
ok(setsEqual(undirectedSet(pIn), undirectedSet(pOut)), 'Inbound and Outbound share the same undirected link set');
ok(!setsEqual(directedSet(pIn), directedSet(pOut)), 'Inbound and Outbound change directed spokes');
var inSpokesFromAnchor = pIn.links.filter(function (lk) { return lk.isFanLink && lk.fromId === pIn.startingpointGUID; }).length;
var inSpokesToAnchor = pIn.links.filter(function (lk) { return lk.isFanLink && lk.toId === pIn.startingpointGUID; }).length;
var outSpokesFromAnchor = pOut.links.filter(function (lk) { return lk.isFanLink && lk.fromId === pOut.startingpointGUID; }).length;
var outSpokesToAnchor = pOut.links.filter(function (lk) { return lk.isFanLink && lk.toId === pOut.startingpointGUID; }).length;
ok(inSpokesToAnchor > 0 && inSpokesFromAnchor === 0, 'Inbound: fan spokes go into the anchor (keys at center)');
ok(outSpokesFromAnchor > 0 && outSpokesToAnchor === 0, 'Outbound: fan spokes go out from the anchor');
ok(pIn.fieldCount === pOut.fieldCount, 'Inbound/Outbound field counts match: ' + pIn.fieldCount);

/* ---------- 2. no crossing links ---------- */
console.log('2. crossing links are never accepted (shared endpoints allowed)');

function assertNoCrossings(plan, label) {
  var links = plan.donelinks || [];
  var crosses = 0;
  for (var i = 0; i < links.length; i++) {
    for (var j = i + 1; j < links.length; j++) {
      var hit = engine.intersects(links[i], links[j]);
      if (hit) crosses++;
    }
  }
  ok(crosses === 0, label + ': no proper crossings among ' + links.length + ' links');
}

assertNoCrossings(p0, 'small CW');
assertNoCrossings(pCcw, 'small CCW');
assertNoCrossings(richCw, 'rich CW');
assertNoCrossings(richCcw, 'rich CCW');

// Shared endpoints must not count as a crossing.
var origin = engine.projectPortal(A);
var pb = engine.projectPortal(B);
var pc = engine.projectPortal(C);
var shared = engine.intersects({ a: origin, b: pb }, { a: origin, b: pc });
ok(shared === false, 'intersects returns false when an endpoint is shared');

/* ---------- 3. 41-portal 步行街 set ---------- */
console.log('3. 41-portal 步行街多重 set');

var points41 = loadBuxingjie();
ok(points41.length === 41, 'fixture has 41 portals, got ' + points41.length);

var hull41 = engine.hullOf(points41);
var hullNames = hull41.map(function (h) { return h.name; });
console.log('  hull (' + hull41.length + '): ' + hullNames.join(' | '));
ok(hull41.length === 3, 'hull has 3 vertices, got ' + hull41.length);

var expectedHull = ['祿位高增', '地王石柱', '亨氏豪庭里的健身器材'];
var missing = expectedHull.filter(function (n) { return hullNames.indexOf(n) === -1; });
ok(missing.length === 0, 'hull vertices are 祿位高增, 地王石柱, 亨氏豪庭里的健身器材');

var plans = [];
for (var hi = 0; hi < hull41.length; hi++) {
  var pl = planOf(engine, points41, { startingpointIndex: hi, is_clockwise: true });
  plans.push(pl);
  var hubDeg = pl.degrees[pl.startingpointGUID] || 0;
  console.log('  anchor[' + hi + '] ' + pl.stations[0].portal.name +
    '  fields=' + pl.fieldCount + ' (valid ' + pl.validTriangleCount + ')' +
    '  links=' + pl.linkCount + ' (valid ' + pl.validLinkCount + ')' +
    '  layers=' + pl.layers +
    '  hubDegree=' + hubDeg +
    '  AP=' + pl.ap +
    '  underFieldInvalid=' + pl.invalidUnderFieldCount);
  ok(pl.ok, 'plan for hull index ' + hi + ' ok');
  ok(pl.portalCount === 41, 'anchor ' + hi + ' portalCount is 41');
  ok(pl.stations[0].portal.name === hullNames[hi], 'anchor ' + hi + ' is ' + hullNames[hi]);
  ok(hubDeg === 40 || hubDeg >= 38, 'anchor ' + hi + ' is a high-degree hub (degree ' + hubDeg + ', expect n-1=40 or close)');
  assertNoCrossings(pl, '41pt anchor ' + hi);
}

var sigs = plans.map(function (pl) {
  return Object.keys(undirectedSet(pl)).sort().join(';');
});
ok(sigs[0] !== sigs[1] && sigs[1] !== sigs[2] && sigs[0] !== sigs[2],
  'cycling startingpointIndex across 3 hull vertices yields 3 distinct link plans');

// Complete fanfield on a triangular cluster: fields 1+3i = 115, links 3n-6 = 117
plans.forEach(function (pl, hi) {
  ok(pl.fieldCount === 115, 'anchor ' + hi + ' field count is 115 (1+3i), got ' + pl.fieldCount);
  ok(pl.linkCount === 117, 'anchor ' + hi + ' link count is 117 (3n-6), got ' + pl.linkCount);
});

// CCW on the 41 set should also be crossing-free and may differ
var p41ccw = planOf(engine, points41, { startingpointIndex: 0, is_clockwise: false });
assertNoCrossings(p41ccw, '41pt CCW');
ok(p41ccw.fieldCount === 115, '41pt CCW still has 115 fields, got ' + p41ccw.fieldCount);
ok(!setsEqual(undirectedSet(plans[0]), undirectedSet(p41ccw)), '41pt CW and CCW produce different undirected link sets');

var p41out = planOf(engine, points41, { startingpointIndex: 0, stardirection: engineMod.RADIATING, availableSBUL: 4 });
ok(setsEqual(undirectedSet(plans[0]), undirectedSet(p41out)), '41pt Outbound keeps the same undirected links');
ok(p41out.centerOutgoings > 0, '41pt Outbound throws from the anchor (centerOutgoings=' + p41out.centerOutgoings + ')');
ok(plans[0].centerOutgoings === 0, '41pt Inbound does not throw from the anchor');

// Outbound + SBUL (same as original FF2): SBUL never changes the undirected links,
// it only caps how many anchor links are thrown outward (8 + SBUL*8).
console.log('\n4. Outbound SBUL 0..4 on the 41 set');
for (var sb = 0; sb <= 4; sb++) {
  var pS = planOf(engine, points41, { startingpointIndex: 0, stardirection: engineMod.RADIATING, availableSBUL: sb });
  var anc = pS.startingpointGUID;
  var outN = pS.links.filter(function (lk) { return lk.fromId === anc; }).length;
  var inN = pS.links.filter(function (lk) { return lk.toId === anc; }).length;
  var expectOut = Math.min(8 + sb * 8, 40);
  ok(setsEqual(undirectedSet(plans[0]), undirectedSet(pS)), 'SBUL ' + sb + ': same undirected links');
  ok(outN === expectOut && pS.centerOutgoings === expectOut, 'SBUL ' + sb + ': anchor throws ' + expectOut + ' outward, got ' + outN);
  ok(inN === 40 - expectOut && pS.centerKeys === 40 - expectOut, 'SBUL ' + sb + ': anchor still needs ' + (40 - expectOut) + ' keys, got ' + inN);
  ok(pS.stations[0].throws.length === outN, 'SBUL ' + sb + ': anchor station throw list matches (' + pS.stations[0].throws.length + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
