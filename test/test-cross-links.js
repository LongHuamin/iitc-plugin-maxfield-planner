#!/usr/bin/env node
'use strict';
var C = require('../src/cross-links');
var passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  ok  ' + m); }
  else { failed++; console.log('  FAIL  ' + m); }
}
function ll(lat, lng) { return { lat: lat, lng: lng }; }

console.log('1. greatCircleArcIntersect');
var cross = C.greatCircleArcIntersect(ll(0, 0), ll(0, 2), ll(-1, 1), ll(1, 1));
ok(cross === true, 'equator and meridian segments cross');
ok(C.greatCircleArcIntersect(ll(-1, 1), ll(1, 1), ll(0, 0), ll(0, 2)) === true, 'crossing is symmetric');

var shared = C.greatCircleArcIntersect(ll(0, 0), ll(0, 2), ll(0, 0), ll(1, 0));
ok(shared === false, 'shared endpoint is not a crossing');
ok(C.greatCircleArcIntersect(ll(0, 2), ll(0, 0), ll(1, 1), ll(0, 0)) === false, 'shared endpoint either end is not a crossing');

var apart = C.greatCircleArcIntersect(ll(0, 0), ll(0, 1), ll(1, 3), ll(1, 4));
ok(apart === false, 'separated segments do not cross');
var parallel = C.greatCircleArcIntersect(ll(0, 0), ll(0, 2), ll(1, 0), ll(1, 2));
ok(parallel === false, 'short non-crossing arcs do not cross');
ok(C.greatCircleArcIntersect(ll(0, 0), ll(0, 0), ll(-1, 1), ll(1, 1)) === false, 'zero-length segment is not a crossing');

console.log('2. highlight the Intel link, not the planned one');
var planLinks = [{ a: ll(0, 0), b: ll(0, 2) }];
var intel = {
  'meet': { guid: 'meet', a: ll(0, 0), b: ll(1, 0) },
  'crosser': { options: { guid: 'crosser' }, getLatLngs: function () { return [ll(-1, 1), ll(1, 1)]; } },
  'away': { guid: 'away', latLngs: [ll(3, 3), ll(3, 4)] }
};
var hits = C.crossedIntelLinks(planLinks, intel);
ok(hits.length === 1 && hits[0].guid === 'crosser', 'only the crossing Intel link is returned: ' + hits.map(function (h) { return h.guid; }).join(','));
ok(hits[0].latlngs[0].lat === -1 && hits[0].latlngs[1].lng === 1, 'returned geometry is the Intel link');

console.log('3. Cross Links layer checkbox');
var crossLayer = { id: 'official' };
var otherLayer = { id: 'other' };
function mapWith(on) {
  return { hasLayer: function (layer) { return on && layer === crossLayer; } };
}
var chooser = { _layers: [
  { name: 'Links', overlay: true, layer: otherLayer },
  { name: 'Cross Links', overlay: true, layer: crossLayer }
] };
ok(C.isCrossLinksLayerOn(mapWith(true), chooser) === true, 'checked Cross Links layer is on');
ok(C.isCrossLinksLayerOn(mapWith(false), chooser) === false, 'unchecked Cross Links layer is off');
ok(C.isCrossLinksLayerOn(mapWith(true), { _layers: [{ name: 'Links', layer: otherLayer }] }) === false, 'missing Cross Links plugin shows nothing');
ok(C.isCrossLinksLayerOn(null, chooser) === false, 'no map is off');
ok(C.isCrossLinksToggleEvent({ name: 'Cross Links', layer: crossLayer }, chooser) === true, 'overlayadd by name is our toggle');
ok(C.isCrossLinksToggleEvent({ name: 'Links', layer: otherLayer }, chooser) === false, 'another overlay is ignored');
ok(C.isCrossLinksToggleEvent({ layer: crossLayer }, chooser) === true, 'layeradd of the official layer is our toggle');
ok(C.CROSS_LINKS_LAYER_NAME === 'Cross Links', 'layer label is Cross Links');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
