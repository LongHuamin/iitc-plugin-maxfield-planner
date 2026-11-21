/* Planning engine derived from Fan Fields 2 2.8.4.20260912 by Heistergand.
 *
 * Copyright © 2018-2025 IITC plugin: Fan Fields 2
 * Copyright © 2018 Justus Kenklies
 * Licensed under the ISC License. See vendor/fanfields2/LICENSE.
 *
 * This is a close port of the original updateLayer / helpers. The control
 * flow, metrics, sort, rotate, intersection tests, getThirds2, and donelinks
 * splice insertion are kept as written. Input is a selected portal list
 * instead of a DrawTools polygon + Intel bookmarks. Respect Intel defaults
 * OFF so a clean plan is pure geometry.
 */
(function (root, factory) {
  var geo = null;
  if (typeof module === 'object' && module.exports) {
    try { geo = require('./geo'); } catch (e) { geo = null; }
    module.exports = factory(geo);
  } else {
    geo = root.FanFields2Geo || null;
    root.FanFields2Engine = factory(geo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (geo) {
  'use strict';

  var AP_LINK = 313;
  var AP_FIELD = 1250;

  var STAR_DIR = {
    CENTRALIZING: -1,
    RADIATING: 1
  };

  function resolveEnv(options) {
    options = options || {};
    if (options.map && options.L) return { map: options.map, L: options.L };
    if (typeof window !== 'undefined' && window.map && window.L) {
      return { map: window.map, L: window.L };
    }
    if (geo && typeof geo.createEnv === 'function') return geo.createEnv();
    throw new Error('FanFields2Engine: no Leaflet map environment available');
  }

  function computeFanMaxLayers(fields) {
    if (!fields || !fields.length) return 0;
    function orient(a, b, c) {
      var v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(v) < 1e-16) return 0;
      return v > 0 ? 1 : -1;
    }
    function pointInTriangle(p, a, b, c) {
      var d1 = orient(a, b, p);
      var d2 = orient(b, c, p);
      var d3 = orient(c, a, p);
      var hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      var hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(hasNeg && hasPos);
    }
    var max = 1;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var c = { x: (f.a.x + f.b.x + f.c.x) / 3, y: (f.a.y + f.b.y + f.c.y) / 3 };
      var depth = 1;
      for (var j = 0; j < fields.length; j++) {
        if (i === j) continue;
        var g = fields[j];
        if (pointInTriangle(c, g.a, g.b, g.c)) depth += 1;
      }
      f.depth = depth;
      if (depth > max) max = depth;
    }
    return max;
  }

  function haversineMeters(a, b) {
    var rad = Math.PI / 180;
    var lat1 = a.lat * rad;
    var lat2 = b.lat * rad;
    var sinDLat = Math.sin((b.lat - a.lat) * rad / 2);
    var sinDLon = Math.sin((b.lng - a.lng) * rad / 2);
    var h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    var c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return 6371000 * c;
  }

  function createEngine(envOptions) {
    var env = resolveEnv(envOptions);
    var map = env.map;
    var L = env.L;
    var thisplugin = {};

    thisplugin.PROJECT_ZOOM = 16;
    thisplugin.DEG_TO_RAD = Math.PI / 180;
    thisplugin.RAD_TO_DEG = 180 / Math.PI;
    thisplugin.starDirENUM = STAR_DIR;
    thisplugin.stardirection = STAR_DIR.CENTRALIZING;
    thisplugin.is_clockwise = true;
    thisplugin.availableSBUL = 2;
    thisplugin.startingpointIndex = 0;
    thisplugin.manualLinkFlips = {};
    thisplugin.manualOrderGuids = null;
    thisplugin.respectIntel = false;
    thisplugin.existingIntelPlanLinks = [];
    thisplugin.intelMaplinks = [];
    thisplugin.maxLinkUnderFieldDistance = 2000;
    thisplugin.invalidUnderFieldLinks = {};
    thisplugin.validTriangles = null;
    thisplugin.validLinkCount = 0;
    thisplugin.validTriangleCount = 0;
    thisplugin.showUnderFieldWarningOnce = false;
    thisplugin.centerKeys = 0;
    thisplugin.n = 0;
    thisplugin.triangles = [];
    thisplugin.donelinks = [];
    thisplugin.sortedFanpoints = [];
    thisplugin.fanpoints = {};
    thisplugin.perimeterpoints = [];
    thisplugin.portalMeta = {};

    thisplugin.initLatLng = function () {
      if (!L || !L.LatLng || !L.LatLng.prototype) return;
      if (typeof L.LatLng.prototype.bearingToE6 === 'function') return;
      L.LatLng.prototype.bearingToE6 = function (other) {
        var d2r = thisplugin.DEG_TO_RAD;
        var r2d = thisplugin.RAD_TO_DEG;
        var lat1 = this.lat * d2r;
        var lat2 = other.lat * d2r;
        var dLon = (other.lng - this.lng) * d2r;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brng = Math.atan2(y, x);
        brng = parseInt(brng * r2d * 1E6, 10);
        brng = ((brng + 360 * 1E6) % (360 * 1E6) / 1E6);
        return brng;
      };
    };

    thisplugin.initLatLng();

    thisplugin.isRespectingIntel = function () {
      return !!thisplugin.respectIntel;
    };

    thisplugin.getThirds2 = function (listA, listB, a, b) {
      var neighA = {};
      var neighB = {};
      var result = [];

      function key(p) {
        return p.x + ',' + p.y;
      }

      function considerLink(l) {
        if ((l.a.equals(a) && l.b.equals(b)) || (l.a.equals(b) && l.b.equals(a))) {
          return;
        }
        if (l.a.equals(a)) neighA[key(l.b)] = l.b;
        else if (l.b.equals(a)) neighA[key(l.a)] = l.a;
        if (l.a.equals(b)) neighB[key(l.b)] = l.b;
        else if (l.b.equals(b)) neighB[key(l.a)] = l.a;
      }

      for (var i = 0; i < listA.length; i++) considerLink(listA[i]);
      for (var j = 0; j < listB.length; j++) considerLink(listB[j]);

      for (var k in neighA) {
        if (Object.prototype.hasOwnProperty.call(neighA, k) && neighB[k]) {
          result.push(neighA[k]);
        }
      }
      return result;
    };

    thisplugin.linkExists = function (list, link) {
      var i, result = false;
      for (i in list) {
        if (thisplugin.linksEqual(list[i], link)) {
          result = true;
          break;
        }
      }
      return result;
    };

    thisplugin.linksEqual = function (link1, link2) {
      var Aa, Ab, Ba, Bb;
      Aa = link1.a.equals(link2.a);
      Ab = link1.a.equals(link2.b);
      Ba = link1.b.equals(link2.a);
      Bb = link1.b.equals(link2.b);
      if ((Aa || Ab) && (Ba || Bb)) {
        return true;
      }
    };

    thisplugin.intersects = function (link1, link2) {
      var x1, y1, x2, y2, x3, y3, x4, y4;
      x1 = link1.a.x;
      y1 = link1.a.y;
      x2 = link1.b.x;
      y2 = link1.b.y;
      x3 = link2.a.x;
      y3 = link2.a.y;
      x4 = link2.b.x;
      y4 = link2.b.y;

      var Aa, Ab, Ba, Bb;
      Aa = link1.a.equals(link2.a);
      Ab = link1.a.equals(link2.b);
      Ba = link1.b.equals(link2.a);
      Bb = link1.b.equals(link2.b);

      if (Aa || Ab || Ba || Bb) {
        return false;
      }

      function sameSign(n1, n2) {
        if (n1 * n2 > 0) {
          return true;
        } else {
          return false;
        }
      }

      var a1, a2, b1, b2, c1, c2;
      var r1, r2, r3, r4;
      var denom, offset, num;

      a1 = y2 - y1;
      b1 = x1 - x2;
      c1 = (x2 * y1) - (x1 * y2);

      r3 = ((a1 * x3) + (b1 * y3) + c1);
      r4 = ((a1 * x4) + (b1 * y4) + c1);

      if ((r3 !== 0) && (r4 !== 0) && (sameSign(r3, r4))) {
        return 0;
      }

      a2 = y4 - y3;
      b2 = x3 - x4;
      c2 = (x4 * y3) - (x3 * y4);

      r1 = (a2 * x1) + (b2 * y1) + c2;
      r2 = (a2 * x2) + (b2 * y2) + c2;

      if ((r1 !== 0) && (r2 !== 0) && (sameSign(r1, r2))) {
        return 0;
      }

      denom = (a1 * b2) - (a2 * b1);

      if (denom === 0) {
        return 1;
      }
      return 1;
    };

    thisplugin.getBearing = function (a, b) {
      var starting_ll, other_ll;
      starting_ll = map.unproject(a, thisplugin.PROJECT_ZOOM);
      other_ll = map.unproject(b, thisplugin.PROJECT_ZOOM);
      return starting_ll.bearingToE6(other_ll);
    };

    thisplugin.distanceTo = function (a, b) {
      var starting_ll, other_ll;
      starting_ll = map.unproject(a, thisplugin.PROJECT_ZOOM);
      other_ll = map.unproject(b, thisplugin.PROJECT_ZOOM);
      return starting_ll.distanceTo(other_ll);
    };

    thisplugin.pointKey = function (p) {
      return p.x + ',' + p.y;
    };

    thisplugin.getDirectedLinkKey = function (guidA, guidB) {
      return guidA + '>' + guidB;
    };

    thisplugin.getUndirectedLinkKey = function (guidA, guidB) {
      return (guidA < guidB) ? (guidA + '|' + guidB) : (guidB + '|' + guidA);
    };

    thisplugin.isLinkFlipped = function (guidA, guidB) {
      return !!thisplugin.manualLinkFlips[thisplugin.getUndirectedLinkKey(guidA, guidB)];
    };

    thisplugin.pointInTriangleStrict = function (p, a, b, c) {
      var eps = 1e-9;

      function sign(p1, p2, p3) {
        return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
      }

      var d1 = sign(p, a, b);
      var d2 = sign(p, b, c);
      var d3 = sign(p, c, a);

      if (Math.abs(d1) < eps || Math.abs(d2) < eps || Math.abs(d3) < eps) return false;

      var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

      return !(hasNeg && hasPos);
    };

    thisplugin.isPointUnderAnyTriangle = function (p, triangles) {
      if (!triangles || triangles.length === 0) return false;
      for (var i = 0; i < triangles.length; i++) {
        var t = triangles[i];
        if (thisplugin.pointInTriangleStrict(p, t.a, t.b, t.c)) return true;
      }
      return false;
    };

    thisplugin.validateUnderFieldLinks = function () {
      var sorted = thisplugin.sortedFanpoints || [];
      if (sorted.length < 3) {
        thisplugin.invalidUnderFieldLinks = {};
        thisplugin.validTriangles = null;
        thisplugin.validLinkCount = 0;
        thisplugin.validTriangleCount = 0;
        return;
      }

      thisplugin.invalidUnderFieldLinks = {};
      thisplugin.validTriangles = [];
      thisplugin.validLinkCount = 0;
      thisplugin.validTriangleCount = 0;

      var pointToGuid = {};
      for (var i = 0; i < sorted.length; i++) {
        pointToGuid[thisplugin.pointKey(sorted[i].point)] = sorted[i].guid;
      }

      var builtLinks = {};
      var existingIntelPlanLinks = thisplugin.existingIntelPlanLinks || [];
      for (var ei = 0; ei < existingIntelPlanLinks.length; ei++) {
        var existingLink = existingIntelPlanLinks[ei];
        var existingGuidA = existingLink.guidA || pointToGuid[thisplugin.pointKey(existingLink.a)];
        var existingGuidB = existingLink.guidB || pointToGuid[thisplugin.pointKey(existingLink.b)];
        if (existingGuidA && existingGuidB) {
          builtLinks[thisplugin.getUndirectedLinkKey(existingGuidA, existingGuidB)] = true;
        }
      }

      var portalUnderFieldAtVisit = {};
      var validFieldsByDirectedLink = {};

      for (var pi = 0; pi < sorted.length; pi++) {
        sorted[pi].incomingValidCount = 0;
        sorted[pi].outgoingValidCount = 0;
        sorted[pi].fieldsCreatedValidAtPortal = 0;
      }

      function addInvalid(srcGuid, dstGuid, distance, flippedOk) {
        var dkey = thisplugin.getDirectedLinkKey(srcGuid, dstGuid);
        thisplugin.invalidUnderFieldLinks[dkey] = {
          srcGuid: srcGuid,
          dstGuid: dstGuid,
          distance: distance,
          flippedOk: flippedOk
        };
      }

      for (var vi = 0; vi < sorted.length; vi++) {
        var srcFp = sorted[vi];
        var srcGuid = srcFp.guid;

        portalUnderFieldAtVisit[srcGuid] = thisplugin.isPointUnderAnyTriangle(srcFp.point, thisplugin.validTriangles);

        if (!srcFp.outgoing || srcFp.outgoing.length === 0) continue;

        for (var oi = 0; oi < srcFp.outgoing.length; oi++) {
          var dstFp = srcFp.outgoing[oi];
          var dstGuid = dstFp.guid;

          var distance = thisplugin.distanceTo(srcFp.point, dstFp.point);
          var srcUnder = portalUnderFieldAtVisit[srcGuid];
          var invalid = srcUnder && distance > thisplugin.maxLinkUnderFieldDistance;

          var meta = (srcFp.outgoingMeta && srcFp.outgoingMeta[dstGuid]) ? srcFp.outgoingMeta[dstGuid] : null;

          var dstUnderAtVisit = portalUnderFieldAtVisit[dstGuid];
          if (dstUnderAtVisit === undefined) {
            dstUnderAtVisit = null;
          }
          var flippedOk = (dstUnderAtVisit === null) ? null : (!(dstUnderAtVisit && distance > thisplugin.maxLinkUnderFieldDistance));

          if (invalid) {
            addInvalid(srcGuid, dstGuid, distance, flippedOk);
            if (meta) {
              meta.invalidUnderField = true;
              meta.canFlipUnderField = flippedOk;
              meta.fieldsCreatedValid = 0;
            }
            continue;
          }

          thisplugin.validLinkCount++;
          srcFp.outgoingValidCount++;
          dstFp.incomingValidCount++;

          builtLinks[thisplugin.getUndirectedLinkKey(srcGuid, dstGuid)] = true;

          var fieldsCreatedByThisLink = 0;

          if (meta && meta.creatingFieldsWith && meta.creatingFieldsWith.length) {
            for (var ti = 0; ti < meta.creatingFieldsWith.length; ti++) {
              var thirdPoint = meta.creatingFieldsWith[ti];
              var thirdGuid = pointToGuid[thisplugin.pointKey(thirdPoint)];
              if (!thirdGuid) continue;

              var e1 = thisplugin.getUndirectedLinkKey(srcGuid, thirdGuid);
              var e2 = thisplugin.getUndirectedLinkKey(dstGuid, thirdGuid);

              if (!builtLinks[e1] || !builtLinks[e2]) {
                continue;
              }

              thisplugin.validTriangles.push({
                a: thirdPoint,
                b: srcFp.point,
                c: dstFp.point
              });
              fieldsCreatedByThisLink++;
            }
          }

          validFieldsByDirectedLink[thisplugin.getDirectedLinkKey(srcGuid, dstGuid)] = fieldsCreatedByThisLink;
          if (meta) meta.fieldsCreatedValid = fieldsCreatedByThisLink;

          srcFp.fieldsCreatedValidAtPortal += fieldsCreatedByThisLink;
        }
      }

      for (var k in thisplugin.invalidUnderFieldLinks) {
        if (!Object.prototype.hasOwnProperty.call(thisplugin.invalidUnderFieldLinks, k)) continue;
        var rec = thisplugin.invalidUnderFieldLinks[k];
        if (rec.flippedOk !== null) continue;

        var dstUnder = !!portalUnderFieldAtVisit[rec.dstGuid];
        rec.flippedOk = !(dstUnder && rec.distance > thisplugin.maxLinkUnderFieldDistance);

        var src = sorted.find(function (fp) { return fp.guid === rec.srcGuid; });
        if (src && src.outgoingMeta && src.outgoingMeta[rec.dstGuid]) {
          src.outgoingMeta[rec.dstGuid].canFlipUnderField = rec.flippedOk;
        }
      }

      thisplugin.validTriangleCount = thisplugin.validTriangles.length;
    };

    function convexHull(points) {
      function cross(a, b, o) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      }

      var pa = Object.entries(points)
        .map(function (p) { return [p[0], p[1]]; });

      pa.sort(function (a, b) {
        return a[1].x === b[1].x ? a[1].y - b[1].y : a[1].x - b[1].x;
      });

      var lower = [];
      var i;
      for (i = 0; i < pa.length; i++) {
        while (lower.length >= 2 && cross(lower[lower.length - 2][1], lower[lower.length - 1][1], pa[i][1]) <= 0) {
          lower.pop();
        }
        lower.push(pa[i]);
      }

      var upper = [];
      for (i = pa.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2][1], upper[upper.length - 1][1], pa[i][1]) <= 0) {
          upper.pop();
        }
        upper.push(pa[i]);
      }

      upper.pop();
      lower.pop();
      return lower.concat(upper);
    }

    function extendperimeter(perimeter, GUID, point) {
      var i;
      var done = false;
      if (GUID !== undefined) {
        for (i = 0; i < perimeter.length; i++) {
          if (perimeter[i] === GUID) {
            done = true;
            break;
          }
          if (done) break;
        }
        if (!done) {
          perimeter.unshift([GUID, [point.x, point.y]]);
        }
      }
      return perimeter;
    }

    thisplugin.convexHull = convexHull;
    thisplugin.extendperimeter = extendperimeter;

    thisplugin.projectPortal = function (portal) {
      var ll = L.latLng(portal.lat, portal.lng);
      return map.project(ll, thisplugin.PROJECT_ZOOM);
    };

    // Core of original updateLayer, from fanpoints onward. Drawing and
    // DrawTools / Intel collection are omitted; Respect Intel stays off
    // unless the caller provides map links.
    thisplugin.plan = function (input) {
      input = input || {};
      var portals = input.portals || [];
      if (portals.length < 3) {
        return { ok: false, error: 'need-3', portals: portals.length };
      }

      var a, b, c;
      var fanlinks = [],
        donelinks = [],
        maplinks = [];
      var triangles = [];
      var n = 0;
      var centerOutgoings = 0;
      var centerSbul = 0;
      var pa, i, pb, k, ll, p;
      var guid;
      var intersection;
      var fp, bearing, sublinkCount;

      thisplugin.stardirection = (input.stardirection === STAR_DIR.RADIATING)
        ? STAR_DIR.RADIATING
        : STAR_DIR.CENTRALIZING;
      thisplugin.is_clockwise = input.is_clockwise !== false;
      thisplugin.availableSBUL = (input.availableSBUL == null) ? 2 : input.availableSBUL;
      thisplugin.startingpointIndex = input.startingpointIndex || 0;
      thisplugin.manualLinkFlips = input.manualLinkFlips || {};
      thisplugin.manualOrderGuids = input.manualOrderGuids || null;
      thisplugin.respectIntel = !!input.respectIntel;
      thisplugin.existingIntelPlanLinks = input.existingIntelPlanLinks || [];
      thisplugin.intelMaplinks = input.maplinks || [];
      thisplugin.startingpoint = undefined;
      thisplugin.startingpointGUID = '';
      thisplugin.startingMarker = input.startingMarker || undefined;
      thisplugin.startingMarkerGUID = input.startingMarkerGUID || undefined;
      thisplugin.centerKeys = 0;
      thisplugin.portalMeta = {};
      thisplugin.fanpoints = {};
      thisplugin.sortedFanpoints = [];
      thisplugin.links = [];

      for (i = 0; i < portals.length; i++) {
        var pr = portals[i];
        guid = pr.guid || pr.id;
        if (!guid) continue;
        thisplugin.fanpoints[guid] = thisplugin.projectPortal(pr);
        thisplugin.portalMeta[guid] = {
          guid: guid,
          id: guid,
          lat: pr.lat,
          lng: pr.lng,
          name: pr.name || pr.label || guid
        };
      }

      var fanpointGuids = Object.keys(thisplugin.fanpoints);
      var npoints = fanpointGuids.length;
      if (npoints < 3) {
        return { ok: false, error: 'need-3', portals: npoints };
      }

      var maplinksAll = null;
      if (thisplugin.isRespectingIntel()) {
        maplinksAll = thisplugin.intelMaplinks || [];
      }

      thisplugin.perimeterpoints = convexHull(thisplugin.fanpoints);

      if (thisplugin.startingMarker !== undefined && thisplugin.startingMarkerGUID) {
        if (thisplugin.startingMarkerGUID in thisplugin.fanpoints) {
          thisplugin.fanpoints[thisplugin.startingMarkerGUID] = thisplugin.startingMarker;
        }
        thisplugin.perimeterpoints = extendperimeter(
          thisplugin.perimeterpoints,
          thisplugin.startingMarkerGUID,
          thisplugin.startingMarker
        );
      }

      if (thisplugin.startingpointIndex >= thisplugin.perimeterpoints.length) {
        thisplugin.startingpointIndex = 0;
      }
      if (thisplugin.startingpointIndex < 0) {
        thisplugin.startingpointIndex = 0;
      }

      if (thisplugin.perimeterpoints.length !== 0) {
        thisplugin.startingpointGUID = thisplugin.perimeterpoints[thisplugin.startingpointIndex][0];
        thisplugin.startingpoint = thisplugin.fanpoints[thisplugin.startingpointGUID];

        for (guid in thisplugin.fanpoints) {
          n++;
          if (thisplugin.fanpoints[guid].equals(thisplugin.startingpoint)) {
            continue;
          } else {
            a = thisplugin.fanpoints[guid];
            b = thisplugin.startingpoint;

            fanlinks.push({
              a: a,
              b: b,
              bearing: undefined,
              isJetLink: undefined,
              isFanLink: undefined,
              distance: thisplugin.distanceTo(a, b)
            });
          }
        }

        for (guid in thisplugin.fanpoints) {
          fp = thisplugin.fanpoints[guid];
          thisplugin.sortedFanpoints.push({
            point: fp,
            portal: thisplugin.portalMeta[guid],
            bearing: thisplugin.getBearing(thisplugin.startingpoint, fp),
            guid: guid,
            incoming: [],
            outgoing: [],
            outgoingMeta: {},
            is_startpoint: thisplugin.fanpoints[guid].equals(thisplugin.startingpoint)
          });
        }
        thisplugin.sortedFanpoints.sort(function (a, b) {
          return a.bearing - b.bearing;
        });
      }

      var currentBearing, lastBearing;
      var gaps = [];
      var gap, lastGap, maxGap, maxGapIndex, maxGapBearing;
      for (i in thisplugin.sortedFanpoints) {
        if (lastBearing === undefined) {
          lastBearing = thisplugin.sortedFanpoints[thisplugin.sortedFanpoints.length - 1].bearing;
          gap = 0;
          lastGap = 0;
          maxGap = 0;
          maxGapIndex = 0;
          maxGapBearing = 0;
        }
        currentBearing = thisplugin.sortedFanpoints[i].bearing;
        gap = lastBearing - currentBearing;
        if (gap < 0) gap *= -1;
        if (gap >= 180) gap = 360 - gap;

        if (gap > maxGap) {
          maxGap = gap;
          maxGapIndex = i;
          maxGapBearing = currentBearing;
        }
        lastBearing = currentBearing;
        lastGap = gap;
      }

      thisplugin.sortedFanpoints = thisplugin.sortedFanpoints.concat(thisplugin.sortedFanpoints.splice(1, maxGapIndex - 1));
      if (!thisplugin.is_clockwise) {
        thisplugin.sortedFanpoints = thisplugin.sortedFanpoints.concat(thisplugin.sortedFanpoints.splice(1, thisplugin.sortedFanpoints.length - 1)
          .reverse());
      }

      if (thisplugin.manualOrderGuids &&
        thisplugin.manualOrderGuids.length === thisplugin.sortedFanpoints.length) {

        var byGuid = {};
        thisplugin.sortedFanpoints.forEach(function (fp) {
          byGuid[fp.guid] = fp;
        });

        var newOrder = [];
        var allPresent = true;

        thisplugin.manualOrderGuids.forEach(function (g) {
          if (byGuid[g]) {
            newOrder.push(byGuid[g]);
          } else {
            allPresent = false;
          }
        });

        if (allPresent &&
          newOrder.length === thisplugin.sortedFanpoints.length &&
          newOrder[0].guid === thisplugin.startingpointGUID) {
          thisplugin.sortedFanpoints = newOrder;
        }
      }

      donelinks = [];
      var outbound = 0;
      var possibleline;

      for (pa = 0; pa < thisplugin.sortedFanpoints.length; pa++) {
        bearing = thisplugin.sortedFanpoints[pa].bearing;
        sublinkCount = 0;

        var newPoint = thisplugin.sortedFanpoints[pa].point;
        var anchorPoint = thisplugin.sortedFanpoints[0].point;

        var candidates = [];
        for (pb = 0; pb < pa; pb++) {
          var candPoint = thisplugin.sortedFanpoints[pb].point;

          var d = thisplugin.distanceTo(newPoint, candPoint);
          d += thisplugin.distanceTo(anchorPoint, candPoint);
          var metric;
          if (pb === 0) {
            metric = Infinity;
          } else {
            metric = thisplugin.distanceTo(newPoint, candPoint);
            metric += thisplugin.distanceTo(anchorPoint, candPoint);
          }
          candidates.push({
            pbIndex: pb,
            isAnchor: (pb === 0),
            metric: metric
          });
        }

        candidates.sort(function (u, v) {
          return v.metric - u.metric;
        });

        var paFp = thisplugin.sortedFanpoints[pa];
        var paPoint = paFp.point;

        for (var ci = 0; ci < candidates.length; ci++) {
          pb = candidates[ci].pbIndex;
          outbound = 0;

          a = paPoint;
          b = thisplugin.sortedFanpoints[pb].point;
          bearing = thisplugin.getBearing(a, b);
          const distance = thisplugin.distanceTo(a, b);

          var flipped = thisplugin.isLinkFlipped(thisplugin.sortedFanpoints[pa].guid, thisplugin.sortedFanpoints[pb].guid);

          if (pb === 0) {
            var maxLinks = 8 + thisplugin.availableSBUL * 8;
            var wantOutbound = (thisplugin.stardirection === thisplugin.starDirENUM.RADIATING) || flipped;
            if (wantOutbound && centerOutgoings < maxLinks) {
              outbound = 1;
            } else {
              thisplugin.centerKeys++;
            }

            if (outbound === 1) {
              a = thisplugin.sortedFanpoints[pb].point;
              b = thisplugin.sortedFanpoints[pa].point;
              centerOutgoings++;
            }
          } else if (flipped) {
            a = thisplugin.sortedFanpoints[pb].point;
            b = paPoint;
          }

          var swapped = (pb === 0) ? (outbound === 1) : flipped;

          possibleline = {
            a: a,
            b: b,
            guidA: swapped ? thisplugin.sortedFanpoints[pb].guid : thisplugin.sortedFanpoints[pa].guid,
            guidB: swapped ? thisplugin.sortedFanpoints[pa].guid : thisplugin.sortedFanpoints[pb].guid,
            bearing: bearing,
            isJetLink: false,
            isFanLink: (pb === 0),
            creatingFieldsWith: [],
            counts: true,
            distance: distance
          };
          intersection = 0;
          maplinks = maplinksAll;

          if (thisplugin.isRespectingIntel()) {
            for (i in maplinks) {
              if (thisplugin.intersects(possibleline, maplinks[i])) {
                intersection++;
                if (possibleline.isFanLink && outbound === 1) centerOutgoings--;
                break;
              }
            }
            var existsAsBlockingIntelLink = thisplugin.linkExists(maplinks, possibleline);
            var existsAsOwnIntelLink = thisplugin.linkExists(thisplugin.existingIntelPlanLinks, possibleline);
            if (intersection === 0 && (existsAsBlockingIntelLink || existsAsOwnIntelLink)) {
              possibleline.counts = false;
              if (possibleline.isFanLink && outbound === 1) {
                centerOutgoings--;
              } else if (possibleline.isFanLink) {
                thisplugin.centerKeys--;
              }
            }
          }
          if (intersection === 0) {
            for (i in donelinks) {
              if (thisplugin.intersects(possibleline, donelinks[i])) {
                intersection++;
                if (possibleline.isFanLink && outbound === 1) centerOutgoings--;
                break;
              }
            }
          }
          if (intersection === 0) {
            for (i in fanlinks) {
              if (thisplugin.intersects(possibleline, fanlinks[i])) {
                intersection++;
                if (possibleline.isFanLink && outbound === 1) centerOutgoings--;
                break;
              }
            }
          }

          if (centerOutgoings > 8 && centerOutgoings < maxLinks) {
            centerSbul = Math.ceil((centerOutgoings - 8) / 8);
          }

          if (intersection === 0) {
            var thirds = [];
            if (thisplugin.isRespectingIntel()) {
              if (possibleline.counts) {
                thirds = thisplugin.getThirds2(donelinks, thisplugin.existingIntelPlanLinks, possibleline.a, possibleline.b);
              }
            } else {
              thirds = thisplugin.getThirds2(donelinks, [], possibleline.a, possibleline.b);
            }

            if (thirds.length === 2) {
              possibleline.isJetLink = true;
            }

            possibleline.creatingFieldsWith = thirds;

            let field = {};
            for (var t in thirds) {
              field = {
                a: thirds[t],
                b: possibleline.a,
                c: possibleline.b
              };
              triangles.push(field);
            }

            if (possibleline.counts) {
              donelinks.splice(donelinks.length - (thisplugin.sortedFanpoints.length - pa), 0, possibleline);
              if (swapped) {
                thisplugin.sortedFanpoints[pb].outgoing.push(thisplugin.sortedFanpoints[pa]);
                thisplugin.sortedFanpoints[pa].incoming.push(thisplugin.sortedFanpoints[pb]);

                thisplugin.sortedFanpoints[pb].outgoingMeta[thisplugin.sortedFanpoints[pa].guid] = {
                  creatingFieldsWith: possibleline.creatingFieldsWith
                };
              } else {
                thisplugin.sortedFanpoints[pa].outgoing.push(thisplugin.sortedFanpoints[pb]);
                thisplugin.sortedFanpoints[pb].incoming.push(thisplugin.sortedFanpoints[pa]);

                thisplugin.sortedFanpoints[pa].outgoingMeta[thisplugin.sortedFanpoints[pb].guid] = {
                  creatingFieldsWith: possibleline.creatingFieldsWith
                };
              }
            }
          }
        }
      }

      thisplugin.links = [];
      for (i = 0; i < donelinks.length; i++) {
        thisplugin.links[i] = donelinks[i];
      }

      thisplugin.triangles = triangles;
      thisplugin.donelinks = donelinks;
      thisplugin.n = n;
      thisplugin.centerOutgoings = centerOutgoings;
      thisplugin.centerSbul = centerSbul;

      thisplugin.validateUnderFieldLinks();

      return thisplugin.buildResult();
    };

    thisplugin.buildResult = function () {
      var sorted = thisplugin.sortedFanpoints || [];
      var donelinks = thisplugin.donelinks || [];
      var triangles = thisplugin.triangles || [];
      var layers = computeFanMaxLayers(triangles);

      var hull = (thisplugin.perimeterpoints || []).map(function (item) {
        var guid = item[0];
        var meta = thisplugin.portalMeta[guid] || {};
        return {
          guid: guid,
          name: meta.name || guid,
          lat: meta.lat,
          lng: meta.lng
        };
      });

      var stations = sorted.map(function (fp, index) {
        var meta = thisplugin.portalMeta[fp.guid] || {};
        var throws = [];
        var outgoing = fp.outgoing || [];
        for (var oi = 0; oi < outgoing.length; oi++) {
          var dst = outgoing[oi];
          var dstMeta = thisplugin.portalMeta[dst.guid] || {};
          var m = (fp.outgoingMeta && fp.outgoingMeta[dst.guid]) || {};
          var fieldsCreated = (m.creatingFieldsWith && m.creatingFieldsWith.length) || 0;
          var dirKey = thisplugin.getDirectedLinkKey(fp.guid, dst.guid);
          var invalid = !!(thisplugin.invalidUnderFieldLinks && thisplugin.invalidUnderFieldLinks[dirKey]);
          throws.push({
            fromId: fp.guid,
            fromName: meta.name || fp.guid,
            toId: dst.guid,
            toName: dstMeta.name || dst.guid,
            fields: fieldsCreated,
            fieldsValid: (m.fieldsCreatedValid != null) ? m.fieldsCreatedValid : fieldsCreated,
            invalidUnderField: invalid,
            isFanLink: !!(m && false) || false,
            distance: thisplugin.distanceTo(fp.point, dst.point)
          });
        }
        return {
          index: index,
          isStart: !!fp.is_startpoint || fp.guid === thisplugin.startingpointGUID,
          portal: {
            id: fp.guid,
            guid: fp.guid,
            name: meta.name || fp.guid,
            lat: meta.lat,
            lng: meta.lng
          },
          incomingCount: (fp.incoming && fp.incoming.length) || 0,
          incomingValidCount: (fp.incomingValidCount != null) ? fp.incomingValidCount : ((fp.incoming && fp.incoming.length) || 0),
          outgoingCount: outgoing.length,
          outgoingValidCount: (fp.outgoingValidCount != null) ? fp.outgoingValidCount : outgoing.length,
          throws: throws
        };
      });

      var walkMeters = 0;
      for (var w = 1; w < stations.length; w++) {
        walkMeters += haversineMeters(stations[w - 1].portal, stations[w].portal);
      }

      function withLatLng(pt) {
        if (!pt) return pt;
        if (pt.lat != null && pt.lng != null) return pt;
        var ll = map.unproject(pt, thisplugin.PROJECT_ZOOM);
        return { x: pt.x, y: pt.y, lat: ll.lat, lng: ll.lng };
      }

      var links = donelinks.map(function (link) {
        var dirKey = (link.guidA && link.guidB) ? thisplugin.getDirectedLinkKey(link.guidA, link.guidB) : null;
        var invalid = !!(dirKey && thisplugin.invalidUnderFieldLinks && thisplugin.invalidUnderFieldLinks[dirKey]);
        var metaA = thisplugin.portalMeta[link.guidA] || {};
        var metaB = thisplugin.portalMeta[link.guidB] || {};
        return {
          fromId: link.guidA,
          toId: link.guidB,
          fromName: metaA.name || link.guidA,
          toName: metaB.name || link.guidB,
          isFanLink: !!link.isFanLink,
          isJetLink: !!link.isJetLink,
          fields: (link.creatingFieldsWith && link.creatingFieldsWith.length) || 0,
          invalidUnderField: invalid,
          distance: link.distance,
          a: withLatLng(link.a),
          b: withLatLng(link.b)
        };
      });

      var fields = triangles.map(function (t) {
        return { a: withLatLng(t.a), b: withLatLng(t.b), c: withLatLng(t.c), depth: t.depth || 1 };
      });

      var totalLinks = donelinks.length;
      var totalFields = triangles.length;
      var validLinks = (thisplugin.validLinkCount !== undefined) ? thisplugin.validLinkCount : totalLinks;
      var validFields = (thisplugin.validTriangleCount !== undefined) ? thisplugin.validTriangleCount : totalFields;
      var countsDiffer = (validLinks !== totalLinks) || (validFields !== totalFields);
      var buildAp = validLinks * AP_LINK + validFields * AP_FIELD;
      var rawAp = totalLinks * AP_LINK + totalFields * AP_FIELD;

      var keyList = stations
        .filter(function (st) { return st.incomingCount > 0; })
        .map(function (st) {
          return { id: st.portal.guid, name: st.portal.name, count: st.incomingCount, validCount: st.incomingValidCount };
        })
        .sort(function (a, b) { return b.count - a.count; });

      var degrees = {};
      links.forEach(function (lk) {
        degrees[lk.fromId] = (degrees[lk.fromId] || 0) + 1;
        degrees[lk.toId] = (degrees[lk.toId] || 0) + 1;
      });

      return {
        ok: true,
        portalCount: Object.keys(thisplugin.fanpoints).length,
        fanPortals: Math.max(0, (thisplugin.n || 0) - 1),
        linkCount: totalLinks,
        fieldCount: totalFields,
        validLinkCount: validLinks,
        validTriangleCount: validFields,
        countsDiffer: countsDiffer,
        layers: layers,
        ap: buildAp,
        apRaw: rawAp,
        apLink: validLinks * AP_LINK,
        apField: validFields * AP_FIELD,
        centerKeys: thisplugin.centerKeys,
        centerOutgoings: thisplugin.centerOutgoings || 0,
        centerSbul: thisplugin.centerSbul || 0,
        startingpointIndex: thisplugin.startingpointIndex,
        startingpointGUID: thisplugin.startingpointGUID,
        is_clockwise: thisplugin.is_clockwise,
        stardirection: thisplugin.stardirection,
        availableSBUL: thisplugin.availableSBUL,
        hull: hull,
        stations: stations,
        walkMeters: walkMeters,
        links: links,
        fields: fields,
        keyList: keyList,
        degrees: degrees,
        invalidUnderFieldLinks: thisplugin.invalidUnderFieldLinks,
        invalidUnderFieldCount: Object.keys(thisplugin.invalidUnderFieldLinks || {}).length,
        sortedFanpoints: sorted,
        donelinks: donelinks,
        triangles: triangles
      };
    };

    thisplugin.nextStartingPointIndex = function (index, hullLength) {
      var i = (index == null ? thisplugin.startingpointIndex : index) + 1;
      if (i >= hullLength) i = 0;
      return i;
    };

    thisplugin.previousStartingPointIndex = function (index, hullLength) {
      var i = (index == null ? thisplugin.startingpointIndex : index) - 1;
      if (i < 0) i = hullLength - 1;
      return i;
    };

    thisplugin.hullOf = function (portals) {
      var points = {};
      var meta = {};
      for (var i = 0; i < portals.length; i++) {
        var pr = portals[i];
        var guid = pr.guid || pr.id;
        points[guid] = thisplugin.projectPortal(pr);
        meta[guid] = pr;
      }
      return convexHull(points).map(function (item) {
        var pr = meta[item[0]] || {};
        return {
          guid: item[0],
          name: pr.name || pr.label || item[0],
          lat: pr.lat,
          lng: pr.lng
        };
      });
    };

    return thisplugin;
  }

  return {
    createEngine: createEngine,
    STAR_DIR: STAR_DIR,
    CENTRALIZING: STAR_DIR.CENTRALIZING,
    RADIATING: STAR_DIR.RADIATING,
    AP_LINK: AP_LINK,
    AP_FIELD: AP_FIELD,
    computeFanMaxLayers: computeFanMaxLayers
  };
});
