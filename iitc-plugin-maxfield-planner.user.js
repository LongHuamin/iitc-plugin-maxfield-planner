// ==UserScript==
// @id             iitc-plugin-maxfield-planner@iitc
// @name           IITC plugin: maxfield-planner
// @category       Draw
// @version        1.3.10
// @namespace      iitc-plugin-maxfield-planner
// @description    在地图上直接点选 portal，用 Fan Fields 2 原版规划算法（锚点 Cycle Start、顺/逆时针、Inbound/Outbound）生成 field 最大化的 link 与行走顺序。统计层数、link、portal 与 AP。支持中英文与深浅色主题。兼容 IITC 桌面端与 IITC Mobile。本插件是 Fan Fields 2（ISC，© 2018-2025 IITC plugin: Fan Fields 2 / Justus Kenklies）规划引擎的派生作品，不是官方 Fan Fields 2。
// @include        https://intel.ingress.com/*
// @include        http://intel.ingress.com/*
// @include        https://*.ingress.com/intel*
// @include        http://*.ingress.com/intel*
// @match          https://intel.ingress.com/*
// @match          https://intel.ingress.com/*/*
// @recommends     keys@xelio|liveInventory@DanielOnDiordna
// @grant          none
// @updateURL https://raw.githubusercontent.com/LongHuamin/iitc-plugin-maxfield-planner/main/iitc-plugin-maxfield-planner.meta.js
// @downloadURL https://raw.githubusercontent.com/LongHuamin/iitc-plugin-maxfield-planner/main/iitc-plugin-maxfield-planner.user.js
// ==/UserScript==

/*
 * Planning engine derived from Fan Fields 2 2.8.4.20260912 by Heistergand.
 *
 * ISC License
 *
 * Copyright © 2018-2025 IITC plugin: Fan Fields 2
 * Copyright © 2018 Justus Kenklies
 *
 * Permission to use, copy, modify, and/or distribute this software for
 * any purpose with or without fee is hereby granted, provided that the
 * above copyright notice and this permission notice appear in all
 * copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
 * DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA
 * OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
function wrapper(plugin_info) {
  'use strict';
  var MFP_VERSION = '1.3.10';

/* Leaflet-compatible Web Mercator (EPSG:3857) helpers for Node tests.
 * In IITC the engine uses the real map.project / map.unproject and L.Point / L.LatLng.
 * Numerics follow Leaflet (Earth radius 6378137 for projection, 6371000 for distanceTo).
 */
(function (root, factory) {
  var exported = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exported;
  } else {
    root.FanFields2Geo = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EARTH_R = 6378137;
  var DISTANCE_R = 6371000;
  var MAX_LATITUDE = 85.0511287798;
  var TILE_SIZE = 256;
  var PROJECT_ZOOM = 16;

  function Point(x, y, round) {
    this.x = round ? Math.round(x) : x;
    this.y = round ? Math.round(y) : y;
  }

  Point.prototype.equals = function (other, maxMargin) {
    if (!other) return false;
    var margin = Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y));
    return margin <= (maxMargin === undefined ? 1.0E-9 : maxMargin);
  };

  Point.prototype.clone = function () {
    return new Point(this.x, this.y);
  };

  function LatLng(lat, lng, alt) {
    if (lat && typeof lat === 'object' && 'lat' in lat) {
      alt = lat.alt;
      lng = lat.lng;
      lat = lat.lat;
    } else if (Array.isArray(lat)) {
      alt = lat[2];
      lng = lat[1];
      lat = lat[0];
    }
    this.lat = +lat;
    this.lng = +lng;
    if (alt !== undefined) this.alt = +alt;
  }

  LatLng.prototype.equals = function (other, maxMargin) {
    if (!other) return false;
    var margin = Math.max(Math.abs(this.lat - other.lat), Math.abs(this.lng - other.lng));
    return margin <= (maxMargin === undefined ? 1.0E-9 : maxMargin);
  };

  LatLng.prototype.distanceTo = function (other) {
    var rad = Math.PI / 180;
    var lat1 = this.lat * rad;
    var lat2 = other.lat * rad;
    var sinDLat = Math.sin((other.lat - this.lat) * rad / 2);
    var sinDLon = Math.sin((other.lng - this.lng) * rad / 2);
    var a = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return DISTANCE_R * c;
  };

  var DEG_TO_RAD = Math.PI / 180;
  var RAD_TO_DEG = 180 / Math.PI;

  LatLng.prototype.bearingToE6 = function (other) {
    var d2r = DEG_TO_RAD;
    var r2d = RAD_TO_DEG;
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

  function mercatorProject(latlng) {
    var d = Math.PI / 180;
    var max = MAX_LATITUDE;
    var lat = Math.max(Math.min(max, latlng.lat), -max);
    var sin = Math.sin(lat * d);
    return new Point(
      EARTH_R * latlng.lng * d,
      EARTH_R * Math.log((1 + sin) / (1 - sin)) / 2
    );
  }

  function mercatorUnproject(point) {
    var d = 180 / Math.PI;
    return new LatLng(
      (2 * Math.atan(Math.exp(point.y / EARTH_R)) - (Math.PI / 2)) * d,
      (point.x * d) / EARTH_R
    );
  }

  // L.CRS.EPSG3857 transformation
  var TRANS_A = 0.5 / (Math.PI * EARTH_R);
  var TRANS_B = 0.5;
  var TRANS_C = -0.5 / (Math.PI * EARTH_R);
  var TRANS_D = 0.5;

  function crsScale(zoom) {
    return TILE_SIZE * Math.pow(2, zoom);
  }

  function project(latlng, zoom) {
    var p = mercatorProject(latlng instanceof LatLng ? latlng : new LatLng(latlng.lat, latlng.lng));
    var scale = crsScale(zoom === undefined ? PROJECT_ZOOM : zoom);
    return new Point(scale * (TRANS_A * p.x + TRANS_B), scale * (TRANS_C * p.y + TRANS_D));
  }

  function unproject(point, zoom) {
    var scale = crsScale(zoom === undefined ? PROJECT_ZOOM : zoom);
    var p = new Point((point.x / scale - TRANS_B) / TRANS_A, (point.y / scale - TRANS_D) / TRANS_C);
    return mercatorUnproject(p);
  }

  function latLng(a, b, c) {
    if (a instanceof LatLng) return a;
    return new LatLng(a, b, c);
  }

  function point(x, y, round) {
    if (x instanceof Point) return x;
    if (Array.isArray(x)) return new Point(x[0], x[1]);
    return new Point(x, y, round);
  }

  var L = {
    Point: Point,
    LatLng: LatLng,
    point: point,
    latLng: latLng
  };

  function createEnv() {
    return {
      L: L,
      map: {
        project: function (ll, zoom) { return project(ll, zoom); },
        unproject: function (p, zoom) { return unproject(p, zoom); }
      }
    };
  }

  return {
    Point: Point,
    LatLng: LatLng,
    L: L,
    project: project,
    unproject: unproject,
    createEnv: createEnv,
    PROJECT_ZOOM: PROJECT_ZOOM,
    DEG_TO_RAD: DEG_TO_RAD,
    RAD_TO_DEG: RAD_TO_DEG
  };
});

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

/* Favorites sync for maxfield-planner: merge logic (pure) + GitHub Gist client.
 * The current working plan is a second file in the same gist (not a favorite).
 * Works in Node (tests) and in the IITC page (desktop and IITC Mobile WebView).
 * Uses fetch only; no GM_ APIs. The token is never logged.
 */
(function (root, factory) {
  var exported = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exported;
  } else {
    root.MaxfieldFavSync = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GIST_FILE = 'maxfield-planner-favorites.json';
  var CURRENT_FILE = 'maxfield-planner-current.json';
  var GIST_DESC = 'maxfield-planner favorites';
  var API = 'https://api.github.com';

  function newId() {
    return 'fav-' + Date.now() + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  // Give every favorite an id and an updatedAt. Returns { list, changed }.
  function migrate(list, now) {
    now = now || Date.now();
    var out = [];
    var changed = false;
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (fav) {
      if (!fav || typeof fav !== 'object') { changed = true; return; }
      var f = fav;
      if (!f.id || seen[f.id]) {
        f = shallowCopy(f);
        f.id = newId();
        while (seen[f.id]) f.id = newId();
        changed = true;
      }
      if (!num(f.updatedAt)) {
        if (f === fav) f = shallowCopy(f);
        f.updatedAt = num(f.savedAt) || now;
        changed = true;
      }
      if (!num(f.savedAt)) {
        if (f === fav) f = shallowCopy(f);
        f.savedAt = f.updatedAt;
        changed = true;
      }
      seen[f.id] = true;
      out.push(f);
    });
    return { list: out, changed: changed };
  }

  function shallowCopy(o) {
    var r = {};
    Object.keys(o).forEach(function (k) { r[k] = o[k]; });
    return r;
  }

  function normTombs(t) {
    var out = {};
    if (!t || typeof t !== 'object') return out;
    Object.keys(t).forEach(function (id) {
      var v = num(t[id]);
      if (id && v) out[id] = v;
    });
    return out;
  }

  // Normalize a stored/remote document: { favorites: [...], tombstones: {id: deletedAt} }.
  function normalizeDoc(doc) {
    if (Array.isArray(doc)) doc = { favorites: doc };
    if (!doc || typeof doc !== 'object') doc = {};
    return {
      favorites: migrate(doc.favorites || [], 0).list.filter(function (f) { return num(f.updatedAt); }),
      tombstones: normTombs(doc.tombstones)
    };
  }

  function sortFavs(list) {
    return list.sort(function (a, b) {
      var d = num(b.savedAt) - num(a.savedAt);
      if (d) return d;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
  }

  // Merge two documents. Per id the newest updatedAt wins; a tombstone at or after
  // a favorite's updatedAt removes it. Tombstones are kept (newest per id).
  function merge(local, remote) {
    var a = normalizeDoc(local);
    var b = normalizeDoc(remote);
    var tombs = {};
    [a.tombstones, b.tombstones].forEach(function (t) {
      Object.keys(t).forEach(function (id) {
        if (!tombs[id] || t[id] > tombs[id]) tombs[id] = t[id];
      });
    });
    var byId = {};
    a.favorites.forEach(function (f) { byId[f.id] = f; });
    b.favorites.forEach(function (f) {
      var cur = byId[f.id];
      if (!cur || num(f.updatedAt) > num(cur.updatedAt)) byId[f.id] = f;
    });
    var favs = [];
    Object.keys(byId).forEach(function (id) {
      var f = byId[id];
      if (tombs[id] && tombs[id] >= num(f.updatedAt)) return;
      favs.push(f);
    });
    return { favorites: sortFavs(favs), tombstones: tombs };
  }

  function canonical(doc) {
    var d = normalizeDoc(doc);
    var tombs = {};
    Object.keys(d.tombstones).sort().forEach(function (k) { tombs[k] = d.tombstones[k]; });
    return JSON.stringify({ favorites: sortFavs(d.favorites.slice()), tombstones: tombs });
  }

  function sameDoc(x, y) {
    return canonical(x) === canonical(y);
  }

  function portalLite(p) {
    if (!p || typeof p !== 'object') return null;
    var guid = String(p.guid || p.id || '').replace(/^\s+|\s+$/g, '');
    if (!guid) return null;
    var lat = Number(p.lat);
    var lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { guid: guid, lat: lat, lng: lng, name: p.name == null ? '' : String(p.name) };
  }

  // Current working plan. updatedAt/clientId are kept, but content identity ignores them.
  function normalizeCurrent(doc) {
    doc = (doc && typeof doc === 'object') ? doc : {};
    var excluded = [];
    var exclIds = {};
    (Array.isArray(doc.excluded) ? doc.excluded : []).forEach(function (p) {
      var n = portalLite(p);
      if (!n || exclIds[n.guid]) return;
      exclIds[n.guid] = true;
      excluded.push(n);
    });
    var portals = [];
    var seen = {};
    (Array.isArray(doc.portals) ? doc.portals : []).forEach(function (p) {
      var n = portalLite(p);
      if (!n || seen[n.guid] || exclIds[n.guid]) return;
      seen[n.guid] = true;
      portals.push(n);
    });
    var byGuid = {};
    portals.forEach(function (p) { byGuid[p.guid] = true; });
    excluded.forEach(function (p) { byGuid[p.guid] = true; });
    var listOrder = [];
    var ordered = {};
    (Array.isArray(doc.listOrder) ? doc.listOrder : []).forEach(function (id) {
      id = String(id || '').replace(/^\s+|\s+$/g, '');
      if (!id || ordered[id] || !byGuid[id]) return;
      ordered[id] = true;
      listOrder.push(id);
    });
    portals.forEach(function (p) {
      if (ordered[p.guid]) return;
      ordered[p.guid] = true;
      listOrder.push(p.guid);
    });
    excluded.forEach(function (p) {
      if (ordered[p.guid]) return;
      ordered[p.guid] = true;
      listOrder.push(p.guid);
    });
    var sbul = doc.availableSBUL;
    if (sbul == null || sbul === '') sbul = 2;
    sbul = Number(sbul);
    if (!isFinite(sbul)) sbul = 2;
    if (sbul < 0) sbul = 0;
    if (sbul > 4) sbul = 4;
    sbul = Math.round(sbul);
    var star = Number(doc.stardirection);
    if (star !== 1 && star !== -1) star = -1;
    var idx = Number(doc.startingpointIndex);
    if (!isFinite(idx) || idx < 0) idx = 0;
    idx = Math.floor(idx);
    return {
      updatedAt: num(doc.updatedAt),
      clientId: doc.clientId ? String(doc.clientId) : '',
      planned: !!doc.planned,
      startingpointIndex: idx,
      is_clockwise: doc.is_clockwise !== false,
      stardirection: star,
      availableSBUL: sbul,
      portals: portals,
      excluded: excluded,
      listOrder: listOrder
    };
  }

  function currentKey(doc) {
    var d = normalizeCurrent(doc);
    return JSON.stringify({
      planned: d.planned,
      startingpointIndex: d.startingpointIndex,
      is_clockwise: d.is_clockwise,
      stardirection: d.stardirection,
      availableSBUL: d.availableSBUL,
      portals: d.portals,
      excluded: d.excluded,
      listOrder: d.listOrder
    });
  }

  function sameCurrent(a, b) {
    return currentKey(a) === currentKey(b);
  }

  // Remote replaces local only when it is strictly newer and was written by another device.
  function shouldApplyCurrent(local, remote, ourClientId) {
    if (!remote) return false;
    local = normalizeCurrent(local);
    remote = normalizeCurrent(remote);
    var ours = ourClientId || local.clientId;
    if (!remote.clientId || remote.clientId === ours) return false;
    return remote.updatedAt > local.updatedAt;
  }

  // push: local wins. apply: remote wins. skip: nothing to write and nothing to take.
  function decideCurrent(local, remote, ourClientId) {
    local = normalizeCurrent(local);
    if (ourClientId) local.clientId = String(ourClientId);
    if (!remote) {
      if (!local.updatedAt) return { action: 'skip', doc: local };
      return { action: 'push', doc: local };
    }
    remote = normalizeCurrent(remote);
    if (sameCurrent(local, remote)) return { action: 'skip', doc: local };
    if (shouldApplyCurrent(local, remote, local.clientId)) return { action: 'apply', doc: remote };
    if (local.updatedAt > remote.updatedAt) return { action: 'push', doc: local };
    return { action: 'skip', doc: local };
  }

  // Coalesce plan edits. A second flush with the same content does not call push.
  function createCurrentScheduler(opts) {
    opts = opts || {};
    var delay = opts.delay == null ? 2000 : opts.delay;
    var setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
    var getDoc = opts.getDoc;
    var push = opts.push;
    var timer = null;
    var lastKey = null;

    function schedule() {
      if (timer != null) clearTimer(timer);
      timer = setTimer(function () {
        timer = null;
        var doc = getDoc();
        var key = currentKey(doc);
        if (lastKey !== null && key === lastKey) return;
        lastKey = key;
        Promise.resolve(push(doc)).then(function (res) {
          if (res && res.apply && res.doc) {
            var applied = currentKey(res.doc);
            if (applied !== key) lastKey = applied;
          }
        }, function () {
          if (lastKey === key) lastKey = null;
        });
      }, delay);
    }

    return { schedule: schedule, delay: delay };
  }

  function SyncError(code, status) {
    this.code = code;
    this.status = status || 0;
  }

  // ---- GitHub Gist client ----
  function createClient(opts) {
    var token = opts.token;
    var fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? function (u, i) { return fetch(u, i); } : null);

    function req(method, url, body) {
      if (!fetchImpl) return Promise.reject(new SyncError('network'));
      var init = {
        method: method,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + token
        },
        cache: 'no-store'
      };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return fetchImpl(url, init).then(function (res) {
        if (res.ok) return res.json();
        var code = 'http';
        if (res.status === 401) code = 'auth';
        else if (res.status === 403 || res.status === 429) code = 'forbidden';
        else if (res.status === 404) code = 'notfound';
        throw new SyncError(code, res.status);
      }, function () {
        throw new SyncError('network');
      });
    }

    function findGist() {
      var page = 1;
      function next() {
        return req('GET', API + '/gists?per_page=100&page=' + page).then(function (list) {
          if (!Array.isArray(list) || !list.length) return null;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].files && list[i].files[GIST_FILE]) return list[i].id;
          }
          if (list.length < 100 || page >= 10) return null;
          page++;
          return next();
        });
      }
      return next();
    }

    function createGist(doc) {
      var files = {};
      files[GIST_FILE] = { content: JSON.stringify(doc) };
      return req('POST', API + '/gists', { description: GIST_DESC, public: false, files: files })
        .then(function (g) { return g.id; });
    }

    function readGist(id) {
      return req('GET', API + '/gists/' + encodeURIComponent(id)).then(function (g) {
        var file = g && g.files && g.files[GIST_FILE];
        if (!file) return { favorites: [], tombstones: {} };
        if (file.truncated && file.raw_url && fetchImpl) {
          return fetchImpl(file.raw_url, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new SyncError('http', res.status);
            return res.text();
          }, function () { throw new SyncError('network'); }).then(parseContent);
        }
        return parseContent(file.content);
      });
    }

    function parseContent(text) {
      if (!text) return { favorites: [], tombstones: {} };
      try {
        return normalizeDoc(JSON.parse(text));
      } catch (e) {
        throw new SyncError('badjson');
      }
    }

    function writeGist(id, doc) {
      var files = {};
      files[GIST_FILE] = { content: JSON.stringify(doc) };
      return req('PATCH', API + '/gists/' + encodeURIComponent(id), { files: files });
    }

    function parseCurrent(text) {
      if (!text) return null;
      try {
        return normalizeCurrent(JSON.parse(text));
      } catch (e) {
        throw new SyncError('badjson');
      }
    }

    function readCurrent(id) {
      return req('GET', API + '/gists/' + encodeURIComponent(id)).then(function (g) {
        var file = g && g.files && g.files[CURRENT_FILE];
        if (!file) return null;
        if (file.truncated && file.raw_url && fetchImpl) {
          return fetchImpl(file.raw_url, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new SyncError('http', res.status);
            return res.text();
          }, function () { throw new SyncError('network'); }).then(parseCurrent);
        }
        return parseCurrent(file.content);
      });
    }

    function writeCurrent(id, doc) {
      var files = {};
      files[CURRENT_FILE] = { content: JSON.stringify(normalizeCurrent(doc)) };
      return req('PATCH', API + '/gists/' + encodeURIComponent(id), { files: files });
    }

    function createCurrentGist(doc) {
      var files = {};
      files[GIST_FILE] = { content: JSON.stringify({ favorites: [], tombstones: {} }) };
      files[CURRENT_FILE] = { content: JSON.stringify(normalizeCurrent(doc)) };
      return req('POST', API + '/gists', { description: GIST_DESC, public: false, files: files })
        .then(function (g) { return g.id; });
    }

    return {
      findGist: findGist,
      createGist: createGist,
      readGist: readGist,
      writeGist: writeGist,
      readCurrent: readCurrent,
      writeCurrent: writeCurrent,
      createCurrentGist: createCurrentGist
    };
  }

  // One full sync round. local = {favorites, tombstones}; gistId may be empty.
  // Resolves { doc, gistId, pushed }.
  function syncOnce(opts) {
    var client = createClient(opts);
    var local = normalizeDoc(opts.local);
    var gistId = opts.gistId || '';
    var idStep = gistId
      ? Promise.resolve({ id: gistId, created: false })
      : client.findGist().then(function (id) {
        if (id) return { id: id, created: false };
        return client.createGist(local).then(function (nid) { return { id: nid, created: true }; });
      });
    return idStep.then(function (r) {
      if (r.created) return { doc: local, gistId: r.id, pushed: true };
      return client.readGist(r.id).then(function (remote) {
        var merged = merge(local, remote);
        if (sameDoc(merged, remote)) return { doc: merged, gistId: r.id, pushed: false };
        return client.writeGist(r.id, merged).then(function () {
          return { doc: merged, gistId: r.id, pushed: true };
        });
      });
    });
  }

  // Reconcile the current working plan with the same gist. Does not touch favorites.
  // Resolves { doc, gistId, pushed, apply }.
  function syncCurrent(opts) {
    opts = opts || {};
    var client = createClient(opts);
    var ourId = opts.clientId || (opts.local && opts.local.clientId) || '';
    var local = normalizeCurrent(opts.local);
    if (ourId) local.clientId = String(ourId);
    var gistId = opts.gistId || '';

    function finishExisting(id) {
      return client.readCurrent(id).then(function (remote) {
        var decision = decideCurrent(local, remote, local.clientId);
        if (decision.action === 'apply') return { doc: decision.doc, gistId: id, pushed: false, apply: true };
        if (decision.action !== 'push') return { doc: local, gistId: id, pushed: false, apply: false };
        return client.writeCurrent(id, local).then(function () {
          return { doc: local, gistId: id, pushed: true, apply: false };
        });
      });
    }

    if (gistId) return finishExisting(gistId);
    return client.findGist().then(function (id) {
      if (id) return finishExisting(id);
      var decision = decideCurrent(local, null, local.clientId);
      if (decision.action !== 'push') return { doc: local, gistId: '', pushed: false, apply: false };
      return client.createCurrentGist(local).then(function (nid) {
        return { doc: local, gistId: nid, pushed: true, apply: false };
      });
    });
  }

  return {
    GIST_FILE: GIST_FILE,
    CURRENT_FILE: CURRENT_FILE,
    newId: newId,
    migrate: migrate,
    normalizeDoc: normalizeDoc,
    merge: merge,
    sameDoc: sameDoc,
    normalizeCurrent: normalizeCurrent,
    currentKey: currentKey,
    sameCurrent: sameCurrent,
    shouldApplyCurrent: shouldApplyCurrent,
    decideCurrent: decideCurrent,
    createCurrentScheduler: createCurrentScheduler,
    createClient: createClient,
    syncOnce: syncOnce,
    syncCurrent: syncCurrent,
    SyncError: SyncError
  };
});

/* Highlight Intel links that cross the current plan.
 * Intersection test is the IITC Cross Links greatCircleArcIntersect
 * (plugins/cross-links.js): geodesic segments, shared endpoints are not crossings.
 * Works in Node tests and in the IITC page. Does not touch window.links styles.
 */
(function (root, factory) {
  var exported = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exported;
  } else {
    root.MaxfieldCrossLinks = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var D2R = Math.PI / 180;
  var CROSS_LINKS_LAYER_NAME = 'Cross Links';

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function toPoint(p) {
    if (!p) return null;
    var lat = num(typeof p.lat === 'function' ? p.lat() : p.lat);
    var lng = num(typeof p.lng === 'function' ? p.lng() : p.lng);
    if (lat == null || lng == null) return null;
    return {
      lat: lat,
      lng: lng,
      equals: function (other) {
        if (!other) return false;
        var margin = Math.max(Math.abs(lat - Number(other.lat)), Math.abs(lng - Number(other.lng)));
        return margin <= 1.0e-9;
      }
    };
  }

  function toCartesian(lat, lng) {
    lat *= D2R;
    lng *= D2R;
    var o = Math.cos(lat);
    return [o * Math.cos(lng), o * Math.sin(lng), Math.sin(lat)];
  }

  function cross(t, n) {
    return [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  }

  function dot(t, n) {
    return t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
  }

  // Port of window.plugin.crossLinks.greatCircleArcIntersect.
  function greatCircleArcIntersect(a0, a1, b0, b1) {
    a0 = toPoint(a0);
    a1 = toPoint(a1);
    b0 = toPoint(b0);
    b1 = toPoint(b1);
    if (!a0 || !a1 || !b0 || !b1) return false;

    if (a0.equals(a1)) return false;
    if (b0.equals(b1)) return false;

    if (a0.equals(b0) || a0.equals(b1)) return false;
    if (a1.equals(b0) || a1.equals(b1)) return false;

    if (Math.min(a0.lng, a1.lng) > Math.max(b0.lng, b1.lng)) return false;
    if (Math.max(a0.lng, a1.lng) < Math.min(b0.lng, b1.lng)) return false;

    var ca0 = toCartesian(a0.lat, a0.lng);
    var ca1 = toCartesian(a1.lat, a1.lng);
    var cb0 = toCartesian(b0.lat, b0.lng);
    var cb1 = toCartesian(b1.lat, b1.lng);

    var da = cross(ca0, ca1);
    var db = cross(cb0, cb1);

    var da0 = cross(da, ca0);
    var da1 = cross(da, ca1);
    var db0 = cross(db, cb0);
    var db1 = cross(db, cb1);

    var p = cross(da, db);

    var len2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    if (len2 < 1e-30) {
      var s1 = dot(cb0, da0);
      var d1 = dot(cb0, da1);
      if ((s1 < 0 && d1 > 0) || (s1 > 0 && d1 < 0)) return true;
      var s2 = dot(cb1, da0);
      var d2 = dot(cb1, da1);
      if ((s2 < 0 && d2 > 0) || (s2 > 0 && d2 < 0)) return true;
      var s3 = dot(ca0, db0);
      var d3 = dot(ca0, db1);
      if ((s3 < 0 && d3 > 0) || (s3 > 0 && d3 < 0)) return true;
      return false;
    }

    var n = 1 / Math.sqrt(len2);
    p[0] *= n;
    p[1] *= n;
    p[2] *= n;

    var s = dot(p, da0);
    var d = dot(p, da1);
    var l = dot(p, db0);
    var f = dot(p, db1);

    if (s > 0 && 0 > d && l > 0 && 0 > f) return true;
    if (0 > s && d > 0 && 0 > l && f > 0) return true;
    return false;
  }

  function pointFrom(p) {
    var pt = toPoint(p);
    if (!pt) return null;
    return { lat: pt.lat, lng: pt.lng };
  }

  function endsFromLatLngs(lls) {
    if (!lls || !lls.length) return null;
    if (lls[0] && Array.isArray(lls[0]) && lls[0].length && (lls[0][0] && lls[0][0].lat != null)) {
      lls = lls[0];
    }
    if (lls.length < 2) return null;
    var a = pointFrom(lls[0]);
    var b = pointFrom(lls[lls.length - 1]);
    if (!a || !b) return null;
    return [a, b];
  }

  // Intel link (Leaflet geodesic) or a plain {a,b}/{latLngs} segment.
  function linkEnds(link) {
    if (!link) return null;
    if (typeof link.getLatLngs === 'function') {
      var fromLayer = endsFromLatLngs(link.getLatLngs());
      if (fromLayer) return fromLayer;
    }
    if (Array.isArray(link.latLngs)) {
      var fromArr = endsFromLatLngs(link.latLngs);
      if (fromArr) return fromArr;
    }
    if (link.a && link.b) {
      var a = pointFrom(link.a);
      var b = pointFrom(link.b);
      if (a && b) return [a, b];
    }
    var data = link.options && link.options.data;
    if (data && data.oLatE6 != null && data.dLatE6 != null && data.oLngE6 != null && data.dLngE6 != null) {
      return [
        { lat: Number(data.oLatE6) / 1e6, lng: Number(data.oLngE6) / 1e6 },
        { lat: Number(data.dLatE6) / 1e6, lng: Number(data.dLngE6) / 1e6 }
      ];
    }
    return null;
  }

  function linkGuid(link, key) {
    if (link && link.options && link.options.guid) return String(link.options.guid);
    if (link && link.guid) return String(link.guid);
    if (key != null && key !== '') return String(key);
    return '';
  }

  // Intel links that cross at least one planned link. The planned link itself is not returned.
  function crossedIntelLinks(planLinks, intelLinks) {
    var plans = [];
    (Array.isArray(planLinks) ? planLinks : []).forEach(function (lk) {
      var ends = linkEnds(lk);
      if (ends) plans.push(ends);
    });
    var out = [];
    var seen = {};
    if (!intelLinks || !plans.length) return out;
    Object.keys(intelLinks).forEach(function (key) {
      var link = intelLinks[key];
      var ends = linkEnds(link);
      if (!ends) return;
      var guid = linkGuid(link, key);
      if (guid && seen[guid]) return;
      var hit = false;
      for (var i = 0; i < plans.length; i++) {
        if (greatCircleArcIntersect(plans[i][0], plans[i][1], ends[0], ends[1])) {
          hit = true;
          break;
        }
      }
      if (!hit) return;
      if (guid) seen[guid] = true;
      out.push({ guid: guid, latlngs: ends });
    });
    return out;
  }

  function layerEntries(chooser) {
    if (!chooser || chooser._layers == null) return [];
    var layers = chooser._layers;
    if (Array.isArray(layers)) return layers;
    var out = [];
    if (typeof layers === 'object') {
      Object.keys(layers).forEach(function (key) {
        if (layers[key]) out.push(layers[key]);
      });
    }
    return out;
  }

  // The official Cross Links overlay, identified by the layer-control label.
  function crossLinksLayer(chooser) {
    var list = layerEntries(chooser);
    for (var i = 0; i < list.length; i++) {
      var data = list[i];
      if (!data || data.name == null) continue;
      if (String(data.name) === CROSS_LINKS_LAYER_NAME) return data.layer || null;
    }
    return null;
  }

  // True only when that named layer is registered and currently on the map.
  function isCrossLinksLayerOn(map, chooser) {
    var layer = crossLinksLayer(chooser);
    if (!layer || !map || typeof map.hasLayer !== 'function') return false;
    return !!map.hasLayer(layer);
  }

  // overlayadd/overlayremove carry the control name; layeradd/layerremove carry the layer.
  function isCrossLinksToggleEvent(event, chooser) {
    if (!event) return false;
    if (event.name != null && String(event.name) === CROSS_LINKS_LAYER_NAME) return true;
    var layer = crossLinksLayer(chooser);
    if (!layer) return false;
    return event.layer === layer || event.target === layer;
  }

  return {
    CROSS_LINKS_LAYER_NAME: CROSS_LINKS_LAYER_NAME,
    greatCircleArcIntersect: greatCircleArcIntersect,
    linkEnds: linkEnds,
    crossedIntelLinks: crossedIntelLinks,
    crossLinksLayer: crossLinksLayer,
    isCrossLinksLayerOn: isCrossLinksLayerOn,
    isCrossLinksToggleEvent: isCrossLinksToggleEvent
  };
});

  // ----- IITC plugin UI (docked panel). Planning is Fan Fields 2. -----
  if (typeof window.plugin !== 'function') window.plugin = function () {};
  window.plugin.maxfieldPlanner = function () {};
  var self = window.plugin.maxfieldPlanner;

  self.LANG_KEY = 'iitc-maxfield-planner-lang';
  self.THEME_KEY = 'iitc-maxfield-planner-theme';
  self.COLOR_KEY = 'iitc-maxfield-planner-field-color';
  self.FIELD_HEX_KEY = 'iitc-maxfield-planner-field-hex';
  self.LINK_HEX_KEY = 'iitc-maxfield-planner-link-hex';
  self.WALK_HEX_KEY = 'iitc-maxfield-planner-walk-hex';
  self.WALK_VISIBLE_KEY = 'iitc-maxfield-planner-walk-visible';
  self.FIELD_VISIBLE_KEY = 'iitc-maxfield-planner-field-visible';
  self.LINK_VISIBLE_KEY = 'iitc-maxfield-planner-link-visible';
  self.PANEL_WIDTH_KEY = 'iitc-maxfield-planner-panel-width';
  self.TAB_POS_KEY = 'iitc-maxfield-planner-tab-pos';
  self.FAV_KEY = 'iitc-maxfield-planner-favorites';
  self.FAV_TOMB_KEY = 'iitc-maxfield-planner-favorites-deleted';
  self.SYNC_TOKEN_KEY = 'iitc-maxfield-planner-gist-token';
  self.SYNC_GIST_KEY = 'iitc-maxfield-planner-gist-id';
  self.CURRENT_KEY = 'iitc-maxfield-planner-current';
  self.CLIENT_KEY = 'iitc-maxfield-planner-client-id';
  self.VERSION = (typeof MFP_VERSION === 'string' && MFP_VERSION) ? MFP_VERSION : '';
  self.DEFAULT_FIELD_HEX = '#16d977';
  self.DEFAULT_LINK_HEX = '#e53935';
  self.DEFAULT_WALK_HEX = '#ffd24a';
  self.DEFAULT_PANEL_WIDTH = 360;
  self.MIN_PANEL_WIDTH = 280;
  self.MAX_PANEL_WIDTH = 720;
  self.PANEL_HEIGHT_KEY = 'iitc-maxfield-planner-panel-height';
  self.MIN_PANEL_HEIGHT = 200;
  self.WALK_COLOR = '#ffd24a';
  self.WALK_STROKE = '#ffcc33';
  self.THEME_COLORS = [
    '#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47',
    '#f2f2f2', '#7f7f7f', '#d0cece', '#d6dce4', '#d9e2f3', '#fbe5d5', '#ededed', '#fff2cc', '#deebf6', '#e2efd9',
    '#d8d8d8', '#595959', '#aeabab', '#adb9ca', '#b4c6e7', '#f7cbac', '#dbdbdb', '#fee599', '#bdd7ee', '#c5e0b3',
    '#bfbfbf', '#3f3f3f', '#757070', '#8496b0', '#8eaadb', '#f4b183', '#c9c9c9', '#ffd965', '#9cc3e5', '#a8d08d',
    '#a5a5a5', '#262626', '#3a3838', '#323f4f', '#2e5496', '#c55a11', '#7b7b7b', '#bf9000', '#2e75b5', '#538136',
    '#7f7f7f', '#0d0d0d', '#171717', '#222a36', '#203864', '#833d0b', '#525252', '#7f6000', '#1e4f79', '#375623'
  ];
  self.STANDARD_COLORS = [
    '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050',
    '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'
  ];
  self.COLOR_PRESETS = self.THEME_COLORS.concat(self.STANDARD_COLORS);
  self.PALETTE_WIDTH = 248;

  self.STAR_DIR = (typeof FanFields2Engine !== 'undefined' && FanFields2Engine.STAR_DIR)
    ? FanFields2Engine.STAR_DIR
    : { CENTRALIZING: -1, RADIATING: 1 };

  self.state = {
    open: false,
    minimized: false,
    portals: {},
    listOrder: [],
    excluded: {},
    plan: null,
    startingpointIndex: 0,
    is_clockwise: true,
    stardirection: self.STAR_DIR.CENTRALIZING,
    availableSBUL: 2,
    lastPickGuid: null,
    lastPickAt: 0,
    sectionsOpen: { keys: false, order: false, fav: false }
  };

  self.getEngine = function () {
    var env = (typeof window !== 'undefined' && window.map && window.L)
      ? { map: window.map, L: window.L }
      : ((typeof FanFields2Geo !== 'undefined' && FanFields2Geo.createEnv) ? FanFields2Geo.createEnv() : null);
    if (!env) throw new Error('Leaflet map is not ready');
    // Recreate when the real IITC map becomes available.
    if (!self._engine || self._engineEnv !== env.map) {
      self._engine = FanFields2Engine.createEngine(env);
      self._engineEnv = env.map;
    }
    return self._engine;
  };

  self.I18N = {
    zh: {
      title: 'maxfield-planner',
      tab: '规划',
      tabTitle: '拖动可换到屏幕任一边，点击打开 maxfield-planner',
      toolbox: 'maxfield-planner',
      langTitle: 'Switch to English',
      themeTitleLight: '切换为浅色主题',
      themeTitleDark: '切换为深色主题',
      min: '折叠',
      expand: '展开',
      close: '收起至边缘',
      planLink: '规划',
      clearPlan: '清除规划',
      clearAll: '全部清除',
      download: '导出',
      upload: '导入',
      favorite: '收藏',
      favConfirm: '保存',
      favCancel: '取消',
      favLoad: '载入',
      favDelete: '删除',
      favTitle: '收藏（{0}）',
      favNamePlaceholder: '收藏名称',
      stAddedInField: '已将该 portal 加入规划并重新规划。',
      downloaded: '已导出，可用 DrawTools Opt 导入。',
      stUploaded: '已成功导入{0}个portal，可执行规划',
      stUploadEmpty: '文件为空，请选择 IITC 导出的 bookmark JSON。',
      stUploadBadJson: '无法解析文件，请确认这是 IITC 导出的 bookmark JSON。',
      stUploadNoPortals: '文件中没有找到 portal 书签。请导入 IITC Bookmarks 导出的 JSON。',
      stUploadReadFail: '读取文件失败，请重试。',
      stUploadNoFile: '未选择文件。',
      favSaved: '已收藏为「{0}」。',
      favLoaded: '已载入收藏「{0}」。',
      favDeleted: '已删除收藏「{0}」。',
      favNeedName: '请输入收藏名称。',
      favSaveFail: '收藏保存失败。',
      syncBtn: '同步',
      syncSettings: '设置',
      syncTokenPh: 'GitHub token',
      syncTokenSavedPh: 'token 已保存，留空不变',
      syncGistPh: 'Gist ID（可留空）',
      syncSave: '保存',
      syncClear: '清除',
      stSyncing: '正在同步…',
      stSynced: '已同步',
      stSyncFail: '同步失败：{0}',
      stNeedToken: '请先填写 GitHub token',
      stSyncCleared: '已清除同步设置',
      syncErrAuth: 'token 无效或已过期',
      syncErrForbidden: '权限不足或请求过多',
      syncErrNotFound: '找不到 Gist',
      syncErrNetwork: '网络错误',
      syncErrBadJson: 'Gist 内容无法解析',
      syncErrHttp: 'HTTP {0}',
      selectedHeadPlan: '已选 portal（{0}）。点击场内未规划的 portal 会加入并重新规划；场外点击不影响当前规划。',
      selectedHeadPlanExcl: '已选 portal（{0}，已排除 {1}）。点击场内未规划的 portal 会加入并重新规划；场外点击不影响当前规划。',
      fieldColor: 'Field',
      linkColor: 'Link',
      walkColor: '轨迹',
      showField: '显示 Field',
      showLink: '显示 Link',
      showWalk: '显示轨迹',
      themeColors: '主题颜色',
      standardColors: '标准色',
      jumpTo: '在地图中定位该 portal',
      captureTag: '（占领）',
      resizeHint: '拖动左边缘调整宽度，拖动下边缘或右下角调整高度；双击下边缘可恢复自适应高度',
      restore: '恢复',
      excludedHead: '已排除 {0} 个，可在列表里点「恢复」重新加入。',
      stToggleOff: '已从规划中移除该 portal，可在列表里点「恢复」重新加入。',
      stToggleOn: '已重新加入规划。',
      copy: '复制',
      copiedKeys: '钥匙明细已复制',
      copiedOrder: '连接顺序已复制',
      copyManual: '请手动复制：',
      unselected: '未选择',
      remove: '移除',
      selectedHead: '已选 portal（{0}）。在地图上点击即可加入，移除请用列表里的「移除」。',
      selectedHeadExcl: '已选 portal（{0}，已排除 {1}）。规划完成后，在地图上点击只会定位到列表。',
      emptySelected: '尚未选择 portal。请在地图上直接点击要参与的 portal。',
      keysTitle: '钥匙明细（{0} 个 portal）',
      orderTitle: '连接顺序（{0} 站，{1} 条）',
      fieldsMade: '+{0} 场',
      stats: '{0} Field, {1} 层, {2} Link, {3} Portal',
      statField: 'Field',
      statLayer: '层',
      statLink: 'Link',
      statPortal: 'Portal',
      apLabel: '预估AP',
      apPrefix: '预估 ',
      apBreak: 'field {0} + link {1}',
      apCapture: '占领/插脚 {0}',
      apUnknown: '（{0} 个未加载，按占领并插满 8 脚估算）',
      walkKm: '步行约 {0} km',
      walkM: '步行约 {0} m',
      walkSep: '，',
      startPortal: '起点',
      anchorNow: '当前锚点',
      nextAnchor: '下一个锚点',
      prevAnchor: '上一个锚点',
      cycleScheme: '切换方案 {0}/{1}',
      planHint: '再点「规划」可切换方案（{0}/{1}）',
      planWithScheme: '规划 {0}/{1}',
      clockwise: '顺时针',
      counterclockwise: '逆时针',
      inbound: 'Inbound',
      outbound: 'Outbound',
      sbul: 'SBUL',
      sbulHint: 'Outbound 时，从锚点向外投出的 link 需要 SoftBank Ultra Link 槽位',
      starDirHint: '只改变锚点星形 link 的投出方向，连线形状通常不变。Inbound 是把 link 投向锚点（锚点要很多钥匙）；Outbound 是从锚点往外投（超过 8 条需要 SBUL）。',
      keysInventoryHint: '未检测到钥匙库存插件。安装 IITC 的 Keys 或 Live Inventory 后，会显示为「需要（库存）」，例如 20（5）。',
      hullPos: '{0} / {1}',
      stNoPortalInfo: '未获取到该 portal 信息，请把地图放大到它加载出来后再点。',
      stNeedThree: '请至少选择 3 个 portal，再点「规划」。',
      stCollecting: '请在地图上点击要参与的 portal，选够 3 个后点「规划」。',
      stAlready: '该 portal 已在列表中。要从规划中排除，请在列表里点「移除」。',
      stPlanned: '规划已画出。再点「规划」可切换不同锚点和顺/逆时针。',
      stPlanFail: '无法形成 field。请检查所选 portal 是否几乎共线。',
      stDone: '规划完成：{0} 个 field，最多 {1} 层，{2} 条 link，{3} 个 portal，{4} 站{5}，Build AP {6}。',
      stCannotRemoveAnchor: '当前锚点不能移除。请再点「规划」换一个锚点，或先清除规划。',
      underFieldWarn: '有 {0} 条 link 在已有 field 下方且超过 2 公里，原版会标为无效，不计入有效 field / link / Build AP。',
      countsNote: '有效 {0} field / {1} link（已排除场下超距 link）'
    },
    en: {
      title: 'maxfield-planner',
      tab: 'Plan',
      tabTitle: 'Drag to any screen edge, click to open maxfield-planner',
      toolbox: 'maxfield-planner',
      langTitle: '切换为中文',
      themeTitleLight: 'Switch to light theme',
      themeTitleDark: 'Switch to dark theme',
      min: 'Minimize',
      expand: 'Expand',
      close: 'Dock to edge',
      planLink: 'Plan',
      clearPlan: 'Clear plan',
      clearAll: 'Clear all',
      download: 'Export',
      upload: 'Import',
      favorite: 'Save',
      favConfirm: 'Save',
      favCancel: 'Cancel',
      favLoad: 'Load',
      favDelete: 'Delete',
      favTitle: 'Saved plans ({0})',
      favNamePlaceholder: 'Plan name',
      stAddedInField: 'Portal added to the plan and replanned.',
      downloaded: 'Exported. Import the file in DrawTools Opt.',
      stUploaded: 'Successfully imported {0} portals. You can tap Plan.',
      stUploadEmpty: 'The file is empty. Please choose a bookmark JSON exported from IITC.',
      stUploadBadJson: 'Could not parse the file. Please use a bookmark JSON exported from IITC.',
      stUploadNoPortals: 'No portal bookmarks were found. Please import a JSON exported from IITC Bookmarks.',
      stUploadReadFail: 'Could not read the file. Please try again.',
      stUploadNoFile: 'No file was selected.',
      favSaved: 'Saved as "{0}".',
      favLoaded: 'Loaded "{0}".',
      favDeleted: 'Deleted "{0}".',
      favNeedName: 'Please enter a name.',
      favSaveFail: 'Could not save the plan.',
      syncBtn: 'Sync',
      syncSettings: 'Settings',
      syncTokenPh: 'GitHub token',
      syncTokenSavedPh: 'Token saved; leave blank to keep',
      syncGistPh: 'Gist ID (optional)',
      syncSave: 'Save',
      syncClear: 'Clear',
      stSyncing: 'Syncing…',
      stSynced: 'Synced',
      stSyncFail: 'Sync failed: {0}',
      stNeedToken: 'Please enter a GitHub token first',
      stSyncCleared: 'Sync settings cleared',
      syncErrAuth: 'invalid or expired token',
      syncErrForbidden: 'no permission or rate limited',
      syncErrNotFound: 'gist not found',
      syncErrNetwork: 'network error',
      syncErrBadJson: 'gist content unreadable',
      syncErrHttp: 'HTTP {0}',
      selectedHeadPlan: 'Selected portals ({0}). Click an unplanned portal inside the fields to add it and replan. Clicks outside the fields leave the plan unchanged.',
      selectedHeadPlanExcl: 'Selected portals ({0}, {1} excluded). Click an unplanned portal inside the fields to add it and replan. Clicks outside the fields leave the plan unchanged.',
      fieldColor: 'Field',
      linkColor: 'Link',
      walkColor: 'Route',
      showField: 'Show fields',
      showLink: 'Show links',
      showWalk: 'Show route',
      themeColors: 'Theme colors',
      standardColors: 'Standard colors',
      jumpTo: 'Show this portal on the map',
      captureTag: ' (capture)',
      resizeHint: 'Drag the left edge to change width, or the bottom / corner to change height. Double-click the bottom edge to return to auto height.',
      restore: 'Restore',
      excludedHead: '{0} excluded. Use Restore in the list to include it again.',
      stToggleOff: 'Removed from the plan. Use Restore in the list to include it again.',
      stToggleOn: 'Added back to the plan.',
      copy: 'Copy',
      copiedKeys: 'Copied key list',
      copiedOrder: 'Copied connection order',
      copyManual: 'Copy manually:',
      unselected: 'Not selected',
      remove: 'Remove',
      selectedHead: 'Selected portals ({0}). Click a portal on the map to add it. Use Remove in the list to drop one.',
      selectedHeadExcl: 'Selected portals ({0}, {1} excluded). After a plan, a map click only locates the row.',
      emptySelected: 'No portals selected yet. Click portals directly on the map.',
      keysTitle: 'Keys ({0} portals)',
      orderTitle: 'Connection order ({0} stops, {1} links)',
      fieldsMade: '+{0} fields',
      stats: '{0} Fields, {1} layers, {2} Links, {3} Portals',
      statField: 'Fields',
      statLayer: 'layers',
      statLink: 'Links',
      statPortal: 'Portals',
      apLabel: 'Est. AP',
      apPrefix: 'Est. ',
      apBreak: 'field {0} + link {1}',
      apCapture: 'capture/deploy {0}',
      apUnknown: ' ({0} not loaded, estimated as capture + 8 resonators)',
      walkKm: 'Walk ~{0} km',
      walkM: 'Walk ~{0} m',
      walkSep: ', ',
      startPortal: 'START',
      anchorNow: 'Anchor',
      nextAnchor: 'Next anchor',
      prevAnchor: 'Previous anchor',
      cycleScheme: 'Switch plan {0}/{1}',
      planHint: 'Tap Plan again to switch plans ({0}/{1})',
      planWithScheme: 'Plan {0}/{1}',
      clockwise: 'Clockwise',
      counterclockwise: 'Counterclockwise',
      inbound: 'Inbound',
      outbound: 'Outbound',
      sbul: 'SBUL',
      sbulHint: 'Outbound throws from the anchor use SoftBank Ultra Link slots',
      starDirHint: 'When on, throw from the anchor (more than 8 outgoing links need the SBUL slots on the left). When off, throw toward the anchor. The undirected links usually stay the same.',
      keysInventoryHint: 'No key inventory plugin detected. Install IITC Keys or Live Inventory to show needed (owned), e.g. 20(5).',
      hullPos: '{0} / {1}',
      stNoPortalInfo: 'Could not read that portal. Zoom in until it loads, then try again.',
      stNeedThree: 'Please select at least 3 portals, then tap Plan.',
      stCollecting: 'Click portals on the map to include them. When you have 3 or more, tap Plan.',
      stAlready: 'That portal is already in the list. To exclude it, use Remove in the list.',
      stPlanned: 'Plan drawn. Tap Plan again to cycle anchors and clockwise/counterclockwise.',
      stPlanFail: 'Could not form a field. Check whether the selected portals are almost collinear.',
      stDone: 'Plan complete: {0} fields, {1} layers, {2} links, {3} portals, {4} stops{5}, Build AP {6}.',
      stCannotRemoveAnchor: 'The current anchor cannot be removed. Tap Plan again to change the anchor, or clear the plan first.',
      underFieldWarn: '{0} link(s) would be thrown from under a field and are longer than 2 km. The original marks them invalid and excludes them from valid field/link/Build AP counts.',
      countsNote: 'Valid {0} fields / {1} links (under-field over-limit links excluded)'
    }
  };


  self.getLang = function () {
    try {
      var v = localStorage.getItem(self.LANG_KEY);
      if (v === 'en' || v === 'zh') return v;
    } catch (e) {}
    return 'zh';
  };

  self.setLang = function (lang) {
    if (lang !== 'en') lang = 'zh';
    try { localStorage.setItem(self.LANG_KEY, lang); } catch (e) {}
    self.render();
  };

  self.t = function (key) {
    var args = [];
    var i;
    for (i = 1; i < arguments.length; i++) args.push(arguments[i]);
    var lang = self.getLang();
    var dict = (self.I18N && self.I18N[lang]) || {};
    var v = dict[key];
    if (v == null && self.I18N && self.I18N.zh) v = self.I18N.zh[key];
    if (v == null) return key;
    return String(v).replace(/\{(\d+)\}/g, function (_, idx) {
      return args[idx] == null ? '' : String(args[idx]);
    });
  };

  self.zhNum = function (n) {
    n = Math.floor(Number(n) || 0);
    var D = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 0) return String(n);
    if (n === 0) return '零';
    if (n < 10) return D[n];
    if (n === 10) return '十';
    if (n < 20) return '十' + D[n - 10];
    if (n < 100) {
      var tens = Math.floor(n / 10);
      var ones = n % 10;
      return D[tens] + '十' + (ones ? D[ones] : '');
    }
    if (n < 1000) {
      var hun = Math.floor(n / 100);
      var rest = n % 100;
      var s = D[hun] + '百';
      if (rest === 0) return s;
      if (rest < 10) return s + '零' + D[rest];
      if (rest < 20) return s + '一十' + (rest === 10 ? '' : D[rest - 10]);
      return s + self.zhNum(rest);
    }
    return String(n);
  };

  self.stationHeader = function (n) {
    if (self.getLang() === 'en') return 'Station ' + n + ':';
    return '第' + self.zhNum(n) + '站：';
  };

  self.getTheme = function () {
    try {
      var v = localStorage.getItem(self.THEME_KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch (e) {}
    return 'dark';
  };

  self.setTheme = function (theme) {
    if (theme !== 'light') theme = 'dark';
    try { localStorage.setItem(self.THEME_KEY, theme); } catch (e) {}
    self.applyTheme();
    self.applyChrome();
  };

  self.applyTheme = function () {
    var theme = self.getTheme();
    var els = [document.getElementById('mfp-panel'), document.getElementById('mfp-tab')];
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      els[i].classList.remove('mfp-theme-dark', 'mfp-theme-light');
      els[i].classList.add('mfp-theme-' + theme);
    }
  };

  self.normalizeHex = function (v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (s.charAt(0) !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return ('#' + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3)).toLowerCase();
    }
    return null;
  };

  self.hexToRgb = function (hex) {
    hex = self.normalizeHex(hex) || '#000000';
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  };

  self.rgbToHex = function (r, g, b) {
    function h(n) {
      n = Math.max(0, Math.min(255, Math.round(n)));
      var s = n.toString(16);
      return s.length === 1 ? '0' + s : s;
    }
    return '#' + h(r) + h(g) + h(b);
  };

  self.darkenHex = function (hex, factor) {
    var c = self.hexToRgb(hex);
    if (factor == null) factor = 0.82;
    return self.rgbToHex(c.r * factor, c.g * factor, c.b * factor);
  };

  self.getFieldHex = function () {
    try {
      var hex = self.normalizeHex(localStorage.getItem(self.FIELD_HEX_KEY));
      if (hex) return hex;
      var old = localStorage.getItem(self.COLOR_KEY);
      if (old === 'blue') hex = '#4c8dff';
      else if (old === 'green') hex = '#16d977';
      if (hex) {
        try { localStorage.setItem(self.FIELD_HEX_KEY, hex); } catch (e2) {}
        return hex;
      }
    } catch (e) {}
    return self.DEFAULT_FIELD_HEX;
  };

  self.getLinkHex = function () {
    try {
      var hex = self.normalizeHex(localStorage.getItem(self.LINK_HEX_KEY));
      if (hex) return hex;
    } catch (e) {}
    return self.DEFAULT_LINK_HEX;
  };

  self.setFieldHex = function (hex) {
    hex = self.normalizeHex(hex) || self.DEFAULT_FIELD_HEX;
    try { localStorage.setItem(self.FIELD_HEX_KEY, hex); } catch (e) {}
    var cur = self.getPlan();
    if (cur) self.drawPlan(cur);
    self.updateColorSwatches();
  };

  self.setLinkHex = function (hex) {
    hex = self.normalizeHex(hex) || self.DEFAULT_LINK_HEX;
    try { localStorage.setItem(self.LINK_HEX_KEY, hex); } catch (e) {}
    var cur = self.getPlan();
    if (cur) self.drawPlan(cur);
    self.updateColorSwatches();
  };

  self.getWalkHex = function () {
    try {
      var hex = self.normalizeHex(localStorage.getItem(self.WALK_HEX_KEY));
      if (hex) return hex;
    } catch (e) {}
    return self.DEFAULT_WALK_HEX;
  };

  self.setWalkHex = function (hex) {
    hex = self.normalizeHex(hex) || self.DEFAULT_WALK_HEX;
    try { localStorage.setItem(self.WALK_HEX_KEY, hex); } catch (e) {}
    var cur = self.getPlan();
    if (cur) self.drawPlan(cur);
    self.updateColorSwatches();
  };

  self.getWalkStroke = function () {
    var hex = self.getWalkHex();
    if (hex === self.DEFAULT_WALK_HEX) return self.WALK_STROKE;
    return self.darkenHex(hex, 0.86);
  };

  self.contrastText = function (hex) {
    var c = self.hexToRgb(hex);
    var lum = (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
    return lum > 160 ? '#3a2a00' : '#ffffff';
  };

  self.isLightHex = function (hex) {
    var c = self.hexToRgb(hex);
    return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 > 200;
  };

  self.visibleKeyFor = function (which) {
    if (which === 'field') return self.FIELD_VISIBLE_KEY;
    if (which === 'link') return self.LINK_VISIBLE_KEY;
    return self.WALK_VISIBLE_KEY;
  };

  self.getLayerVisible = function (which) {
    try {
      var v = localStorage.getItem(self.visibleKeyFor(which));
      if (v === '0' || v === 'false') return false;
      if (v === '1' || v === 'true') return true;
    } catch (e) {}
    return true;
  };

  self.setLayerVisible = function (which, visible) {
    visible = !!visible;
    try { localStorage.setItem(self.visibleKeyFor(which), visible ? '1' : '0'); } catch (e) {}
    var cur = self.getPlan();
    if (cur) self.drawPlan(cur);
    self.updateWalkToggle();
  };

  self.getWalkVisible = function () { return self.getLayerVisible('walk'); };
  self.setWalkVisible = function (visible) { self.setLayerVisible('walk', visible); };
  self.getFieldVisible = function () { return self.getLayerVisible('field'); };
  self.getLinkVisible = function () { return self.getLayerVisible('link'); };

  self.updateWalkToggle = function () {
    ['field', 'link', 'walk'].forEach(function (which) {
      var box = document.getElementById('mfp-' + which + '-visible');
      if (box) box.checked = self.getLayerVisible(which);
    });
  };

  self.getColorFor = function (which) {
    if (which === 'link') return self.getLinkHex();
    if (which === 'walk') return self.getWalkHex();
    return self.getFieldHex();
  };

  self.setColorFor = function (which, hex) {
    if (which === 'link') self.setLinkHex(hex);
    else if (which === 'walk') self.setWalkHex(hex);
    else self.setFieldHex(hex);
  };

  self.updateColorSwatches = function () {
    var fieldBtn = document.getElementById('mfp-field-swatch');
    var linkBtn = document.getElementById('mfp-link-swatch');
    var walkBtn = document.getElementById('mfp-walk-swatch');
    if (fieldBtn) fieldBtn.style.background = self.getFieldHex();
    if (linkBtn) linkBtn.style.background = self.getLinkHex();
    if (walkBtn) walkBtn.style.background = self.getWalkHex();
    self.updateWalkToggle();
  };


  self.clampPanelWidth = function (w) {
    var vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1200;
    var max = Math.min(Math.floor(vw * 0.9) || self.MAX_PANEL_WIDTH, self.MAX_PANEL_WIDTH);
    if (max < self.MIN_PANEL_WIDTH) max = self.MIN_PANEL_WIDTH;
    w = Math.round(Number(w) || self.DEFAULT_PANEL_WIDTH);
    if (w < self.MIN_PANEL_WIDTH) w = self.MIN_PANEL_WIDTH;
    if (w > max) w = max;
    return w;
  };

  self.getPanelWidth = function () {
    try {
      var v = parseInt(localStorage.getItem(self.PANEL_WIDTH_KEY), 10);
      if (v && isFinite(v)) return self.clampPanelWidth(v);
    } catch (e) {}
    return self.clampPanelWidth(self.DEFAULT_PANEL_WIDTH);
  };

  self.setPanelWidth = function (w) {
    w = self.clampPanelWidth(w);
    try { localStorage.setItem(self.PANEL_WIDTH_KEY, String(w)); } catch (e) {}
    return w;
  };

  self.applyPanelWidth = function () {
    var panel = document.getElementById('mfp-panel');
    if (!panel) return;
    if (self.isMobile()) {
      panel.style.width = '';
      return;
    }
    panel.style.width = self.getPanelWidth() + 'px';
  };

  self.clampPanelHeight = function (h, top) {
    var vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 800;
    top = Number(top);
    if (!isFinite(top)) {
      var panel = document.getElementById('mfp-panel');
      top = panel ? panel.getBoundingClientRect().top : 68;
    }
    var max = Math.floor(vh - Math.max(0, top) - 8);
    if (max < self.MIN_PANEL_HEIGHT) max = self.MIN_PANEL_HEIGHT;
    h = Math.round(Number(h) || 0);
    if (h < self.MIN_PANEL_HEIGHT) h = self.MIN_PANEL_HEIGHT;
    if (h > max) h = max;
    return h;
  };

  self.getPanelHeight = function () {
    try {
      var v = parseInt(localStorage.getItem(self.PANEL_HEIGHT_KEY), 10);
      if (v && isFinite(v) && v > 0) return v;
    } catch (e) {}
    return null;
  };

  self.setPanelHeight = function (h, top) {
    h = self.clampPanelHeight(h, top);
    try { localStorage.setItem(self.PANEL_HEIGHT_KEY, String(h)); } catch (e) {}
    return h;
  };

  self.clearPanelHeight = function () {
    try { localStorage.removeItem(self.PANEL_HEIGHT_KEY); } catch (e) {}
    var panel = document.getElementById('mfp-panel');
    if (panel) panel.style.height = '';
    self.applyPanelSize();
  };

  self.applyPanelHeight = function () {
    var panel = document.getElementById('mfp-panel');
    if (!panel) return;
    if (self.isMobile() || self.state.minimized) {
      panel.style.height = '';
      return;
    }
    if (self._resizing) return;
    var h = self.getPanelHeight();
    if (h) panel.style.height = self.clampPanelHeight(h, panel.getBoundingClientRect().top) + 'px';
    else panel.style.height = '';
  };

  self.applyPanelSize = function () {
    self.applyPanelWidth();
    self.applyPanelHeight();
  };

  self.closePalette = function () {
    var pop = document.getElementById('mfp-palette');
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    if (self._paletteOutside) {
      document.removeEventListener('mousedown', self._paletteOutside, true);
      document.removeEventListener('touchstart', self._paletteOutside, true);
      self._paletteOutside = null;
    }
  };


  self.openPalette = function (which, anchor) {
    self.closePalette();
    var panel = document.getElementById('mfp-panel');
    if (!panel || !anchor) return;
    var current = self.getColorFor(which);
    var pop = document.createElement('div');
    pop.id = 'mfp-palette';

    function addLabel(text, extraClass) {
      var lab = document.createElement('div');
      lab.className = 'mfp-palette-label' + (extraClass ? ' ' + extraClass : '');
      lab.textContent = text;
      pop.appendChild(lab);
    }
    function addSwatch(parent, hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mfp-preset' + (hex === current ? ' on' : '');
      b.style.background = hex;
      if (self.isLightHex(hex)) b.style.borderColor = 'rgba(0,0,0,.35)';
      b.setAttribute('data-hex', hex);
      b.title = hex;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        self.setColorFor(which, hex);
        self.closePalette();
      });
      parent.appendChild(b);
    }
    function addRow(className, colors) {
      var row = document.createElement('div');
      row.className = className;
      var i;
      for (i = 0; i < colors.length; i++) addSwatch(row, colors[i]);
      pop.appendChild(row);
    }

    addLabel(self.t('themeColors'));
    addRow('mfp-palette-row mfp-palette-bases', self.THEME_COLORS.slice(0, 10));
    addRow('mfp-palette-row mfp-palette-shades', self.THEME_COLORS.slice(10));
    addLabel(self.t('standardColors'), 'mfp-palette-label-std');
    addRow('mfp-palette-row', self.STANDARD_COLORS);

    var native = document.createElement('input');
    native.type = 'color';
    native.className = 'mfp-palette-native';
    native.value = current;
    native.addEventListener('input', function () {
      var hex = self.normalizeHex(native.value);
      if (!hex) return;
      self.setColorFor(which, hex);
    });
    native.addEventListener('change', function () {
      var hex = self.normalizeHex(native.value);
      if (hex) self.setColorFor(which, hex);
      self.closePalette();
    });
    pop.appendChild(native);
    pop.setAttribute('data-which', which);
    pop.classList.add('mfp-theme-' + self.getTheme());
    document.body.appendChild(pop);

    var btnRect = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth || self.PALETTE_WIDTH || 248;
    var ph = pop.offsetHeight || 260;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var left = btnRect.left;
    var top = btnRect.bottom + 4;
    if (left + pw > vw - 8) left = vw - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > vh - 8) {
      var above = btnRect.top - ph - 4;
      if (above >= 8) top = above;
      else top = Math.max(8, vh - ph - 8);
    }
    if (top < 8) top = 8;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    var maxH = Math.max(120, vh - Math.round(top) - 8);
    pop.style.maxHeight = maxH + 'px';

    self._paletteOutside = function (e) {
      var t = e.target;
      if (pop.contains(t) || t === anchor) return;
      self.closePalette();
    };
    document.addEventListener('mousedown', self._paletteOutside, true);
    document.addEventListener('touchstart', self._paletteOutside, true);
  };


  self.injectCSS = function () {
    if (document.getElementById('mfp-style')) return;
    var css = [
      '#mfp-tab,#mfp-panel,#mfp-palette{--mfp-bg:rgba(14,20,22,.97);--mfp-text:#eef2f1;--mfp-border:rgba(80,200,180,.55);--mfp-header-bg:rgba(20,80,70,.45);--mfp-accent:#9ff0e4;--mfp-accent-btn:#1fb8a3;--mfp-accent-btn-text:#06221e;--mfp-muted:#aab;--mfp-btn-bg:rgba(255,255,255,.1);--mfp-btn-text:#eef;--mfp-danger-bg:rgba(180,60,60,.35);--mfp-danger-text:#ffd0d0;--mfp-badge:#665200;--mfp-badge-text:#ffe48a;--mfp-badge-b:#1b4d46;--mfp-badge-b-text:#9ff0e4;--mfp-badge-c:#4a3a66;--mfp-badge-c-text:#e0c6ff;--mfp-input-border:rgba(255,255,255,.12);--mfp-scroll-thumb:rgba(159,240,228,.55);--mfp-scroll-track:rgba(255,255,255,.08);--mfp-station:#ffe48a;--mfp-shadow:0 8px 28px rgba(0,0,0,.5);--mfp-icon-bg:rgba(255,255,255,.08);--mfp-icon-color:#fff;--mfp-tool-bg:rgba(255,255,255,.06);--mfp-tool-border:rgba(255,255,255,.16);--mfp-tool-text:#cfe;--mfp-step:#b8fff0;--mfp-row-border:rgba(255,255,255,.08);--mfp-result-bg:rgba(255,255,255,.05);--mfp-ap:#ffe48a;--mfp-swatch-border:rgba(255,255,255,.35);--mfp-stat-num:var(--mfp-accent);--mfp-stat-border:var(--mfp-border);--mfp-stat-bg:rgba(255,255,255,.04);}',
      '#mfp-tab.mfp-theme-light,#mfp-panel.mfp-theme-light,#mfp-palette.mfp-theme-light{--mfp-bg:#f4f7f6;--mfp-text:#1a2422;--mfp-border:rgba(20,120,110,.45);--mfp-header-bg:#d7efe9;--mfp-accent:#0e7a6c;--mfp-accent-btn:#149988;--mfp-accent-btn-text:#06221e;--mfp-muted:#5c6b68;--mfp-btn-bg:rgba(0,0,0,.08);--mfp-btn-text:#1a2422;--mfp-danger-bg:rgba(180,60,60,.16);--mfp-danger-text:#9a2020;--mfp-badge:#f3e0a0;--mfp-badge-text:#5a4300;--mfp-badge-b:#c8ebe4;--mfp-badge-b-text:#0e5c52;--mfp-badge-c:#e4d6f5;--mfp-badge-c-text:#5a3d7a;--mfp-input-border:rgba(0,0,0,.14);--mfp-scroll-thumb:rgba(20,120,110,.45);--mfp-scroll-track:rgba(0,0,0,.08);--mfp-station:#8a5a00;--mfp-shadow:0 8px 28px rgba(0,0,0,.18);--mfp-icon-bg:rgba(0,0,0,.08);--mfp-icon-color:#1a2422;--mfp-tool-bg:rgba(0,0,0,.05);--mfp-tool-border:rgba(0,0,0,.16);--mfp-tool-text:#1a2422;--mfp-step:#0e6b5e;--mfp-row-border:rgba(0,0,0,.08);--mfp-result-bg:rgba(0,0,0,.04);--mfp-ap:#8a5a00;--mfp-swatch-border:rgba(0,0,0,.28);--mfp-stat-num:var(--mfp-accent);--mfp-stat-border:var(--mfp-border);--mfp-stat-bg:#ffffff;}',
      '#mfp-tab{position:fixed;z-index:3999;right:0;top:42%;width:30px;min-height:92px;padding:12px 0;background:var(--mfp-bg);border:1px solid var(--mfp-border);border-right:0;border-radius:8px 0 0 8px;color:var(--mfp-accent);cursor:grab;font:700 13px/1.2 "Roboto","Noto Sans SC","Helvetica Neue",Arial,sans-serif;letter-spacing:.12em;box-shadow:-2px 2px 10px rgba(0,0,0,.25);user-select:none;-webkit-user-select:none;touch-action:none;-webkit-touch-callout:none;writing-mode:vertical-rl;text-orientation:mixed;display:flex;align-items:center;justify-content:center;}',
      '#mfp-tab.mfp-mobile{width:36px;min-height:110px;font-size:15px;}',
      '#mfp-tab:hover{background:var(--mfp-header-bg);}',
      '#mfp-tab.mfp-dragging{cursor:grabbing;opacity:.92;}',
      '#mfp-tab.mfp-edge-right{left:auto;right:0;bottom:auto;writing-mode:vertical-rl;text-orientation:mixed;width:30px;min-height:92px;height:auto;padding:12px 0;border-radius:8px 0 0 8px;border-style:solid;border-width:1px 0 1px 1px;border-color:var(--mfp-border);}',
      '#mfp-tab.mfp-edge-left{left:0;right:auto;bottom:auto;writing-mode:vertical-rl;text-orientation:mixed;width:30px;min-height:92px;height:auto;padding:12px 0;border-radius:0 8px 8px 0;border-style:solid;border-width:1px 1px 1px 0;border-color:var(--mfp-border);}',
      '#mfp-tab.mfp-edge-top{top:0;bottom:auto;right:auto;writing-mode:horizontal-tb;text-orientation:mixed;width:auto;min-height:0;height:30px;padding:0 14px;letter-spacing:.08em;border-radius:0 0 8px 8px;border-style:solid;border-width:0 1px 1px 1px;border-color:var(--mfp-border);}',
      '#mfp-tab.mfp-edge-bottom{bottom:0;top:auto;right:auto;writing-mode:horizontal-tb;text-orientation:mixed;width:auto;min-height:0;height:30px;padding:0 14px;letter-spacing:.08em;border-radius:8px 8px 0 0;border-style:solid;border-width:1px 1px 0 1px;border-color:var(--mfp-border);}',
      '#mfp-tab.mfp-mobile.mfp-edge-right,#mfp-tab.mfp-mobile.mfp-edge-left{width:36px;min-height:110px;}',
      '#mfp-tab.mfp-mobile.mfp-edge-top,#mfp-tab.mfp-mobile.mfp-edge-bottom{height:36px;padding:0 16px;font-size:15px;}',
      '#mfp-panel{position:fixed;z-index:4000;color:var(--mfp-text);background:var(--mfp-bg);border:1px solid var(--mfp-border);border-radius:10px;box-shadow:var(--mfp-shadow);font:14px/1.45 "Roboto","Noto Sans SC","Helvetica Neue",Arial,sans-serif;overflow:hidden;display:flex;flex-direction:column;}',
      '#mfp-panel.mfp-desktop{width:360px;top:68px;right:12px;max-height:calc(100vh - 80px);}',
      '#mfp-panel.mfp-mobile{left:8px;right:8px;bottom:32px;max-height:min(70vh, calc(100vh - 80px));padding-bottom:env(safe-area-inset-bottom,0);}',
      '#mfp-panel .mfp-resize,#mfp-panel .mfp-resize-w{position:absolute;left:0;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:8;touch-action:none;background:transparent;}',
      '#mfp-panel .mfp-resize-s{position:absolute;left:0;right:0;bottom:0;height:10px;cursor:ns-resize;z-index:8;touch-action:none;background:transparent;}',
      '#mfp-panel .mfp-resize-se{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:9;touch-action:none;background:transparent;}',
      '#mfp-panel .mfp-resize-se:after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid var(--mfp-muted);border-bottom:2px solid var(--mfp-muted);opacity:.75;pointer-events:none;}',
      '#mfp-panel.mfp-mobile .mfp-resize,#mfp-panel.mfp-mobile .mfp-resize-w,#mfp-panel.mfp-mobile .mfp-resize-s,#mfp-panel.mfp-mobile .mfp-resize-se{display:none;}',
      '#mfp-panel.mfp-min .mfp-resize-s,#mfp-panel.mfp-min .mfp-resize-se{display:none;}',
      '#mfp-panel.mfp-min .mfp-body{display:none;}',
      '#mfp-panel.mfp-min.mfp-mobile{max-height:none;}',
      '#mfp-panel .mfp-header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--mfp-header-bg);cursor:move;user-select:none;-webkit-user-select:none;color:var(--mfp-text);}',
      '#mfp-panel.mfp-mobile .mfp-header{cursor:default;}',
      '#mfp-panel .mfp-title{flex:1;display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;}',
      '#mfp-panel .mfp-title-name{font-weight:700;font-size:15px;letter-spacing:.02em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#mfp-panel .mfp-version{flex:0 0 auto;font-size:11px;font-weight:600;letter-spacing:0;color:var(--mfp-muted);white-space:nowrap;}',
      '#mfp-panel .mfp-iconbtn{appearance:none;border:0;background:var(--mfp-icon-bg);color:var(--mfp-icon-color);width:36px;height:36px;border-radius:8px;font-size:18px;line-height:36px;padding:0;cursor:pointer;flex-shrink:0;}',
      '#mfp-panel .mfp-iconbtn.mfp-langbtn,#mfp-panel .mfp-iconbtn.mfp-themebtn{font-size:13px;font-weight:700;letter-spacing:0;}',
      '#mfp-panel .mfp-body{padding:8px 10px 10px;overflow:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto;min-height:0;}',
      '#mfp-panel .mfp-tools{display:flex;gap:6px;margin:0 0 8px;}',
      '#mfp-panel .mfp-tool{flex:1;appearance:none;border:1px solid var(--mfp-tool-border);background:var(--mfp-tool-bg);color:var(--mfp-tool-text);border-radius:8px;padding:7px 8px;font-size:13px;font-weight:700;cursor:pointer;min-height:36px;}',
      '#mfp-panel .mfp-tool.on{background:var(--mfp-accent-btn);border-color:var(--mfp-accent-btn);color:var(--mfp-accent-btn-text);}',
      '#mfp-panel .mfp-step{font-size:13px;color:var(--mfp-step);margin:0 0 6px;min-height:0;}',
      '#mfp-panel .mfp-step:empty{display:none;margin:0;}',
      '#mfp-panel .mfp-row{display:flex;align-items:center;gap:6px;padding:4px 0;min-height:36px;box-sizing:border-box;border-bottom:1px solid var(--mfp-row-border);}',
      '#mfp-panel .mfp-row .mfp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#mfp-panel .mfp-row.mfp-excluded .mfp-name{opacity:.55;text-decoration:line-through;}',
      '#mfp-panel .mfp-row.mfp-locate{background:rgba(31,184,163,.28);box-shadow:inset 0 0 0 1px var(--mfp-accent);border-radius:6px;}',
      '#mfp-panel .mfp-badge{font-size:11px;padding:1px 6px;border-radius:99px;background:var(--mfp-badge);color:var(--mfp-badge-text);white-space:nowrap;}',
      '#mfp-panel .mfp-badge.b{background:var(--mfp-badge-b);color:var(--mfp-badge-b-text);}',
      '#mfp-panel .mfp-badge.c{background:var(--mfp-badge-c);color:var(--mfp-badge-c-text);}',
      '#mfp-panel .mfp-linkbtn,#mfp-panel .mfp-mini{appearance:none;border:0;background:var(--mfp-btn-bg);color:var(--mfp-btn-text);border-radius:7px;padding:6px 8px;font-size:12px;cursor:pointer;min-height:32px;}',
      '#mfp-panel .mfp-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 6px;}',
      '#mfp-panel .mfp-plan-tools{margin-top:0;position:relative;}',
      '#mfp-panel .mfp-fav-form{display:none;gap:6px;align-items:center;margin:0 0 8px;}',
      '#mfp-panel .mfp-fav-form.is-on{display:flex;}',
      '#mfp-panel .mfp-fav-form input{flex:1;min-width:0;border:1px solid var(--mfp-input-border);background:var(--mfp-tool-bg);color:var(--mfp-text);border-radius:7px;padding:6px 8px;font:inherit;font-size:13px;min-height:32px;}',
      '#mfp-panel .mfp-fav-row{display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--mfp-row-border);}',
      '#mfp-panel .mfp-fav-row:last-child{border-bottom:0;}',
      '#mfp-panel .mfp-fav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}',
      '#mfp-panel .mfp-btn{appearance:none;border:0;border-radius:8px;padding:9px 12px;font-size:14px;font-weight:700;cursor:pointer;flex:1;min-height:42px;}',
      '#mfp-panel .mfp-btn.primary{background:var(--mfp-accent-btn);color:var(--mfp-accent-btn-text);}',
      '#mfp-panel #mfp-plan{white-space:nowrap;}',
      '#mfp-panel .mfp-btn.secondary{background:var(--mfp-btn-bg);color:var(--mfp-btn-text);}',
      '#mfp-panel .mfp-btn.danger{background:var(--mfp-danger-bg);color:var(--mfp-danger-text);}',
      '#mfp-panel .mfp-btn:disabled{opacity:.45;cursor:default;}',
      '#mfp-panel .mfp-list-head{font-size:12px;color:var(--mfp-muted);margin:4px 0 2px;display:flex;align-items:center;gap:8px;}',
      '#mfp-panel .mfp-list-head .mfp-mini{margin-left:auto;}',
      '#mfp-panel .mfp-list{max-height:108px;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;border:1px solid var(--mfp-input-border);border-radius:8px;padding:0 6px;}',
      '#mfp-panel .mfp-list.mfp-empty{max-height:none;overflow:visible;border:0;padding:0;}',
      '#mfp-panel .mfp-colors{display:flex;align-items:center;gap:6px;margin:6px 0 2px;font-size:14px;flex-wrap:wrap;}',
      '#mfp-panel .mfp-swatch{appearance:none;width:16px;height:16px;border-radius:50%;border:1px solid var(--mfp-swatch-border);padding:0;cursor:pointer;flex-shrink:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);}',
      '#mfp-panel .mfp-color-item{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;margin-right:6px;}',
      '#mfp-panel .mfp-vis-box{margin:0;accent-color:var(--mfp-accent-btn);width:15px;height:15px;cursor:pointer;flex-shrink:0;}',
      '#mfp-palette{position:fixed;z-index:5000;width:248px;box-sizing:border-box;padding:8px;background:var(--mfp-bg);color:var(--mfp-text);border:1px solid var(--mfp-border);border-radius:8px;box-shadow:var(--mfp-shadow);overflow:auto;}',
      '#mfp-palette .mfp-palette-label{font-size:12px;color:var(--mfp-muted);margin:0 0 5px;line-height:1.2;}',
      '#mfp-palette .mfp-palette-label-std{margin-top:8px;}',
      '#mfp-palette .mfp-palette-row{display:flex;flex-wrap:wrap;gap:3px;width:227px;}',
      '#mfp-palette .mfp-palette-bases{margin-bottom:6px;flex-wrap:nowrap;}',
      '#mfp-palette .mfp-preset{appearance:none;box-sizing:border-box;width:20px;height:20px;border-radius:2px;border:1px solid rgba(0,0,0,.22);cursor:pointer;padding:0;flex-shrink:0;}',
      '#mfp-palette .mfp-preset.on{box-shadow:0 0 0 2px var(--mfp-accent);}',
      '#mfp-palette .mfp-palette-native{margin-top:8px;width:100%;height:28px;border:0;background:transparent;cursor:pointer;padding:0;}',
      '#mfp-panel .mfp-result{margin-top:6px;padding:0;background:transparent;}',
      '#mfp-panel .mfp-stat-card{margin:0 0 8px;padding:0;border:0;background:transparent;line-height:1.5;}',
      '#mfp-panel #mfp-upload-input{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}',
      '#mfp-panel .mfp-stats-line,#mfp-panel .mfp-ap-line{margin:0;font-size:12px;font-weight:400;color:var(--mfp-text);}',
      '#mfp-panel .mfp-ap-line{margin-top:2px;}',
      '#mfp-panel .mfp-stat-num{color:var(--mfp-stat-num);font-weight:700;}',
      '#mfp-panel .mfp-ap-break{display:block;font-size:11px;color:var(--mfp-muted);font-weight:400;margin-top:1px;line-height:1.35;}',
      '#mfp-panel .mfp-note{font-size:12px;color:var(--mfp-muted);margin:6px 0 0;}',
      '#mfp-panel details{margin-top:8px;}',
      '#mfp-panel summary.mfp-summary{cursor:pointer;color:var(--mfp-accent);font-size:13px;display:flex;align-items:center;gap:8px;list-style:none;}',
      '#mfp-panel summary.mfp-summary::-webkit-details-marker,#mfp-panel summary.mfp-summary::marker{display:none;content:none;}',
      '#mfp-panel summary.mfp-summary::before{content:"";display:inline-block;width:0;height:0;border-style:solid;border-width:5px 0 5px 7px;border-color:transparent transparent transparent var(--mfp-accent);flex-shrink:0;transform-origin:center;transition:transform .15s ease;}',
      '#mfp-panel details[open]>summary.mfp-summary::before{transform:rotate(90deg);}',
      '#mfp-panel details.mfp-section-locked>summary.mfp-summary{cursor:default;}',
      '#mfp-panel details.mfp-section-locked>summary.mfp-summary .mfp-summary-text,#mfp-panel details.mfp-section-locked>summary.mfp-summary::before{opacity:.7;}',
      '#mfp-panel .mfp-sync-form{flex-wrap:wrap;}',
      '#mfp-panel .mfp-sync-form input{flex:1 1 140px;}',
      '#mfp-panel summary.mfp-summary .mfp-summary-text{flex:1;min-width:0;}',
      '#mfp-panel .mfp-portal-link{appearance:none;border:0;background:transparent;color:var(--mfp-accent);cursor:pointer;padding:0;margin:0;font:inherit;text-decoration:underline;text-underline-offset:2px;text-align:left;}',
      '#mfp-panel .mfp-portal-link:hover,#mfp-panel .mfp-portal-link:focus{opacity:.85;outline:none;}',
      '#mfp-panel .mfp-throw-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:0;line-height:1.45;}',
      '#mfp-panel .mfp-fields-made{margin-left:6px;font-size:11px;font-weight:600;color:var(--mfp-accent,#3d9a5f);opacity:0.92;}',
      '#mfp-panel .mfp-copy-btn{appearance:none;border:0;background:var(--mfp-btn-bg);color:var(--mfp-btn-text);border-radius:7px;padding:4px 8px;font-size:12px;cursor:pointer;min-height:28px;flex-shrink:0;}',
      '#mfp-panel .mfp-ol,#mfp-panel .mfp-plain-list{margin:6px 0 0;padding:0;font-size:12px;}',
      '#mfp-panel .mfp-plain{margin:2px 0;font-size:12px;line-height:1.4;}',
      '#mfp-throws{max-height:min(42vh, 380px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:4px 8px 8px 8px;margin-top:4px;border:1px solid var(--mfp-input-border);border-radius:8px;}',
      '#mfp-panel .mfp-body,#mfp-panel .mfp-list,#mfp-throws,#mfp-panel .mfp-ol{scrollbar-width:thin;scrollbar-color:var(--mfp-scroll-thumb) var(--mfp-scroll-track);}',
      '#mfp-panel .mfp-body::-webkit-scrollbar,#mfp-panel .mfp-list::-webkit-scrollbar,#mfp-throws::-webkit-scrollbar,#mfp-panel .mfp-ol::-webkit-scrollbar{width:8px;height:8px;}',
      '#mfp-panel .mfp-body::-webkit-scrollbar-track,#mfp-panel .mfp-list::-webkit-scrollbar-track,#mfp-throws::-webkit-scrollbar-track,#mfp-panel .mfp-ol::-webkit-scrollbar-track{background:var(--mfp-scroll-track);border-radius:8px;}',
      '#mfp-panel .mfp-body::-webkit-scrollbar-thumb,#mfp-panel .mfp-list::-webkit-scrollbar-thumb,#mfp-throws::-webkit-scrollbar-thumb,#mfp-panel .mfp-ol::-webkit-scrollbar-thumb{background:var(--mfp-scroll-thumb);border-radius:8px;}',
      '#mfp-panel .mfp-station{margin-top:8px;padding:6px 0 0;border-top:1px solid var(--mfp-row-border);}',
      '#mfp-throws .mfp-station:first-child{margin-top:0;padding-top:2px;border-top:0;}',
      '#mfp-panel .mfp-station-title{font-size:13px;color:var(--mfp-station);font-weight:700;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 4px;}',
      '#mfp-panel .mfp-station-title .mfp-portal-link{color:var(--mfp-station);font-weight:700;}',
      '#mfp-panel .mfp-capture-tag{color:var(--mfp-muted);font-weight:500;}',
      '#mfp-toolbox-link.mfp-on{color:var(--mfp-accent);}',
      '.leaflet-tooltip.mfp-tip{background:rgba(14,20,22,.9);color:#ffe48a;border:0;font-size:11px;padding:2px 6px;box-shadow:none;}',
      '.mfp-walk-num{background:transparent;border:0;}',
      '.mfp-walk-num div{min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#ffd24a;color:#3a2a00;font:700 11px/18px Arial,sans-serif;text-align:center;box-shadow:0 0 0 1px rgba(0,0,0,.35);box-sizing:border-box;}',
      '#mfp-panel .mfp-controls{display:flex;flex-direction:column;gap:6px;margin:8px 0 4px;padding:6px 8px;border:1px solid var(--mfp-input-border);border-radius:8px;}',
      '#mfp-panel .mfp-ctrl-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '#mfp-panel .mfp-ctrl-label{font-size:12px;color:var(--mfp-muted);white-space:nowrap;}',
      '#mfp-panel .mfp-ctrl-value{font-size:13px;font-weight:700;color:var(--mfp-accent);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#mfp-panel .mfp-ctrl-btn{appearance:none;border:1px solid var(--mfp-tool-border);background:var(--mfp-tool-bg);color:var(--mfp-tool-text);border-radius:8px;padding:5px 8px;font-size:12px;font-weight:700;cursor:pointer;min-height:28px;flex:1;}',
      '#mfp-panel .mfp-ctrl-btn.on{background:var(--mfp-accent-btn);border-color:var(--mfp-accent-btn);color:var(--mfp-accent-btn-text);}',
      '#mfp-panel .mfp-ctrl-btn:disabled{opacity:.45;cursor:default;}',
      '#mfp-panel .mfp-ctrl-btn.mfp-dir{flex:1;min-height:34px;}',
      '#mfp-panel #mfp-dir-row .mfp-sbul{flex:0 0 auto;margin-right:4px;}',
      '#mfp-panel .mfp-key-line{display:flex;align-items:baseline;gap:0;flex-wrap:wrap;line-height:1.55;}',
      '#mfp-panel .mfp-keys-short{color:var(--mfp-danger-text);font-weight:700;}',
      '#mfp-panel .mfp-keys-hint{font-size:12px;color:var(--mfp-muted);margin:4px 0 2px;line-height:1.4;}',
      '#mfp-panel .mfp-sbul{display:inline-flex;align-items:center;gap:6px;flex:1;}',
      '#mfp-panel .mfp-sbul-val{min-width:1.6em;text-align:center;font-weight:700;}',
      '#mfp-panel .mfp-sbul-btn{min-width:34px;flex:0 0 auto;}',
      '#mfp-panel .mfp-warn{color:var(--mfp-danger-text);font-size:12px;margin-top:4px;line-height:1.4;}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'mfp-style';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  };


  self.isMobile = function () {
    try {
      if (typeof window.isSmartphone === 'function' && window.isSmartphone()) return true;
      if (typeof window.useAndroidPanes === 'function' && window.useAndroidPanes()) return true;
    } catch (e) {}
    if (window.innerWidth && window.innerWidth <= 720) return true;
    return /IITCMobile|Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
  };

  self.getTabPos = function () {
    try {
      var raw = localStorage.getItem(self.TAB_POS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && (p.edge === 'left' || p.edge === 'right' || p.edge === 'top' || p.edge === 'bottom') && typeof p.ratio === 'number' && isFinite(p.ratio)) {
          return { edge: p.edge, ratio: Math.max(0, Math.min(1, p.ratio)) };
        }
      }
    } catch (e) {}
    return { edge: 'right', ratio: 0.42 };
  };

  self.saveTabPos = function (pos) {
    try { localStorage.setItem(self.TAB_POS_KEY, JSON.stringify(pos)); } catch (e) {}
  };

  self.applyTabPos = function (tab, pos) {
    tab = tab || document.getElementById('mfp-tab');
    if (!tab) return;
    pos = pos || self.getTabPos();
    var edges = ['left', 'right', 'top', 'bottom'];
    for (var i = 0; i < edges.length; i++) {
      tab.classList.remove('mfp-edge-' + edges[i]);
    }
    tab.classList.add('mfp-edge-' + pos.edge);
    tab.style.left = '';
    tab.style.right = '';
    tab.style.top = '';
    tab.style.bottom = '';
    var margin = 8;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var w = tab.offsetWidth || 30;
    var h = tab.offsetHeight || 92;
    if (pos.edge === 'left' || pos.edge === 'right') {
      var spanY = Math.max(0, vh - h - margin * 2);
      tab.style.top = Math.round(margin + pos.ratio * spanY) + 'px';
      if (pos.edge === 'right') tab.style.right = '0px';
      else tab.style.left = '0px';
    } else {
      var spanX = Math.max(0, vw - w - margin * 2);
      tab.style.left = Math.round(margin + pos.ratio * spanX) + 'px';
      if (pos.edge === 'top') tab.style.top = '0px';
      else tab.style.bottom = '0px';
    }
  };

  self.bindTabDrag = function (tab) {
    if (!tab || tab.getAttribute('data-mfp-drag') === '1') return;
    tab.setAttribute('data-mfp-drag', '1');
    var dragging = false;
    var moved = false;
    var startX = 0, startY = 0, startLeft = 0, startTop = 0, startW = 0, startH = 0;
    var THRESH = 8;

    function evPoint(e) {
      var src = e;
      if (e.touches && e.touches[0]) src = e.touches[0];
      else if (e.changedTouches && e.changedTouches[0]) src = e.changedTouches[0];
      return { x: src.clientX, y: src.clientY };
    }

    function nearestEdge(x, y, w, h, vw, vh) {
      var cx = x + w / 2, cy = y + h / 2;
      var list = [
        { edge: 'left', d: cx },
        { edge: 'right', d: vw - cx },
        { edge: 'top', d: cy },
        { edge: 'bottom', d: vh - cy }
      ];
      list.sort(function (a, b) { return a.d - b.d; });
      return list[0].edge;
    }

    function addEvt(el, typ, fn, wantCancel) {
      if (!wantCancel) {
        el.addEventListener(typ, fn, false);
        return;
      }
      try {
        el.addEventListener(typ, fn, { passive: false });
      } catch (err) {
        el.addEventListener(typ, fn, false);
      }
    }

    function onDown(e) {
      if (e.type === 'mousedown' && e.button !== 0) return;
      var p = evPoint(e);
      var rect = tab.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = p.x;
      startY = p.y;
      startLeft = rect.left;
      startTop = rect.top;
      startW = rect.width;
      startH = rect.height;
      if (e.pointerId != null && tab.setPointerCapture) {
        try { tab.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }

    function onMove(e) {
      if (!dragging) return;
      var p = evPoint(e);
      var dx = p.x - startX, dy = p.y - startY;
      if (!moved && (dx * dx + dy * dy) < THRESH * THRESH) return;
      moved = true;
      self._tabDidDrag = true;
      if (e.cancelable) e.preventDefault();
      tab.classList.add('mfp-dragging');
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var x = Math.max(0, Math.min(Math.max(0, vw - startW), startLeft + dx));
      var y = Math.max(0, Math.min(Math.max(0, vh - startH), startTop + dy));
      tab.style.left = Math.round(x) + 'px';
      tab.style.top = Math.round(y) + 'px';
      tab.style.right = 'auto';
      tab.style.bottom = 'auto';
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      tab.classList.remove('mfp-dragging');
      if (!moved) return;
      if (e && e.cancelable) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      var rect = tab.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var edge = nearestEdge(rect.left, rect.top, rect.width, rect.height, vw, vh);
      var margin = 8;
      var ratio = 0.5;
      if (edge === 'left' || edge === 'right') {
        ratio = (rect.top - margin) / Math.max(1, vh - rect.height - margin * 2);
      } else {
        ratio = (rect.left - margin) / Math.max(1, vw - rect.width - margin * 2);
      }
      var pos = { edge: edge, ratio: Math.max(0, Math.min(1, ratio)) };
      self.saveTabPos(pos);
      self.applyTabPos(tab, pos);
    }

    tab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (self._tabDidDrag) {
        self._tabDidDrag = false;
        return;
      }
      self.openPanel();
    });

    if (typeof window.PointerEvent !== 'undefined') {
      addEvt(tab, 'pointerdown', onDown, false);
      addEvt(tab, 'pointermove', onMove, true);
      addEvt(tab, 'pointerup', onUp, true);
      addEvt(tab, 'pointercancel', onUp, false);
    } else {
      addEvt(tab, 'mousedown', onDown, false);
      addEvt(tab, 'touchstart', onDown, true);
      addEvt(document, 'mousemove', onMove, false);
      addEvt(document, 'touchmove', onMove, true);
      addEvt(document, 'mouseup', onUp, false);
      addEvt(document, 'touchend', onUp, true);
      addEvt(document, 'touchcancel', onUp, false);
    }
  };


  self.makeDraggable = function () {
    var panel = document.getElementById('mfp-panel');
    var header = document.getElementById('mfp-header');
    if (!panel || !header) return;
    var dragging = false;
    var sx = 0, sy = 0, sl = 0, st = 0;
    function start(x, y) {
      if (self.isMobile()) return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      sx = x; sy = y; sl = rect.left; st = rect.top;
      panel.style.right = 'auto';
      panel.style.left = sl + 'px';
      panel.style.top = st + 'px';
    }
    function move(x, y) {
      if (!dragging) return;
      var nx = sl + (x - sx);
      var ny = st + (y - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 80, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    }
    function end() { dragging = false; }
    header.addEventListener('mousedown', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('.mfp-iconbtn')) return;
      start(e.clientX, e.clientY);
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
    document.addEventListener('mouseup', end);
  };


  self.bindPanelResize = function () {
    var panel = document.getElementById('mfp-panel');
    if (!panel || panel.getAttribute('data-resize-bound') === '1') return;
    panel.setAttribute('data-resize-bound', '1');
    var handleW = document.getElementById('mfp-resize');
    var handleS = document.getElementById('mfp-resize-s');
    var handleSE = document.getElementById('mfp-resize-se');
    var dragging = false;
    var edge = 'w';
    var startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0, startTop = 0;

    function evPoint(e) {
      if (e.touches && e.touches[0]) return e.touches[0];
      if (e.changedTouches && e.changedTouches[0]) return e.changedTouches[0];
      return e;
    }
    function pinLeftTop(rect) {
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
    }
    function startFor(which) {
      return function (e) {
        if (self.isMobile() || self.state.minimized) return;
        var ev = evPoint(e);
        var rect = panel.getBoundingClientRect();
        dragging = true;
        self._resizing = true;
        edge = which;
        startX = ev.clientX;
        startY = ev.clientY;
        startW = rect.width;
        startH = rect.height;
        startLeft = rect.left;
        startTop = rect.top;
        pinLeftTop(rect);
        self.closePalette();
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
      };
    }
    function onMove(e) {
      if (!dragging) return;
      var ev = evPoint(e);
      if (edge === 'w' || edge === 'se') {
        var dw = edge === 'w' ? (startX - ev.clientX) : (ev.clientX - startX);
        var nextW = self.clampPanelWidth(startW + dw);
        panel.style.width = nextW + 'px';
        if (edge === 'w') {
          var nx = startLeft + (startW - nextW);
          if (nx < 0) nx = 0;
          panel.style.left = nx + 'px';
        }
      }
      if (edge === 's' || edge === 'se') {
        var nextH = self.clampPanelHeight(startH + (ev.clientY - startY), startTop);
        panel.style.height = nextH + 'px';
      }
      if (e.preventDefault) e.preventDefault();
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      self._resizing = false;
      var rect = panel.getBoundingClientRect();
      if (edge === 'w' || edge === 'se') self.setPanelWidth(rect.width);
      if (edge === 's' || edge === 'se') self.setPanelHeight(rect.height, rect.top);
      self.applyPanelSize();
    }
    function bindHandle(el, which) {
      if (!el) return;
      el.addEventListener('mousedown', startFor(which));
      el.addEventListener('touchstart', startFor(which), { passive: false });
      el.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
      });
    }
    bindHandle(handleW, 'w');
    bindHandle(handleS, 's');
    bindHandle(handleSE, 'se');
    function resetHeight(e) {
      if (self.isMobile() || self.state.minimized) return;
      self.clearPanelHeight();
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    if (handleS) handleS.addEventListener('dblclick', resetHeight);
    if (handleSE) handleSE.addEventListener('dblclick', resetHeight);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  };


  self.updatePanelChrome = function () {
    var panel = document.getElementById('mfp-panel');
    var tab = document.getElementById('mfp-tab');
    var mobile = self.isMobile();
    self.applyTheme();
    if (panel) {
      panel.classList.toggle('mfp-mobile', mobile);
      panel.classList.toggle('mfp-desktop', !mobile);
      panel.classList.toggle('mfp-min', !!self.state.minimized);
      panel.style.display = self.state.open ? 'flex' : 'none';
      if (mobile && self.state.open && !self.state.minimized) {
        panel.style.flexDirection = 'column';
      }
      self.applyPanelSize();
    }
    if (tab) {
      tab.classList.toggle('mfp-mobile', mobile);
      tab.style.display = self.state.open ? 'none' : 'flex';
      if (!self.state.open) self.applyTabPos(tab);
    }
    self.applyChrome();
    var link = document.getElementById('mfp-toolbox-link');
    if (link) {
      if (self.state.open) link.classList.add('mfp-on');
      else link.classList.remove('mfp-on');
    }
  };


  self.openPanel = function () {
    self.buildPanel();
    self.state.open = true;
    self.state.minimized = false;
    self.updatePanelChrome();
    self.render();
  };

  self.closePanel = function () {
    self.closePalette();
    self.state.open = false;
    self.state.minimized = false;
    self.updatePanelChrome();
  };

  self.togglePanel = function () {
    if (self.state.open) self.closePanel();
    else self.openPanel();
  };



  self.portalName = function (pt) {
    if (!pt) return '';
    return pt.name || pt.id || '';
  };

  self.portalGuid = function (pt) {
    if (!pt) return null;
    return pt.guid || pt.id || null;
  };


  self.jumpToPortal = function (pt) {
    if (!pt) return;
    var guid = self.portalGuid(pt);
    var lat = pt.lat;
    var lng = pt.lng;
    try {
      if ((lat == null || lng == null) && window.portals && guid && window.portals[guid]) {
        var p = window.portals[guid];
        var ll = null;
        if (p && typeof p.getLatLng === 'function') ll = p.getLatLng();
        else if (p && p._latlng) ll = p._latlng;
        if (ll) {
          lat = ll.lat;
          lng = ll.lng;
        }
      }
    } catch (e0) {}
    if (!guid && (lat == null || lng == null)) return;

    self._ignorePortalSelect = true;
    if (self._ignorePortalSelectTimer) {
      clearTimeout(self._ignorePortalSelectTimer);
      self._ignorePortalSelectTimer = null;
    }
    try {
      var map = window.map;
      if (map && lat != null && lng != null) {
        if (typeof map.panTo === 'function') map.panTo([lat, lng]);
        else if (typeof map.setView === 'function') {
          var zoom = (typeof map.getZoom === 'function') ? map.getZoom() : undefined;
          if (zoom != null) map.setView([lat, lng], zoom);
          else map.setView([lat, lng]);
        }
      }
      if (guid && typeof window.selectPortal === 'function') window.selectPortal(guid);
      if (guid && typeof window.renderPortalDetails === 'function') window.renderPortalDetails(guid);
      if (guid && window.portalDetail && typeof window.portalDetail.request === 'function') {
        window.portalDetail.request(guid);
      }
    } catch (e) {}
    self._ignorePortalSelectTimer = setTimeout(function () {
      self._ignorePortalSelect = false;
      self._ignorePortalSelectTimer = null;
    }, 800);
  };

  self.portalJumpControl = function (pt) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mfp-portal-link';
    btn.textContent = self.portalName(pt);
    if (pt && (self.portalGuid(pt) || (pt.lat != null && pt.lng != null))) {
      btn.title = self.t('jumpTo');
      btn.addEventListener('click', function (e) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        self.jumpToPortal(pt);
      });
    } else {
      btn.disabled = true;
    }
    return btn;
  };

  self.addClass = function (el, name) {
    if (!el) return;
    var cur = el.className ? String(el.className).split(/\s+/) : [];
    if (cur.indexOf(name) === -1) cur.push(name);
    el.className = cur.join(' ').replace(/^\s+|\s+$/g, '');
  };

  self.removeClass = function (el, name) {
    if (!el) return;
    var cur = el.className ? String(el.className).split(/\s+/) : [];
    var next = [];
    for (var i = 0; i < cur.length; i++) {
      if (cur[i] && cur[i] !== name) next.push(cur[i]);
    }
    el.className = next.join(' ');
  };

  self.focusPortalInList = function (id) {
    if (id == null || id === '') return false;
    if (!self.state.open) return false;
    var panel = document.getElementById('mfp-panel');
    if (!panel) return false;
    var rows = panel.querySelectorAll('.mfp-row[data-portal-id]');
    var target = null;
    var key = String(id);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-portal-id')) === key) {
        target = rows[i];
        break;
      }
    }
    if (!target) return false;
    var prev = panel.querySelectorAll('.mfp-row.mfp-locate');
    for (var j = 0; j < prev.length; j++) self.removeClass(prev[j], 'mfp-locate');
    self.addClass(target, 'mfp-locate');
    if (typeof target.scrollIntoView === 'function') {
      try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      catch (e1) { try { target.scrollIntoView(false); } catch (e2) {} }
    }
    if (self._locateTimer) clearTimeout(self._locateTimer);
    self._locateTimer = setTimeout(function () {
      self.removeClass(target, 'mfp-locate');
      self._locateTimer = null;
    }, 2600);
    return true;
  };


  self.walkArrowLatLngs = function (from, to) {
    if (!from || !to) return null;
    var t = 0.68;
    var sizePx = 11;
    var map = window.map;
    if (map && map.latLngToLayerPoint && map.layerPointToLatLng && typeof L !== 'undefined') {
      var p1 = map.latLngToLayerPoint(L.latLng(from.lat, from.lng));
      var p2 = map.latLngToLayerPoint(L.latLng(to.lat, to.lng));
      var dx = p2.x - p1.x, dy = p2.y - p1.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 10) return null;
      var mx = p1.x + dx * t, my = p1.y + dy * t;
      var ang = Math.atan2(dy, dx);
      var tip = map.layerPointToLatLng(L.point(mx + Math.cos(ang) * sizePx, my + Math.sin(ang) * sizePx));
      var left = map.layerPointToLatLng(L.point(mx + Math.cos(ang + Math.PI * 0.82) * sizePx * 0.75, my + Math.sin(ang + Math.PI * 0.82) * sizePx * 0.75));
      var right = map.layerPointToLatLng(L.point(mx + Math.cos(ang - Math.PI * 0.82) * sizePx * 0.75, my + Math.sin(ang - Math.PI * 0.82) * sizePx * 0.75));
      return [[tip.lat, tip.lng], [left.lat, left.lng], [right.lat, right.lng]];
    }
    var cos = Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180) || 1;
    var midLat = from.lat + (to.lat - from.lat) * t;
    var midLng = from.lng + (to.lng - from.lng) * t;
    var dLat = to.lat - from.lat;
    var dLng = (to.lng - from.lng) * cos;
    var ang2 = Math.atan2(dLat, dLng);
    var deg = 0.00018;
    function off(dist, a) {
      return [midLat + Math.sin(a) * dist, midLng + Math.cos(a) * dist / cos];
    }
    return [off(deg, ang2), off(deg * 0.75, ang2 + Math.PI * 0.82), off(deg * 0.75, ang2 - Math.PI * 0.82)];
  };

  self.drawWalkRoute = function (plan) {
    if (!plan || !self.planLayer || typeof L === 'undefined') return;
    if (!self.getWalkVisible()) return;
    var stations = self.planStations(plan);
    if (stations.length >= 2) {
      var latlngs = [];
      var i;
      var walkHex = self.getWalkHex();
      var walkStroke = self.getWalkStroke();
      for (i = 0; i < stations.length; i++) {
        if (!stations[i] || !stations[i].portal) continue;
        latlngs.push([stations[i].portal.lat, stations[i].portal.lng]);
      }
      if (latlngs.length >= 2) {
        self.planLayer.addLayer(L.polyline(latlngs, {
          color: walkStroke,
          weight: 3,
          opacity: 0.95,
          interactive: false,
          lineJoin: 'round',
          lineCap: 'round'
        }));
        for (i = 0; i < stations.length - 1; i++) {
          var pts = self.walkArrowLatLngs(stations[i].portal, stations[i + 1].portal);
          if (!pts) continue;
          self.planLayer.addLayer(L.polygon(pts, {
            color: self.darkenHex(walkHex, 0.72),
            weight: 1,
            opacity: 1,
            fillColor: walkHex,
            fillOpacity: 0.96,
            interactive: false
          }));
        }
      }
    }
  };

  self.drawWalkNumbers = function (plan) {
    if (!plan || !self.markerLayer || typeof L === 'undefined') return;
    if (!self.getWalkVisible()) return;
    var stations = self.planStations(plan);
    var walkHex = self.getWalkHex();
    var textColor = self.contrastText(walkHex);
    for (var n = 0; n < stations.length; n++) {
      var st = stations[n] && stations[n].portal;
      if (!st) continue;
      var icon = L.divIcon({
        className: 'mfp-walk-num',
        html: '<div style="background:' + walkHex + ';color:' + textColor + ';">' + (n + 1) + '</div>',
        iconSize: [24, 18],
        iconAnchor: [12, 9]
      });
      self.markerLayer.addLayer(L.marker([st.lat, st.lng], {
        icon: icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 700
      }));
    }
  };


  self.applyChrome = function () {
    var title = document.getElementById('mfp-title');
    if (title) {
      var nameEl = title.querySelector('.mfp-title-name');
      var verEl = title.querySelector('.mfp-version');
      if (!nameEl || !verEl) {
        title.textContent = '';
        nameEl = document.createElement('span');
        nameEl.className = 'mfp-title-name';
        verEl = document.createElement('span');
        verEl.className = 'mfp-version';
        title.appendChild(nameEl);
        title.appendChild(verEl);
      }
      nameEl.textContent = self.t('title');
      verEl.textContent = self.VERSION || '';
    }
    var langBtn = document.getElementById('mfp-lang');
    if (langBtn) {
      var isZh = self.getLang() === 'zh';
      langBtn.textContent = isZh ? 'EN' : '中';
      langBtn.title = self.t('langTitle');
    }
    var themeBtn = document.getElementById('mfp-theme');
    if (themeBtn) {
      var isDark = self.getTheme() === 'dark';
      themeBtn.textContent = isDark ? '亮' : '暗';
      themeBtn.title = isDark ? self.t('themeTitleLight') : self.t('themeTitleDark');
    }
    var minBtn = document.getElementById('mfp-min');
    if (minBtn) {
      minBtn.textContent = self.state.minimized ? '+' : '–';
      minBtn.title = self.state.minimized ? self.t('expand') : self.t('min');
    }
    var closeBtn = document.getElementById('mfp-close');
    if (closeBtn) closeBtn.title = self.t('close');
    var fl = document.getElementById('mfp-field-color-label');
    if (fl) fl.textContent = self.t('fieldColor');
    var ll = document.getElementById('mfp-link-color-label');
    if (ll) ll.textContent = self.t('linkColor');
    var fieldSw = document.getElementById('mfp-field-swatch');
    if (fieldSw) fieldSw.title = self.t('fieldColor');
    var linkSw = document.getElementById('mfp-link-swatch');
    if (linkSw) linkSw.title = self.t('linkColor');
    var wl = document.getElementById('mfp-walk-color-label');
    if (wl) wl.textContent = self.t('walkColor');
    var walkSw = document.getElementById('mfp-walk-swatch');
    if (walkSw) walkSw.title = self.t('walkColor');
    var fvb = document.getElementById('mfp-field-visible');
    if (fvb) fvb.title = self.t('showField');
    var lvb = document.getElementById('mfp-link-visible');
    if (lvb) lvb.title = self.t('showLink');
    var wvb = document.getElementById('mfp-walk-visible');
    if (wvb) wvb.title = self.t('showWalk');
    self.updateWalkToggle();
    var resizeIds = ['mfp-resize', 'mfp-resize-s', 'mfp-resize-se'];
    for (var ri = 0; ri < resizeIds.length; ri++) {
      var resizeEl = document.getElementById(resizeIds[ri]);
      if (resizeEl) resizeEl.title = self.t('resizeHint');
    }
    var planBtn = document.getElementById('mfp-plan');
    if (planBtn) planBtn.textContent = self.t('planLink');
    var clearPlan = document.getElementById('mfp-clear-plan');
    if (clearPlan) clearPlan.textContent = self.t('clearPlan');
    var clearAll = document.getElementById('mfp-clear-all');
    if (clearAll) clearAll.textContent = self.t('clearAll');
    var dlBtn = document.getElementById('mfp-download');
    if (dlBtn) dlBtn.textContent = self.t('download');
    var upBtn = document.getElementById('mfp-upload');
    if (upBtn) upBtn.textContent = self.t('upload');
    var favBtn = document.getElementById('mfp-fav-save');
    if (favBtn) favBtn.textContent = self.t('favorite');
    var favOk = document.getElementById('mfp-fav-confirm');
    if (favOk) favOk.textContent = self.t('favConfirm');
    var favCancel = document.getElementById('mfp-fav-cancel');
    if (favCancel) favCancel.textContent = self.t('favCancel');
    var favName = document.getElementById('mfp-fav-name');
    if (favName) favName.placeholder = self.t('favNamePlaceholder');
    var syncSave = document.getElementById('mfp-sync-save');
    if (syncSave) syncSave.textContent = self.t('syncSave');
    var syncClear = document.getElementById('mfp-sync-clear');
    if (syncClear) syncClear.textContent = self.t('syncClear');
    var syncCancel = document.getElementById('mfp-sync-cancel');
    if (syncCancel) syncCancel.textContent = self.t('favCancel');
    var syncTok = document.getElementById('mfp-sync-token');
    if (syncTok) syncTok.placeholder = self.getSyncToken() ? self.t('syncTokenSavedPh') : self.t('syncTokenPh');
    var syncGist = document.getElementById('mfp-sync-gist');
    if (syncGist) syncGist.placeholder = self.t('syncGistPh');
    var tab = document.getElementById('mfp-tab');
    if (tab) {
      tab.textContent = self.t('tab');
      tab.title = self.t('tabTitle');
    }
    var link = document.getElementById('mfp-toolbox-link');
    if (link) link.textContent = self.t('toolbox');
    self.syncControlLabels();
  };

  self.syncControlLabels = function () {
    var setTxt = function (id, key) {
      var el = document.getElementById(id);
      if (el) el.textContent = self.t(key);
    };
    setTxt('mfp-anchor-label', 'anchorNow');
    setTxt('mfp-sbul-label', 'sbul');
    var sbul = document.getElementById('mfp-sbul-row');
    if (sbul) sbul.title = self.t('sbulHint');
    var dirBtn = document.getElementById('mfp-star-dir');
    if (dirBtn) dirBtn.title = self.t('starDirHint');
    self.renderControls();
  };

  self.buildTab = function () {
    if (document.getElementById('mfp-tab')) return;
    var tab = document.createElement('div');
    tab.id = 'mfp-tab';
    tab.textContent = self.t('tab');
    tab.title = self.t('tabTitle');
    tab.addEventListener('click', function () { /* drag binder owns click */ });
    document.body.appendChild(tab);
    self.applyTheme();
    self.bindTabDrag(tab);
    self.applyTabPos(tab);
  };

  self.buildPanel = function () {
    if (document.getElementById('mfp-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'mfp-panel';
    panel.innerHTML = [
      '<div class="mfp-resize mfp-resize-w" id="mfp-resize" title=""></div>',
      '<div class="mfp-resize-s" id="mfp-resize-s" title=""></div>',
      '<div class="mfp-resize-se" id="mfp-resize-se" title=""></div>',
      '<div class="mfp-header" id="mfp-header">',
      '  <div class="mfp-title" id="mfp-title"></div>',
      '  <button type="button" class="mfp-iconbtn mfp-langbtn" id="mfp-lang">EN</button>',
      '  <button type="button" class="mfp-iconbtn mfp-themebtn" id="mfp-theme">亮</button>',
      '  <button type="button" class="mfp-iconbtn" id="mfp-min">–</button>',
      '  <button type="button" class="mfp-iconbtn" id="mfp-close">×</button>',
      '</div>',
      '<div class="mfp-body" id="mfp-body">',
      '  <div class="mfp-step" id="mfp-step"></div>',
      '  <div class="mfp-list-head" id="mfp-list-head"></div>',
      '  <div id="mfp-list" class="mfp-list"></div>',
      '  <div class="mfp-controls" id="mfp-controls">',
      '    <div class="mfp-ctrl-row">',
      '      <span class="mfp-ctrl-label" id="mfp-anchor-label"></span>',
      '      <span class="mfp-ctrl-value" id="mfp-anchor-name"></span>',
      '      <span class="mfp-badge b" id="mfp-anchor-pos"></span>',
      '    </div>',
      '    <div class="mfp-ctrl-row" id="mfp-dir-row">',
      '      <div class="mfp-sbul" id="mfp-sbul-row">',
      '        <span class="mfp-ctrl-label" id="mfp-sbul-label"></span>',
      '        <button type="button" class="mfp-ctrl-btn mfp-sbul-btn" id="mfp-sbul-minus">−</button>',
      '        <span class="mfp-sbul-val" id="mfp-sbul-val">2</span>',
      '        <button type="button" class="mfp-ctrl-btn mfp-sbul-btn" id="mfp-sbul-plus">+</button>',
      '      </div>',
      '      <button type="button" class="mfp-ctrl-btn mfp-dir" id="mfp-star-dir"></button>',
      '    </div>',
      '  </div>',
      '  <div class="mfp-colors" id="mfp-colors">',
      '    <span class="mfp-color-item"><span id="mfp-field-color-label"></span>',
      '    <button type="button" class="mfp-swatch" id="mfp-field-swatch"></button>',
      '    <input type="checkbox" class="mfp-vis-box" id="mfp-field-visible"></span>',
      '    <span class="mfp-color-item"><span id="mfp-link-color-label"></span>',
      '    <button type="button" class="mfp-swatch" id="mfp-link-swatch"></button>',
      '    <input type="checkbox" class="mfp-vis-box" id="mfp-link-visible"></span>',
      '    <span class="mfp-color-item"><span id="mfp-walk-color-label"></span>',
      '    <button type="button" class="mfp-swatch" id="mfp-walk-swatch"></button>',
      '    <input type="checkbox" class="mfp-vis-box" id="mfp-walk-visible"></span>',
      '  </div>',
      '  <div class="mfp-actions">',
      '    <button type="button" class="mfp-btn primary" id="mfp-plan"></button>',
      '    <button type="button" class="mfp-btn secondary" id="mfp-clear-plan"></button>',
      '    <button type="button" class="mfp-btn danger" id="mfp-clear-all"></button>',
      '  </div>',
      '  <div class="mfp-actions mfp-plan-tools" id="mfp-plan-tools">',
      '    <button type="button" class="mfp-btn secondary" id="mfp-download"></button>',
      '    <button type="button" class="mfp-btn secondary" id="mfp-upload"></button>',
      '    <button type="button" class="mfp-btn secondary" id="mfp-fav-save"></button>',
      '    <input type="file" id="mfp-upload-input" accept=".json,application/json,text/plain">',
      '  </div>',
      '  <div class="mfp-fav-form" id="mfp-fav-form">',
      '    <input type="text" id="mfp-fav-name" maxlength="80" autocomplete="off">',
      '    <button type="button" class="mfp-copy-btn" id="mfp-fav-confirm"></button>',
      '    <button type="button" class="mfp-copy-btn" id="mfp-fav-cancel"></button>',
      '  </div>',
      '  <div id="mfp-result"></div>',
      '  <div class="mfp-fav-form mfp-sync-form" id="mfp-sync-form">',
      '    <input type="password" id="mfp-sync-token" autocomplete="off" autocapitalize="off" spellcheck="false">',
      '    <input type="text" id="mfp-sync-gist" autocomplete="off" autocapitalize="off" spellcheck="false">',
      '    <button type="button" class="mfp-copy-btn" id="mfp-sync-save"></button>',
      '    <button type="button" class="mfp-copy-btn" id="mfp-sync-clear"></button>',
      '    <button type="button" class="mfp-copy-btn" id="mfp-sync-cancel"></button>',
      '  </div>',
      '  <div id="mfp-fav-box"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(panel);

    document.getElementById('mfp-lang').addEventListener('click', function (e) {
      e.stopPropagation();
      self.setLang(self.getLang() === 'zh' ? 'en' : 'zh');
    });
    document.getElementById('mfp-theme').addEventListener('click', function (e) {
      e.stopPropagation();
      self.setTheme(self.getTheme() === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('mfp-min').addEventListener('click', function (e) {
      e.stopPropagation();
      self.state.minimized = !self.state.minimized;
      self.updatePanelChrome();
    });
    document.getElementById('mfp-close').addEventListener('click', function (e) {
      e.stopPropagation();
      self.closePanel();
    });
    document.getElementById('mfp-plan').addEventListener('click', function () { self.clickPlan(); });
    document.getElementById('mfp-clear-plan').addEventListener('click', function () { self.clearPlan(true); });
    document.getElementById('mfp-clear-all').addEventListener('click', function () { self.clearAll(); });
    document.getElementById('mfp-download').addEventListener('click', function () { self.downloadDrawTools(); });
    document.getElementById('mfp-upload').addEventListener('click', function () { self.pickBookmarkFile(); });
    document.getElementById('mfp-upload-input').addEventListener('change', function (e) { self.onBookmarkFile(e); });
    document.getElementById('mfp-fav-save').addEventListener('click', function () { self.openFavoriteForm(); });
    document.getElementById('mfp-fav-confirm').addEventListener('click', function () { self.confirmFavorite(); });
    document.getElementById('mfp-fav-cancel').addEventListener('click', function () { self.closeFavoriteForm(); });
    document.getElementById('mfp-sync-save').addEventListener('click', function () { self.saveSyncSettings(); });
    document.getElementById('mfp-sync-clear').addEventListener('click', function () { self.clearSyncSettings(); });
    document.getElementById('mfp-sync-cancel').addEventListener('click', function () { self.closeSyncForm(); });
    document.getElementById('mfp-sync-token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        if (e.preventDefault) e.preventDefault();
        self.saveSyncSettings();
      }
    });
    document.getElementById('mfp-fav-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        if (e.preventDefault) e.preventDefault();
        self.confirmFavorite();
      } else if (e.key === 'Escape' || e.keyCode === 27) {
        self.closeFavoriteForm();
      }
    });
    function bindSwatch(id, which) {
      document.getElementById(id).addEventListener('click', function (e) {
        e.stopPropagation();
        if (document.getElementById('mfp-palette') && document.getElementById('mfp-palette').getAttribute('data-which') === which) {
          self.closePalette();
          return;
        }
        self.openPalette(which, this);
        var pop = document.getElementById('mfp-palette');
        if (pop) pop.setAttribute('data-which', which);
      });
    }
    bindSwatch('mfp-field-swatch', 'field');
    bindSwatch('mfp-link-swatch', 'link');
    bindSwatch('mfp-walk-swatch', 'walk');
    ['field', 'link', 'walk'].forEach(function (which) {
      var box = document.getElementById('mfp-' + which + '-visible');
      box.addEventListener('change', function () {
        self.setLayerVisible(which, this.checked);
      });
      box.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    });

    document.getElementById('mfp-star-dir').addEventListener('click', function () {
      var inbound = self.state.stardirection !== self.STAR_DIR.RADIATING;
      self.setStarDirection(inbound ? self.STAR_DIR.RADIATING : self.STAR_DIR.CENTRALIZING);
    });
    document.getElementById('mfp-sbul-minus').addEventListener('click', function () { self.changeSBUL(-1); });
    document.getElementById('mfp-sbul-plus').addEventListener('click', function () { self.changeSBUL(1); });

    self.makeDraggable();
    self.bindPanelResize();
    self.applyTheme();
    self.applyChrome();
    self.applyPanelSize();
    self.updateColorSwatches();
  };

  self.fmtAp = function (n) {
    n = Math.round(n || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  self.appendStatNum = function (el, text, extraClass) {
    var s = document.createElement('span');
    s.className = extraClass ? ('mfp-stat-num ' + extraClass) : 'mfp-stat-num';
    s.textContent = String(text);
    el.appendChild(s);
    return s;
  };

  self.appendStatItem = function (el, num, unit, tail) {
    self.appendStatNum(el, num);
    if (unit) el.appendChild(document.createTextNode(' ' + unit));
    if (tail) el.appendChild(document.createTextNode(tail));
  };

  self.appendWalkStat = function (el, meters) {
    if (meters == null || !isFinite(meters)) return;
    var km = meters >= 1000;
    var val = km ? (meters / 1000).toFixed(2) : String(Math.round(meters));
    el.appendChild(document.createTextNode(self.getLang() === 'en' ? 'Walk ~' : '步行约 '));
    self.appendStatNum(el, val);
    el.appendChild(document.createTextNode(km ? ' km' : ' m'));
  };

  self.fmtWalk = function (meters) {
    if (meters == null || !isFinite(meters)) return '';
    if (meters >= 1000) return self.t('walkKm', (meters / 1000).toFixed(2));
    return self.t('walkM', Math.round(meters));
  };

  self.walkPart = function (plan) {
    if (!plan || plan.walkMeters == null) return '';
    var text = self.fmtWalk(plan.walkMeters);
    return text ? (self.t('walkSep') + text) : '';
  };

  self.normalizeTeam = function (t) {
    if (t == null) return 'N';
    if (typeof t === 'number') {
      if (typeof window.TEAM_RES === 'number' && t === window.TEAM_RES) return 'R';
      if (typeof window.TEAM_ENL === 'number' && t === window.TEAM_ENL) return 'E';
      if (typeof window.TEAM_MAC === 'number' && t === window.TEAM_MAC) return 'M';
      if (t === 1) return 'R';
      if (t === 2) return 'E';
      if (t === 3) return 'M';
      return 'N';
    }
    var s = String(t).toUpperCase();
    if (s === 'R' || s === 'RESISTANCE' || s.indexOf('RES') === 0) return 'R';
    if (s === 'E' || s === 'ENLIGHTENED' || s.indexOf('ENL') === 0) return 'E';
    if (s === 'M' || s.indexOf('MAC') === 0) return 'M';
    if (s === 'N' || s === 'NEUTRAL' || s === 'NONE') return 'N';
    return 'N';
  };

  self.playerTeam = function () {
    try {
      if (window.PLAYER && window.PLAYER.team != null) return self.normalizeTeam(window.PLAYER.team);
    } catch (e) {}
    return null;
  };

  self.portalCaptureInfo = function (pt) {
    var AP_CAPTURE = 625;
    var AP_RESO = 125;
    var SLOTS = 8;
    var info = { known: false, unknown: true, capture: false, deploy: 0, captureAp: 0, deployAp: 0 };
    if (!pt) return info;
    var p = window.portals && window.portals[pt.guid || pt.id];
    if (!p) {
      info.capture = true;
      info.deploy = SLOTS;
      info.captureAp = AP_CAPTURE;
      info.deployAp = AP_RESO * SLOTS;
      return info;
    }
    info.known = true;
    info.unknown = false;
    var data = (p.options && p.options.data) || {};
    var teamRaw = (p.options && p.options.team != null) ? p.options.team : data.team;
    var team = self.normalizeTeam(teamRaw);
    var resCount = data.resCount != null ? Number(data.resCount) : 0;
    if (!isFinite(resCount) || resCount < 0) resCount = 0;
    if (resCount > SLOTS) resCount = SLOTS;
    var me = self.playerTeam();
    if (team === 'N' || team === 'M') {
      info.capture = true;
      info.captureAp = AP_CAPTURE;
      info.deploy = SLOTS;
      info.deployAp = AP_RESO * SLOTS;
    } else if (me && team === me) {
      info.deploy = Math.max(0, SLOTS - resCount);
      info.deployAp = info.deploy * AP_RESO;
    } else if (me && team !== me) {
      info.capture = true;
      info.captureAp = AP_CAPTURE;
      info.deploy = SLOTS;
      info.deployAp = AP_RESO * SLOTS;
    } else if (resCount < SLOTS) {
      info.deploy = SLOTS - resCount;
      info.deployAp = info.deploy * AP_RESO;
    }
    return info;
  };

  self.enrichPlanAp = function (plan) {
    if (!plan) return plan;
    plan.apLinkTotal = plan.apLink;
    plan.apFieldTotal = plan.apField;
    plan.apLinkField = plan.ap;
    var seen = {};
    var list = self.activePortals();
    var captureAp = 0;
    var deployAp = 0;
    var unknown = 0;
    var captures = 0;
    for (var i = 0; i < list.length; i++) {
      var pt = list[i];
      var id = pt.guid || pt.id;
      if (!id || seen[id]) continue;
      seen[id] = true;
      var info = self.portalCaptureInfo(pt);
      captureAp += info.captureAp || 0;
      deployAp += info.deployAp || 0;
      if (info.capture) captures++;
      if (info.unknown) unknown++;
    }
    plan.apCapture = captureAp + deployAp;
    plan.apTotal = plan.ap + plan.apCapture;
    plan.captureCount = captures;
    plan.unknownCaptureCount = unknown;
    var stations = self.planStations(plan);
    for (var s = 0; s < stations.length; s++) {
      var st = stations[s];
      var cap = self.portalCaptureInfo(st.portal);
      st.capture = !!cap.capture;
    }
    return plan;
  };

  self.portalFromGuid = function (guid) {
    if (!guid || !window.portals) return null;
    var p = window.portals[guid];
    if (!p) return null;
    var ll = p.getLatLng ? p.getLatLng() : null;
    var data = (p.options && p.options.data) || {};
    var lat = ll ? ll.lat : (data.latE6 ? data.latE6 / 1e6 : null);
    var lng = ll ? ll.lng : (data.lngE6 ? data.lngE6 / 1e6 : null);
    if (lat == null || lng == null) return null;
    return {
      id: guid,
      guid: guid,
      name: data.title || ('Portal ' + String(guid).slice(-6)),
      lat: lat,
      lng: lng
    };
  };

  self.refreshNames = function () {
    function update(pt) {
      if (!pt) return;
      var fresh = self.portalFromGuid(pt.guid || pt.id);
      if (fresh && fresh.name) pt.name = fresh.name;
    }
    Object.keys(self.state.portals).forEach(function (id) { update(self.state.portals[id]); });
    Object.keys(self.state.excluded || {}).forEach(function (id) { update(self.state.excluded[id]); });
  };

  self.setStatus = function (text) {
    var el = document.getElementById('mfp-step');
    if (el) el.textContent = text || '';
  };

  self.defaultStatus = function () {
    if (self.state.plan) return '';
    return self.t('stCollecting');
  };

  self.getPlan = function () {
    return self.state.plan;
  };

  self.activePortals = function () {
    var out = [];
    var order = self.state.listOrder || [];
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      if (self.state.excluded[id]) continue;
      var pt = self.state.portals[id];
      if (pt) out.push(pt);
    }
    return out;
  };

  self.excludedCount = function () {
    return Object.keys(self.state.excluded || {}).length;
  };

  self.portalName = function (pt) {
    if (!pt) return '';
    return pt.name || pt.id || '';
  };

  self.portalGuid = function (pt) {
    if (!pt) return null;
    return pt.guid || pt.id || null;
  };

  self.hullForSelection = function () {
    var pts = self.activePortals();
    if (pts.length < 3) return [];
    try {
      return self.getEngine().hullOf(pts);
    } catch (e) {
      return [];
    }
  };

  self.currentAnchor = function () {
    var hull = self.hullForSelection();
    if (!hull.length) return null;
    var idx = self.state.startingpointIndex || 0;
    if (idx >= hull.length) idx = 0;
    if (idx < 0) idx = 0;
    return { portal: hull[idx], index: idx, hull: hull };
  };

  self.scheduleReplan = function (statusMsg) {
    if (!self.state.plan) {
      self.render();
      return;
    }
    if (self._replanTimer) clearTimeout(self._replanTimer);
    self._replanTimer = setTimeout(function () {
      self._replanTimer = null;
      self.runPlan({ fromControl: true, status: statusMsg });
    }, 200);
  };

  self.schemeCount = function () {
    var hull = self.hullForSelection();
    return Math.max(1, hull.length) * 2;
  };

  self.schemeIndex = function () {
    var hull = self.hullForSelection();
    var n = hull.length || 1;
    var i = self.state.startingpointIndex || 0;
    if (i >= n) i = 0;
    if (i < 0) i = 0;
    return i + (self.state.is_clockwise === false ? n : 0);
  };

  self.cycleScheme = function () {
    var hull = self.hullForSelection();
    if (hull.length < 1) return;
    var i = self.state.startingpointIndex || 0;
    i = i + 1;
    if (i >= hull.length) {
      i = 0;
      self.state.is_clockwise = !self.state.is_clockwise;
    }
    self.state.startingpointIndex = i;
    self.scheduleReplan();
    self.noteCurrentChanged();
  };

  self.clickPlan = function () {
    if (self.state.plan && self.activePortals().length >= 3) {
      self.cycleScheme();
      return;
    }
    self.runPlan();
  };

  self.cycleAnchor = function (dir) {
    var hull = self.hullForSelection();
    if (hull.length < 1) return;
    var i = self.state.startingpointIndex || 0;
    if (dir > 0) {
      i = i + 1;
      if (i >= hull.length) i = 0;
    } else {
      i = i - 1;
      if (i < 0) i = hull.length - 1;
    }
    self.state.startingpointIndex = i;
    self.scheduleReplan();
  };

  self.setClockwise = function (cw) {
    var next = !!cw;
    if (self.state.is_clockwise === next && !self.state.plan) {
      self.render();
      return;
    }
    var changed = self.state.is_clockwise !== next;
    self.state.is_clockwise = next;
    self.scheduleReplan();
    if (changed) self.noteCurrentChanged();
  };

  self.setStarDirection = function (dir) {
    var changed = self.state.stardirection !== dir;
    self.state.stardirection = dir;
    self.scheduleReplan();
    if (changed) self.noteCurrentChanged();
  };

  self.changeSBUL = function (delta) {
    var n = (self.state.availableSBUL || 0) + delta;
    if (n < 0) n = 0;
    if (n > 4) n = 4;
    if (n === self.state.availableSBUL) return;
    self.state.availableSBUL = n;
    self.scheduleReplan();
    self.noteCurrentChanged();
  };

  self.clearPlan = function (renderAfter) {
    self.state.plan = null;
    if (!self.state.sectionsOpen) self.state.sectionsOpen = { keys: false, order: false, fav: false };
    self.state.sectionsOpen.keys = false;
    self.state.sectionsOpen.order = false;
    if (self.planLayer && self.planLayer.clearLayers) self.planLayer.clearLayers();
    self.drawCrossHighlights(null);
    self.drawSelection();
    if (renderAfter) self.render();
    self.noteCurrentChanged();
  };

  self.clearAll = function () {
    self.state.portals = {};
    self.state.listOrder = [];
    self.state.excluded = {};
    self.state.plan = null;
    self.state.startingpointIndex = 0;
    if (!self.state.sectionsOpen) self.state.sectionsOpen = { keys: false, order: false, fav: false };
    self.state.sectionsOpen.keys = false;
    self.state.sectionsOpen.order = false;
    if (self.planLayer && self.planLayer.clearLayers) self.planLayer.clearLayers();
    self.drawCrossHighlights(null);
    if (self.markerLayer && self.markerLayer.clearLayers) self.markerLayer.clearLayers();
    self.render();
    self.noteCurrentChanged();
  };

  self.removePortal = function (id) {
    if (!id) return;
    var anchor = self.currentAnchor();
    if (self.state.plan && anchor && anchor.portal && (anchor.portal.guid === id || anchor.portal.id === id)) {
      self.setStatus(self.t('stCannotRemoveAnchor'));
      return;
    }
    var pt = self.state.portals[id];
    if (!pt) return;
    var hadPlan = !!self.state.plan;
    self.state.excluded[id] = pt;
    if (hadPlan) {
      if (self.activePortals().length < 3) {
        self.clearPlan(false);
        self.setStatus(self.t('stNeedThree'));
        self.render();
        return;
      }
      self.scheduleReplan();
      self.noteCurrentChanged();
      return;
    }
    self.setStatus(self.t('stToggleOff'));
    self.render();
    self.noteCurrentChanged();
  };

  self.restorePortal = function (id) {
    if (!id || !self.state.excluded[id]) return;
    var hadPlan = !!self.state.plan;
    delete self.state.excluded[id];
    if (hadPlan && self.activePortals().length >= 3) {
      self.scheduleReplan();
      self.noteCurrentChanged();
      return;
    }
    self.setStatus(self.t('stToggleOn'));
    self.render();
    self.noteCurrentChanged();
  };

  self.addPortal = function (portal) {
    var id = self.portalGuid(portal);
    if (!id) return false;
    if (self.state.portals[id] && !self.state.excluded[id]) return false;
    if (self.state.excluded[id]) {
      delete self.state.excluded[id];
    }
    self.state.portals[id] = portal;
    if (self.state.listOrder.indexOf(id) === -1) self.state.listOrder.push(id);
    return true;
  };

  self.projectLatLng = function (lat, lng) {
    if (lat == null || lng == null) return null;
    try {
      var zoom = 16;
      try {
        var engine = self.getEngine();
        if (engine && engine.PROJECT_ZOOM) zoom = engine.PROJECT_ZOOM;
      } catch (e0) {}
      var map = window.map;
      if (map && typeof map.project === 'function') {
        var ll = (typeof L !== 'undefined' && L.latLng) ? L.latLng(lat, lng) : { lat: lat, lng: lng };
        var pt = map.project(ll, zoom);
        if (pt) return { x: pt.x, y: pt.y };
      }
      if (typeof FanFields2Geo !== 'undefined' && FanFields2Geo.project) {
        return FanFields2Geo.project({ lat: lat, lng: lng }, zoom);
      }
    } catch (e) {}
    return null;
  };

  self.asProjected = function (pt) {
    if (!pt) return null;
    if (pt.x != null && pt.y != null) return pt;
    if (pt.lat != null && pt.lng != null) return self.projectLatLng(pt.lat, pt.lng);
    return null;
  };

  self.pointInTriangleInclusive = function (p, a, b, c) {
    function sign(p1, p2, p3) {
      return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    }
    var d1 = sign(p, a, b);
    var d2 = sign(p, b, c);
    var d3 = sign(p, c, a);
    var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    var hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  };

  self.portalInPlannedFields = function (portal) {
    var plan = self.state.plan;
    if (!plan || !portal || portal.lat == null || portal.lng == null) return false;
    var fields = plan.fields || [];
    if (!fields.length) return false;
    var p = self.projectLatLng(portal.lat, portal.lng);
    if (!p) return false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!f) continue;
      var a = self.asProjected(f.a);
      var b = self.asProjected(f.b);
      var c = self.asProjected(f.c);
      if (!a || !b || !c) continue;
      if (self.pointInTriangleInclusive(p, a, b, c)) return true;
    }
    return false;
  };

  self.pickPortal = function (guid) {
    if (self._ignorePortalSelect) return;
    var now = Date.now();
    if (self.state.lastPickGuid === guid && now - (self.state.lastPickAt || 0) < 400) return;

    if (self.state.plan) {
      var already = self.state.portals[guid] && !self.state.excluded[guid];
      if (already) {
        if (!self.state.open) return;
        self.state.lastPickGuid = guid;
        self.state.lastPickAt = now;
        self.focusPortalInList(guid);
        return;
      }
      var portalIn = self.portalFromGuid(guid);
      if (!portalIn) {
        if (self.state.open) self.setStatus(self.t('stNoPortalInfo'));
        return;
      }
      if (!self.portalInPlannedFields(portalIn)) return;
      self.state.lastPickGuid = guid;
      self.state.lastPickAt = now;
      if (!self.addPortal(portalIn)) return;
      self.noteCurrentChanged();
      self.scheduleReplan(self.state.open ? self.t('stAddedInField') : '');
      return;
    }

    if (!self.state.open) return;
    self.state.lastPickGuid = guid;
    self.state.lastPickAt = now;

    var portal = self.portalFromGuid(guid);
    if (!portal) {
      self.setStatus(self.t('stNoPortalInfo'));
      return;
    }

    if (self.state.portals[guid] && !self.state.excluded[guid]) {
      self.focusPortalInList(guid);
      self.setStatus(self.t('stAlready'));
      return;
    }
    if (!self.addPortal(portal)) return;
    self.noteCurrentChanged();
    self.render();
    self.setStatus(self.defaultStatus());
  };

  self.onPortalSelected = function (data) {
    var guid = data && (data.selectedPortalGuid || data.guid);
    if (!guid && data && data.portal) {
      guid = data.portal.options && data.portal.options.guid;
    }
    if (guid) self.pickPortal(guid);
  };

  self.runPlan = function (opts) {
    opts = opts || {};
    var pts = self.activePortals();
    if (pts.length < 3) {
      if (!opts.quiet) self.setStatus(self.t('stNeedThree'));
      return;
    }
    var plan;
    try {
      var engine = self.getEngine();
      plan = engine.plan({
        portals: pts,
        startingpointIndex: self.state.startingpointIndex || 0,
        is_clockwise: self.state.is_clockwise !== false,
        stardirection: self.state.stardirection,
        availableSBUL: self.state.availableSBUL,
        respectIntel: false
      });
    } catch (err) {
      if (!opts.quiet) self.setStatus(self.t('stPlanFail'));
      return;
    }
    if (!plan || !plan.ok || !plan.fieldCount) {
      self.state.plan = null;
      self.drawCrossHighlights(null);
      self.drawSelection();
      if (!opts.quiet) self.setStatus(self.t('stPlanFail'));
      self.render();
      self.noteCurrentChanged();
      return;
    }
    self.state.startingpointIndex = plan.startingpointIndex;
    self.enrichPlanAp(plan);
    self.state.plan = plan;
    self.drawPlan(plan);
    self.render();
    if (!opts.quiet) self.setStatus(opts.status || '');
    self.noteCurrentChanged();
  };

  self.renderControls = function () {
    var hull = self.hullForSelection();
    var idx = self.state.startingpointIndex || 0;
    if (hull.length && idx >= hull.length) idx = 0;
    var nameEl = document.getElementById('mfp-anchor-name');
    var posEl = document.getElementById('mfp-anchor-pos');
    if (nameEl) {
      nameEl.textContent = hull.length ? (hull[idx].name || hull[idx].guid) : self.t('unselected');
    }
    if (posEl) {
      posEl.textContent = hull.length ? self.t('hullPos', idx + 1, hull.length) : '—';
    }
    var outbound = self.state.stardirection === self.STAR_DIR.RADIATING;
    var dirBtn = document.getElementById('mfp-star-dir');
    if (dirBtn) {
      dirBtn.textContent = self.t('outbound');
      dirBtn.className = 'mfp-ctrl-btn mfp-dir' + (outbound ? ' on' : '');
      dirBtn.title = self.t('starDirHint');
    }
    var sbulRow = document.getElementById('mfp-sbul-row');
    if (sbulRow) sbulRow.style.display = 'inline-flex';
    var sbulVal = document.getElementById('mfp-sbul-val');
    if (sbulVal) sbulVal.textContent = String(self.state.availableSBUL);
    var planBtn = document.getElementById('mfp-plan');
    if (planBtn) {
      if (self.state.plan) {
        var cur = self.schemeIndex() + 1;
        var total = self.schemeCount();
        planBtn.textContent = self.t('planWithScheme', cur, total);
        planBtn.title = self.t('planHint', cur, total);
      } else {
        planBtn.textContent = self.t('planLink');
        planBtn.title = '';
      }
    }
    var tools = document.getElementById('mfp-plan-tools');
    if (tools) tools.style.display = 'flex';
    var dlBtn = document.getElementById('mfp-download');
    if (dlBtn) dlBtn.disabled = !self.state.plan;
    var favBtn = document.getElementById('mfp-fav-save');
    if (favBtn) favBtn.disabled = !self.state.plan;
    if (!self.state.plan) self.closeFavoriteForm();
  };

  self.renderList = function () {
    var head = document.getElementById('mfp-list-head');
    var list = document.getElementById('mfp-list');
    if (!head || !list) return;
    list.innerHTML = '';
    var active = self.activePortals().length;
    var excl = self.excludedCount();
    if (self.state.plan) {
      if (excl) head.textContent = self.t('selectedHeadPlanExcl', active, excl);
      else head.textContent = self.t('selectedHeadPlan', active);
    } else if (excl) {
      head.textContent = self.t('selectedHeadExcl', active, excl);
    } else {
      head.textContent = self.t('selectedHead', active);
    }

    var order = self.state.listOrder || [];
    if (!order.length) {
      list.className = 'mfp-list mfp-empty';
      var empty = document.createElement('div');
      empty.className = 'mfp-muted';
      empty.style.color = 'var(--mfp-muted)';
      empty.style.fontSize = '13px';
      empty.style.padding = '6px 0';
      empty.textContent = self.t('emptySelected');
      list.appendChild(empty);
      return;
    }
    list.className = 'mfp-list';
    var anchor = self.currentAnchor();
    var anchorId = anchor && anchor.portal ? (anchor.portal.guid || anchor.portal.id) : null;
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var pt = self.state.portals[id] || self.state.excluded[id];
      if (!pt) continue;
      var excluded = !!self.state.excluded[id];
      var row = document.createElement('div');
      row.className = 'mfp-row' + (excluded ? ' mfp-excluded' : '');
      row.setAttribute('data-portal-id', id);
      var nameWrap = document.createElement('div');
      nameWrap.className = 'mfp-name';
      nameWrap.appendChild(self.portalJumpControl(pt));
      row.appendChild(nameWrap);
      if (!excluded && anchorId && id === anchorId) {
        var badge = document.createElement('span');
        badge.className = 'mfp-badge';
        badge.textContent = self.t('startPortal');
        row.appendChild(badge);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mfp-mini';
      if (excluded) {
        btn.textContent = self.t('restore');
        btn.addEventListener('click', function (gid) {
          return function (e) {
            e.stopPropagation();
            self.restorePortal(gid);
          };
        }(id));
      } else {
        btn.textContent = self.t('remove');
        if (self.state.plan && anchorId && id === anchorId) {
          btn.disabled = true;
          btn.title = self.t('stCannotRemoveAnchor');
        }
        btn.addEventListener('click', function (gid) {
          return function (e) {
            e.stopPropagation();
            self.removePortal(gid);
          };
        }(id));
      }
      row.appendChild(btn);
      list.appendChild(row);
    }
  };

  self.planStations = function (plan) {
    if (!plan) return [];
    return plan.stations || plan.walkStations || [];
  };

  self.hasKeyInventory = function () {
    try {
      return !!(window.plugin && (window.plugin.keys || window.plugin.LiveInventory));
    } catch (e) {
      return false;
    }
  };

  self.getOwnedKeys = function (guid) {
    if (!guid || !self.hasKeyInventory()) return null;
    try {
      var li = window.plugin.LiveInventory;
      if (li) {
        if (li.keyGuidCount && Object.prototype.hasOwnProperty.call(li.keyGuidCount, guid)) {
          return li.keyGuidCount[guid] || 0;
        }
        if (li.keyCount && li.keyCount.length) {
          var i;
          for (i = 0; i < li.keyCount.length; i++) {
            var obj = li.keyCount[i];
            var g = obj && obj.portalCoupler && obj.portalCoupler.portalGuid;
            if (g === guid) return obj.count || 0;
          }
        }
      }
      if (window.plugin.keys && window.plugin.keys.keys) {
        return window.plugin.keys.keys[guid] || 0;
      }
    } catch (e) {}
    return 0;
  };

  self.formatKeyCount = function (needed, owned) {
    var n = needed == null ? 0 : needed;
    if (owned == null) return String(n);
    if (self.getLang() === 'en') return n + '(' + owned + ')';
    return n + '（' + owned + '）';
  };

  self.formatKeyLine = function (name, count, owned) {
    var qty = self.formatKeyCount(count, owned);
    if (self.getLang() === 'en') return name + ': ' + qty;
    return name + '：' + qty;
  };

  self.captureSuffix = function (st) {
    if (!st || !st.capture) return '';
    return self.t('captureTag');
  };

  self.stationHeadingText = function (idx, st) {
    var head = self.stationHeader(idx + 1);
    var name = self.portalName(st && st.portal);
    var space = self.getLang() === 'en' ? ' ' : '';
    var start = (st && st.isStart) ? (' · ' + self.t('startPortal')) : '';
    return head + space + name + start + self.captureSuffix(st);
  };

  self.throwDestName = function (tr) {
    return (tr && (tr.toName || (tr.to && (tr.to.name || tr.to.id)))) || '';
  };

  self.keyListText = function () {
    var plan = self.getPlan();
    if (!plan || !plan.keyList) return '';
    return plan.keyList.map(function (k) {
      var owned = self.hasKeyInventory() ? self.getOwnedKeys(k.id) : null;
      return self.formatKeyLine(k.name, k.count, owned);
    }).join('\n');
  };

  self.orderListText = function () {
    var plan = self.getPlan();
    if (!plan) return '';
    var stations = self.planStations(plan);
    var lines = [];
    stations.forEach(function (st, idx) {
      lines.push(self.stationHeadingText(idx, st));
      (st.throws || []).forEach(function (tr) {
        var line = self.portalName(st.portal) + '——>' + self.throwDestName(tr);
        if (tr.fields) line += '  ' + self.t('fieldsMade', tr.fields);
        lines.push(line);
      });
    });
    return lines.join('\n');
  };

  self.pad2 = function (n) {
    n = Math.floor(Number(n) || 0);
    return (n < 10 ? '0' : '') + n;
  };

  self.parseLatLng = function (obj) {
    if (!obj || typeof obj !== 'object') return null;
    var lat = null;
    var lng = null;
    var raw = obj.latlng != null ? obj.latlng : obj.latLng;
    if (typeof raw === 'string') {
      var parts = raw.split(',');
      if (parts.length >= 2) {
        lat = parseFloat(String(parts[0]).replace(/^\s+|\s+$/g, ''));
        lng = parseFloat(String(parts[1]).replace(/^\s+|\s+$/g, ''));
      }
    } else if (raw && typeof raw === 'object') {
      lat = parseFloat(raw.lat != null ? raw.lat : raw.latitude);
      lng = parseFloat(raw.lng != null ? raw.lng : (raw.lon != null ? raw.lon : raw.longitude));
    } else if (obj.lat != null && (obj.lng != null || obj.lon != null)) {
      lat = parseFloat(obj.lat);
      lng = parseFloat(obj.lng != null ? obj.lng : obj.lon);
    } else if (obj.latE6 != null && obj.lngE6 != null) {
      lat = Number(obj.latE6) / 1e6;
      lng = Number(obj.lngE6) / 1e6;
    }
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  };

  self.collectBookmarkPortals = function (data) {
    var found = [];
    var seen = {};

    function addEntry(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      var guid = obj.guid || obj.portalGuid;
      if (!guid || typeof guid !== 'string') return;
      guid = String(guid).replace(/^\s+|\s+$/g, '');
      if (!guid) return;
      var ll = self.parseLatLng(obj);
      if (!ll) return;
      if (seen[guid]) return;
      seen[guid] = true;
      var name = obj.label || obj.name || obj.title || ('Portal ' + guid.slice(-6));
      found.push({
        id: guid,
        guid: guid,
        name: name,
        lat: ll.lat,
        lng: ll.lng
      });
    }

    function walkFolder(folder) {
      if (!folder) return;
      if (Array.isArray(folder)) {
        for (var i = 0; i < folder.length; i++) {
          if (folder[i] && folder[i].bkmrk) walkFolder(folder[i]);
          else addEntry(folder[i]);
        }
        return;
      }
      if (typeof folder !== 'object') return;
      if (folder.bkmrk && typeof folder.bkmrk === 'object') {
        if (Array.isArray(folder.bkmrk)) walkFolder(folder.bkmrk);
        else {
          var ids = Object.keys(folder.bkmrk);
          for (var j = 0; j < ids.length; j++) addEntry(folder.bkmrk[ids[j]]);
        }
        return;
      }
      addEntry(folder);
      var keys = Object.keys(folder);
      for (var k = 0; k < keys.length; k++) {
        var v = folder[keys[k]];
        if (!v || typeof v !== 'object') continue;
        if (v.bkmrk || v.guid || v.portalGuid || v.latlng || v.latLng) walkFolder(v);
      }
    }

    if (data == null) return found;
    if (Array.isArray(data)) {
      walkFolder(data);
      return found;
    }
    if (typeof data !== 'object') return found;
    if (data.portals) walkFolder(data.portals);
    else walkFolder(data);
    return found;
  };

  self.pickBookmarkFile = function () {
    var input = document.getElementById('mfp-upload-input');
    if (!input) return;
    try { input.value = ''; } catch (e0) {}
    try { input.click(); } catch (e1) {}
  };

  self.onBookmarkFile = function (ev) {
    var input = ev && ev.target;
    var file = input && input.files && input.files[0];
    if (!file) {
      self.setStatus(self.t('stUploadNoFile'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      self.importBookmarkText(reader.result);
    };
    reader.onerror = function () {
      self.setStatus(self.t('stUploadReadFail'));
    };
    try {
      reader.readAsText(file);
    } catch (e2) {
      self.setStatus(self.t('stUploadReadFail'));
    }
  };

  self.importBookmarkText = function (text) {
    var raw = text == null ? '' : String(text);
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (!raw.replace(/^\s+|\s+$/g, '')) {
      self.setStatus(self.t('stUploadEmpty'));
      return false;
    }
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      self.setStatus(self.t('stUploadBadJson'));
      return false;
    }
    var portals = self.collectBookmarkPortals(data);
    if (!portals.length) {
      self.setStatus(self.t('stUploadNoPortals'));
      return false;
    }
    self.state.portals = {};
    self.state.listOrder = [];
    self.state.excluded = {};
    self.state.plan = null;
    self.state.startingpointIndex = 0;
    if (!self.state.sectionsOpen) self.state.sectionsOpen = { keys: false, order: false, fav: false };
    self.state.sectionsOpen.keys = false;
    self.state.sectionsOpen.order = false;
    if (self.planLayer && self.planLayer.clearLayers) self.planLayer.clearLayers();
    self.drawCrossHighlights(null);
    if (self.markerLayer && self.markerLayer.clearLayers) self.markerLayer.clearLayers();
    for (var i = 0; i < portals.length; i++) self.addPortal(portals[i]);
    try { self.refreshNames(); } catch (e3) {}
    self.render();
    self.setStatus(self.t('stUploaded', portals.length));
    self.noteCurrentChanged();
    return true;
  };

  self.downloadTextFile = function (text, filename, mime) {
    mime = mime || 'application/json';
    try {
      if (typeof window.saveFile === 'function') {
        window.saveFile(text, filename, mime);
        return true;
      }
    } catch (e0) {}
    try {
      if (window.IITC && IITC.utils && typeof IITC.utils.exportFile === 'function') {
        IITC.utils.exportFile(text, filename, mime);
        return true;
      }
    } catch (e1) {}
    try {
      if (typeof android !== 'undefined' && android && android.saveFile) {
        android.saveFile(filename, mime, text);
        return true;
      }
    } catch (e2) {}
    try {
      var blob = new Blob([text], { type: mime });
      var url = (window.URL || window.webkitURL).createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        try { (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e3) {}
      }, 800);
      return true;
    } catch (e4) {
      window.prompt(self.t('copyManual'), text);
      return false;
    }
  };

  self.drawToolsItems = function (plan) {
    var items = [];
    var linkColor = self.getLinkHex();
    (plan.links || []).forEach(function (lk) {
      if (!lk || !lk.a || lk.a.lat == null || !lk.b || lk.b.lat == null) return;
      items.push({
        type: 'polyline',
        color: linkColor,
        latLngs: [
          { lat: lk.a.lat, lng: lk.a.lng },
          { lat: lk.b.lat, lng: lk.b.lng }
        ]
      });
    });
    return items;
  };

  self.downloadDrawTools = function () {
    var plan = self.getPlan();
    if (!plan) return;
    var items = self.drawToolsItems(plan);
    var text = JSON.stringify(items, null, 2);
    var d = new Date();
    var filename = 'maxfield-planner-' +
      d.getFullYear() + self.pad2(d.getMonth() + 1) + self.pad2(d.getDate()) + '-' +
      self.pad2(d.getHours()) + self.pad2(d.getMinutes()) + '.json';
    var ok = self.downloadTextFile(text, filename, 'application/json');
    self.setStatus(ok ? self.t('downloaded') : self.t('copyManual'));
  };

  self.clonePortalMap = function (map) {
    var out = {};
    Object.keys(map || {}).forEach(function (id) {
      var pt = map[id];
      if (!pt) return;
      out[id] = {
        id: pt.id || id,
        guid: pt.guid || id,
        name: pt.name || '',
        lat: pt.lat,
        lng: pt.lng
      };
    });
    return out;
  };

  self.readFavorites = function () {
    var list;
    try {
      var raw = localStorage.getItem(self.FAV_KEY);
      list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      return [];
    }
    var m = MaxfieldFavSync.migrate(list);
    if (m.changed) self.writeFavorites(m.list);
    return m.list;
  };

  self.readFavTombstones = function () {
    try {
      var raw = localStorage.getItem(self.FAV_TOMB_KEY);
      var t = raw ? JSON.parse(raw) : {};
      return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
    } catch (e) {
      return {};
    }
  };

  self.writeFavTombstones = function (t) {
    try {
      localStorage.setItem(self.FAV_TOMB_KEY, JSON.stringify(t || {}));
      return true;
    } catch (e) {
      return false;
    }
  };

  // ----- favorites sync (GitHub Gist) -----
  self.getSyncToken = function () {
    try { return localStorage.getItem(self.SYNC_TOKEN_KEY) || ''; } catch (e) { return ''; }
  };

  self.getSyncGistId = function () {
    try { return localStorage.getItem(self.SYNC_GIST_KEY) || ''; } catch (e) { return ''; }
  };

  self.openSyncForm = function () {
    var form = document.getElementById('mfp-sync-form');
    if (!form) return;
    var tok = document.getElementById('mfp-sync-token');
    var gist = document.getElementById('mfp-sync-gist');
    if (tok) {
      tok.value = '';
      tok.placeholder = self.getSyncToken() ? self.t('syncTokenSavedPh') : self.t('syncTokenPh');
    }
    if (gist) gist.value = self.getSyncGistId();
    form.className = 'mfp-fav-form mfp-sync-form is-on';
    try { if (tok) tok.focus(); } catch (e) {}
  };

  self.closeSyncForm = function () {
    var form = document.getElementById('mfp-sync-form');
    if (form) form.className = 'mfp-fav-form mfp-sync-form';
    var tok = document.getElementById('mfp-sync-token');
    if (tok) tok.value = '';
  };

  self.saveSyncSettings = function () {
    var tok = document.getElementById('mfp-sync-token');
    var gist = document.getElementById('mfp-sync-gist');
    var token = tok ? String(tok.value || '').replace(/\s+/g, '') : '';
    var gistId = gist ? String(gist.value || '').replace(/\s+/g, '') : '';
    // Accept a full gist URL too; keep only the id.
    var mm = gistId.match(/([0-9a-f]{20,})\/?$/i);
    if (mm) gistId = mm[1];
    if (!token && !self.getSyncToken()) {
      self.setStatus(self.t('stNeedToken'));
      return;
    }
    try {
      if (token) localStorage.setItem(self.SYNC_TOKEN_KEY, token);
      if (gistId) localStorage.setItem(self.SYNC_GIST_KEY, gistId);
      else localStorage.removeItem(self.SYNC_GIST_KEY);
    } catch (e) {}
    self.closeSyncForm();
    self.syncFavorites({ manual: true });
  };

  self.clearSyncSettings = function () {
    try {
      localStorage.removeItem(self.SYNC_TOKEN_KEY);
      localStorage.removeItem(self.SYNC_GIST_KEY);
    } catch (e) {}
    self.closeSyncForm();
    self.setStatus(self.t('stSyncCleared'));
  };

  self.syncErrorText = function (err) {
    var code = err && err.code;
    if (code === 'auth') return self.t('syncErrAuth');
    if (code === 'forbidden') return self.t('syncErrForbidden');
    if (code === 'notfound') return self.t('syncErrNotFound');
    if (code === 'network') return self.t('syncErrNetwork');
    if (code === 'badjson') return self.t('syncErrBadJson');
    if (code === 'http') return self.t('syncErrHttp', err.status || '');
    return self.t('syncErrNetwork');
  };

  self.getClientId = function () {
    try {
      var id = localStorage.getItem(self.CLIENT_KEY);
      if (id) return id;
      id = 'mfp-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
      localStorage.setItem(self.CLIENT_KEY, id);
      return id;
    } catch (e) {
      if (!self._clientIdMem) {
        self._clientIdMem = 'mfp-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
      }
      return self._clientIdMem;
    }
  };

  self.captureCurrentDoc = function () {
    var portals = [];
    var excluded = [];
    var order = self.state.listOrder || [];
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var ex = self.state.excluded && self.state.excluded[id];
      var pt = (self.state.portals && self.state.portals[id]) || ex;
      if (!pt) continue;
      var lite = {
        guid: pt.guid || id,
        lat: pt.lat,
        lng: pt.lng,
        name: pt.name || ''
      };
      if (ex) excluded.push(lite);
      else portals.push(lite);
    }
    return {
      updatedAt: self._currentUpdatedAt || 0,
      clientId: self.getClientId(),
      planned: !!self.state.plan,
      startingpointIndex: self.state.startingpointIndex || 0,
      is_clockwise: self.state.is_clockwise !== false,
      stardirection: self.state.stardirection,
      availableSBUL: self.state.availableSBUL == null ? 2 : self.state.availableSBUL,
      portals: portals,
      excluded: excluded,
      listOrder: order.slice()
    };
  };

  self.persistCurrentDoc = function (doc) {
    try { localStorage.setItem(self.CURRENT_KEY, JSON.stringify(doc)); } catch (e) {}
  };

  self.noteCurrentChanged = function () {
    if (self._suppressCurrentPush) return;
    var doc = self.captureCurrentDoc();
    var key = MaxfieldFavSync.currentKey(doc);
    if (self._currentKey != null && key === self._currentKey) return;
    self._currentKey = key;
    self._currentUpdatedAt = Date.now();
    doc.updatedAt = self._currentUpdatedAt;
    doc.clientId = self.getClientId();
    self.persistCurrentDoc(doc);
    self.scheduleCurrentPush();
  };

  self.scheduleCurrentPush = function () {
    if (!self._currentSched) {
      self._currentSched = MaxfieldFavSync.createCurrentScheduler({
        delay: 2000,
        getDoc: function () { return self.captureCurrentDoc(); },
        push: function (doc) {
          return self.syncCurrentPlan(doc).then(function (res) {
            return res;
          }, function (err) {
            self.setStatus(self.t('stSyncFail', self.syncErrorText(err)));
            throw err;
          });
        }
      });
    }
    self._currentSched.schedule();
  };

  // Pull, and push only when this device's copy is the newer one. Same gist as favorites.
  self.syncCurrentPlan = function (doc) {
    var token = self.getSyncToken();
    if (!token) return Promise.resolve({ pushed: false, apply: false });
    var local = doc || self.captureCurrentDoc();
    return MaxfieldFavSync.syncCurrent({
      token: token,
      gistId: self.getSyncGistId(),
      local: local,
      clientId: self.getClientId()
    }).then(function (res) {
      try { if (res.gistId) localStorage.setItem(self.SYNC_GIST_KEY, res.gistId); } catch (e) {}
      if (res.apply && res.doc && MaxfieldFavSync.shouldApplyCurrent(self.captureCurrentDoc(), res.doc, self.getClientId())) {
        self.applyCurrentDoc(res.doc);
      }
      return res;
    });
  };

  self.applyCurrentDoc = function (doc) {
    var norm = MaxfieldFavSync.normalizeCurrent(doc);
    self._suppressCurrentPush = true;
    try {
      self.state.portals = {};
      self.state.excluded = {};
      self.state.listOrder = norm.listOrder.slice();
      self.state.plan = null;
      norm.portals.forEach(function (p) {
        self.state.portals[p.guid] = { id: p.guid, guid: p.guid, name: p.name, lat: p.lat, lng: p.lng };
      });
      norm.excluded.forEach(function (p) {
        var o = { id: p.guid, guid: p.guid, name: p.name, lat: p.lat, lng: p.lng };
        self.state.portals[p.guid] = o;
        self.state.excluded[p.guid] = o;
      });
      self.state.startingpointIndex = norm.startingpointIndex;
      self.state.is_clockwise = norm.is_clockwise;
      self.state.stardirection = norm.stardirection;
      self.state.availableSBUL = norm.availableSBUL;
      self._currentUpdatedAt = norm.updatedAt;
      if (norm.planned && self.activePortals().length >= 3) {
        self.runPlan({ fromControl: true, quiet: true });
      } else {
        self.clearPlan(false);
        self.render();
      }
    } finally {
      self._suppressCurrentPush = false;
    }
    self._currentUpdatedAt = norm.updatedAt;
    self._currentKey = MaxfieldFavSync.currentKey(norm);
    self.persistCurrentDoc(norm);
  };

  self.restoreCurrentLocal = function () {
    var raw;
    try { raw = localStorage.getItem(self.CURRENT_KEY); } catch (e) { return; }
    if (!raw) return;
    try { self.applyCurrentDoc(JSON.parse(raw)); } catch (e2) {}
  };

  // opts.manual: show progress and success; otherwise only failures are shown.
  // Also pulls/pushes the current working plan. Success text stays the favorites message.
  self.syncFavorites = function (opts) {
    opts = opts || {};
    var token = self.getSyncToken();
    if (!token) {
      if (opts.manual) {
        self.setStatus(self.t('stNeedToken'));
        self.openSyncForm();
      }
      return;
    }
    if (self._syncBusy) {
      self._syncAgain = self._syncAgain || {};
      if (opts.manual) self._syncAgain.manual = true;
      return;
    }
    self._syncBusy = true;
    if (opts.manual) self.setStatus(self.t('stSyncing'));
    var local = { favorites: self.readFavorites(), tombstones: self.readFavTombstones() };
    MaxfieldFavSync.syncOnce({ token: token, gistId: self.getSyncGistId(), local: local })
      .then(function (res) {
        // Merge again with anything saved locally while the request was running.
        var now = { favorites: self.readFavorites(), tombstones: self.readFavTombstones() };
        var merged = MaxfieldFavSync.merge(now, res.doc);
        self.writeFavorites(merged.favorites);
        self.writeFavTombstones(merged.tombstones);
        try { if (res.gistId) localStorage.setItem(self.SYNC_GIST_KEY, res.gistId); } catch (e) {}
        self.renderFavorites();
        return self.syncCurrentPlan();
      })
      .then(function () {
        if (opts.manual) self.setStatus(self.t('stSynced'));
      }, function (err) {
        self.setStatus(self.t('stSyncFail', self.syncErrorText(err)));
      })
      .then(function () {
        self._syncBusy = false;
        var again = self._syncAgain;
        self._syncAgain = null;
        if (again) self.syncFavorites(again);
      });
  };

  self.writeFavorites = function (list) {
    try {
      localStorage.setItem(self.FAV_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  };

  self.defaultFavoriteName = function () {
    var n = self.activePortals().length;
    var anchor = self.currentAnchor();
    var name = anchor && anchor.portal ? self.portalName(anchor.portal) : '';
    var d = new Date();
    var when = self.pad2(d.getMonth() + 1) + '-' + self.pad2(d.getDate()) + ' ' +
      self.pad2(d.getHours()) + ':' + self.pad2(d.getMinutes());
    if (name) return name + ' · ' + n + ' Portal';
    return when + ' · ' + n + ' Portal';
  };

  self.closeFavoriteForm = function () {
    var form = document.getElementById('mfp-fav-form');
    if (form) form.className = 'mfp-fav-form';
  };

  self.openFavoriteForm = function () {
    if (!self.getPlan()) return;
    var form = document.getElementById('mfp-fav-form');
    var input = document.getElementById('mfp-fav-name');
    if (!form || !input) return;
    form.className = 'mfp-fav-form is-on';
    input.value = self.defaultFavoriteName();
    try {
      input.focus();
      if (input.select) input.select();
    } catch (e) {}
  };

  self.confirmFavorite = function () {
    if (!self.getPlan()) return;
    var input = document.getElementById('mfp-fav-name');
    var name = input ? String(input.value || '').replace(/^\s+|\s+$/g, '') : '';
    if (!name) {
      self.setStatus(self.t('favNeedName'));
      if (input) try { input.focus(); } catch (e0) {}
      return;
    }
    var fav = {
      id: MaxfieldFavSync.newId(),
      name: name,
      savedAt: Date.now(),
      updatedAt: Date.now(),
      portals: self.clonePortalMap(self.state.portals),
      listOrder: (self.state.listOrder || []).slice(),
      excluded: self.clonePortalMap(self.state.excluded),
      startingpointIndex: self.state.startingpointIndex || 0,
      is_clockwise: self.state.is_clockwise !== false,
      stardirection: self.state.stardirection,
      availableSBUL: self.state.availableSBUL,
      fieldHex: self.getFieldHex(),
      linkHex: self.getLinkHex(),
      walkHex: self.getWalkHex(),
      walkVisible: self.getWalkVisible()
    };
    var list = self.readFavorites();
    list.unshift(fav);
    if (!self.writeFavorites(list)) {
      self.setStatus(self.t('favSaveFail'));
      return;
    }
    self.closeFavoriteForm();
    self.renderFavorites();
    self.setStatus(self.t('favSaved', name));
    self.syncFavorites();
  };

  self.loadFavorite = function (id) {
    var list = self.readFavorites();
    var fav = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { fav = list[i]; break; }
    }
    if (!fav) return;
    self.state.portals = self.clonePortalMap(fav.portals);
    self.state.listOrder = (fav.listOrder || Object.keys(self.state.portals)).slice();
    self.state.excluded = self.clonePortalMap(fav.excluded);
    self.state.startingpointIndex = fav.startingpointIndex || 0;
    self.state.is_clockwise = fav.is_clockwise !== false;
    self.state.stardirection = (fav.stardirection != null) ? fav.stardirection : self.STAR_DIR.CENTRALIZING;
    self.state.availableSBUL = (fav.availableSBUL != null) ? fav.availableSBUL : 2;
    if (fav.fieldHex) self.setFieldHex(fav.fieldHex);
    if (fav.linkHex) self.setLinkHex(fav.linkHex);
    if (fav.walkHex) self.setWalkHex(fav.walkHex);
    if (fav.walkVisible != null) {
      try { localStorage.setItem(self.WALK_VISIBLE_KEY, fav.walkVisible ? '1' : '0'); } catch (e1) {}
    }
    if (self.activePortals().length >= 3) self.runPlan({ fromControl: true });
    else {
      self.clearPlan(false);
      self.render();
    }
    self.setStatus(self.t('favLoaded', fav.name || ''));
  };

  self.deleteFavorite = function (id) {
    var list = self.readFavorites();
    var name = '';
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        name = list[i].name || '';
        continue;
      }
      next.push(list[i]);
    }
    if (id) {
      var tombs = self.readFavTombstones();
      tombs[id] = Date.now();
      self.writeFavTombstones(tombs);
    }
    self.writeFavorites(next);
    self.renderFavorites();
    self.setStatus(self.t('favDeleted', name));
    self.syncFavorites();
  };

  self.renderFavorites = function () {
    var box = document.getElementById('mfp-fav-box');
    if (!box) return;
    box.innerHTML = '';
    var list = self.readFavorites();
    var wrap = document.createElement('details');
    self.bindSection(wrap, 'fav');
    var favSum = self.summaryWithCopyLabel(self.t('favTitle', list.length));
    favSum.appendChild(self.summaryButton(self.t('syncBtn'), function () { self.syncFavorites({ manual: true }); }));
    favSum.appendChild(self.summaryButton(self.t('syncSettings'), function () {
      var form = document.getElementById('mfp-sync-form');
      if (form && /\bis-on\b/.test(form.className)) self.closeSyncForm();
      else self.openSyncForm();
    }));
    wrap.appendChild(favSum);
    list.forEach(function (fav) {
      if (!fav) return;
      var row = document.createElement('div');
      row.className = 'mfp-fav-row';
      var name = document.createElement('div');
      name.className = 'mfp-fav-name';
      name.textContent = fav.name || '';
      if (fav.savedAt) {
        var d = new Date(fav.savedAt);
        name.title = d.getFullYear() + '-' + self.pad2(d.getMonth() + 1) + '-' + self.pad2(d.getDate()) +
          ' ' + self.pad2(d.getHours()) + ':' + self.pad2(d.getMinutes());
      }
      row.appendChild(name);
      var loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'mfp-copy-btn';
      loadBtn.textContent = self.t('favLoad');
      loadBtn.addEventListener('click', function (fid) {
        return function (e) {
          if (e.stopPropagation) e.stopPropagation();
          self.loadFavorite(fid);
        };
      }(fav.id));
      row.appendChild(loadBtn);
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mfp-copy-btn';
      delBtn.textContent = self.t('favDelete');
      delBtn.addEventListener('click', function (fid) {
        return function (e) {
          if (e.stopPropagation) e.stopPropagation();
          self.deleteFavorite(fid);
        };
      }(fav.id));
      row.appendChild(delBtn);
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  };

  self.summaryWithCopyLabel = function (text) {
    var sum = document.createElement('summary');
    sum.className = 'mfp-summary';
    var lab = document.createElement('span');
    lab.className = 'mfp-summary-text';
    lab.textContent = text;
    sum.appendChild(lab);
    return sum;
  };

  self.summaryButton = function (text, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mfp-copy-btn';
    btn.textContent = text;
    function stop(e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }
    btn.addEventListener('mousedown', stop);
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('click', function (e) {
      stop(e);
      onClick();
    });
    return btn;
  };

  self.copyText = function (text, okMsg) {
    function ok() { self.setStatus(okMsg); }
    function fail() { window.prompt(self.t('copyManual'), text); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fail);
    } else {
      fail();
    }
  };

  self.bindCopyButton = function (btn, kind) {
    function stop(e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }
    btn.addEventListener('mousedown', stop);
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('click', function (e) {
      stop(e);
      if (kind === 'keys') self.copyText(self.keyListText(), self.t('copiedKeys'));
      else self.copyText(self.orderListText(), self.t('copiedOrder'));
    });
  };

  self.summaryWithCopy = function (text, kind, showCopy) {
    var sum = document.createElement('summary');
    sum.className = 'mfp-summary';
    var lab = document.createElement('span');
    lab.className = 'mfp-summary-text';
    lab.textContent = text;
    sum.appendChild(lab);
    if (showCopy !== false) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mfp-copy-btn';
      btn.textContent = self.t('copy');
      self.bindCopyButton(btn, kind);
      sum.appendChild(btn);
    }
    return sum;
  };

  self.defaultSectionsOpen = function () {
    return { keys: false, order: false, fav: false };
  };

  self.sectionCanOpen = function (key) {
    if (self.state.plan) return true;
    if (key === 'fav' && self.readFavorites().length) return true;
    return false;
  };

  self.bindSection = function (el, key) {
    if (!self.state.sectionsOpen) self.state.sectionsOpen = self.defaultSectionsOpen();
    var canOpen = self.sectionCanOpen(key);
    if (canOpen) {
      el.open = !!self.state.sectionsOpen[key];
      el.classList.remove('mfp-section-locked');
    } else {
      el.open = false;
      el.classList.add('mfp-section-locked');
    }
    el.addEventListener('click', function (e) {
      if (self.sectionCanOpen(key)) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      el.open = false;
    });
    el.addEventListener('toggle', function () {
      if (!self.sectionCanOpen(key)) {
        if (el.open) el.open = false;
        el.classList.add('mfp-section-locked');
        return;
      }
      el.classList.remove('mfp-section-locked');
      if (!self.state.sectionsOpen) self.state.sectionsOpen = self.defaultSectionsOpen();
      self.state.sectionsOpen[key] = !!el.open;
    });
  };

  self.renderResult = function () {
    var box = document.getElementById('mfp-result');
    if (!box) return;
    box.innerHTML = '';
    var plan = self.getPlan();

    if (plan) {
      var card = document.createElement('div');
      card.className = 'mfp-stat-card';

      var line1 = document.createElement('div');
      line1.className = 'mfp-stats-line';
      self.appendStatItem(line1, plan.fieldCount, self.t('statField'), ', ');
      self.appendStatItem(line1, plan.layers, self.t('statLayer'), ', ');
      self.appendStatItem(line1, plan.linkCount, self.t('statLink'), ', ');
      self.appendStatItem(line1, plan.portalCount, self.t('statPortal'), plan.walkMeters != null ? ', ' : '');
      if (plan.walkMeters != null) self.appendWalkStat(line1, plan.walkMeters);
      card.appendChild(line1);

      var line2 = document.createElement('div');
      line2.className = 'mfp-ap-line';
      line2.appendChild(document.createTextNode('field '));
      self.appendStatNum(line2, self.fmtAp(plan.apField));
      line2.appendChild(document.createTextNode(' + link '));
      self.appendStatNum(line2, self.fmtAp(plan.apLink));
      line2.appendChild(document.createTextNode(', ' + self.t('apLabel') + ' '));
      self.appendStatNum(line2, self.fmtAp(plan.ap));
      card.appendChild(line2);
      box.appendChild(card);
      if (plan.countsDiffer) {
        var note = document.createElement('div');
        note.className = 'mfp-warn';
        note.textContent = self.t('countsNote', plan.validTriangleCount, plan.validLinkCount);
        box.appendChild(note);
      }
      if (plan.invalidUnderFieldCount) {
        var warn = document.createElement('div');
        warn.className = 'mfp-warn';
        warn.textContent = self.t('underFieldWarn', plan.invalidUnderFieldCount);
        box.appendChild(warn);
      }
    }

    var keyList = (plan && plan.keyList) ? plan.keyList : [];
    var keys = document.createElement('details');
    self.bindSection(keys, 'keys');
    keys.appendChild(self.summaryWithCopy(self.t('keysTitle', keyList.length), 'keys', keyList.length > 0));
    if (keyList.length) {
      var keyBox = document.createElement('div');
      keyBox.className = 'mfp-plain-list';
      var haveInv = self.hasKeyInventory();
      keyList.forEach(function (k) {
        var line = document.createElement('div');
        line.className = 'mfp-key-line';
        var pt = (self.state.portals && (self.state.portals[k.id] || self.state.excluded[k.id])) || { guid: k.id, id: k.id, name: k.name };
        if (!pt.name) pt.name = k.name;
        line.appendChild(self.portalJumpControl(pt));
        line.appendChild(document.createTextNode(self.getLang() === 'en' ? ': ' : '：'));
        var qty = document.createElement('span');
        var owned = haveInv ? self.getOwnedKeys(k.id) : null;
        qty.textContent = self.formatKeyCount(k.count, owned);
        if (haveInv && owned != null && owned < k.count) qty.className = 'mfp-keys-short';
        line.appendChild(qty);
        keyBox.appendChild(line);
      });
      keys.appendChild(keyBox);
      if (!haveInv) {
        var hint = document.createElement('div');
        hint.className = 'mfp-keys-hint';
        hint.textContent = self.t('keysInventoryHint');
        keys.appendChild(hint);
      }
    }
    box.appendChild(keys);

    var stations = self.planStations(plan);
    var throwCount = 0;
    stations.forEach(function (st) { throwCount += (st.throws || []).length; });
    var order = document.createElement('details');
    self.bindSection(order, 'order');
    order.appendChild(self.summaryWithCopy(self.t('orderTitle', stations.length, throwCount), 'order', stations.length > 0));
    if (stations.length) {
      var throws = document.createElement('div');
      throws.id = 'mfp-throws';
      stations.forEach(function (st, idx) {
        var sec = document.createElement('div');
        sec.className = 'mfp-station';
        var h = document.createElement('div');
        h.className = 'mfp-station-title';
        h.appendChild(document.createTextNode(self.stationHeader(idx + 1) + (self.getLang() === 'en' ? ' ' : '')));
        h.appendChild(self.portalJumpControl(st.portal));
        if (st.isStart) {
          var startBadge = document.createElement('span');
          startBadge.className = 'mfp-badge';
          startBadge.textContent = self.t('startPortal');
          h.appendChild(document.createTextNode(' '));
          h.appendChild(startBadge);
        }
        if (st.capture) {
          var cap = document.createElement('span');
          cap.className = 'mfp-capture-tag';
          cap.textContent = self.t('captureTag');
          h.appendChild(cap);
        }
        sec.appendChild(h);
        (st.throws || []).forEach(function (tr) {
          var line = document.createElement('div');
          line.className = 'mfp-throw-line';
          line.appendChild(self.portalJumpControl(st.portal));
          line.appendChild(document.createTextNode('——>'));
          var dest = { guid: tr.toId, id: tr.toId, name: self.throwDestName(tr), lat: null, lng: null };
          var destPortal = self.state.portals[tr.toId];
          if (destPortal) dest = destPortal;
          line.appendChild(self.portalJumpControl(dest));
          if (tr.fields) {
            var made = document.createElement('span');
            made.className = 'mfp-badge c';
            made.style.marginLeft = '6px';
            made.textContent = self.t('fieldsMade', tr.fields);
            line.appendChild(made);
          }
          sec.appendChild(line);
        });
        throws.appendChild(sec);
      });
      order.appendChild(throws);
    }
    box.appendChild(order);
  };

  self.render = function () {
    if (!document.getElementById('mfp-panel')) return;
    self.applyChrome();
    self.renderList();
    self.renderControls();
    self.renderResult();
    self.renderFavorites();
    if (!self.state.plan) self.setStatus(self.defaultStatus());
    self.drawSelection();
    if (self.state.plan) self.drawPlan(self.state.plan);
  };

  self.drawSelection = function () {
    if (!self.markerLayer || typeof L === 'undefined') return;
    self.markerLayer.clearLayers();
    function mark(pt, color, radius, label) {
      if (!pt || pt.lat == null || pt.lng == null) return;
      var m = L.circleMarker([pt.lat, pt.lng], {
        radius: radius,
        color: color,
        weight: 3,
        fillColor: color,
        fillOpacity: 0.25,
        interactive: false
      });
      if (label) m.bindTooltip(label, { permanent: true, direction: 'top', className: 'mfp-tip', opacity: 0.9 });
      self.markerLayer.addLayer(m);
    }
    var anchor = self.currentAnchor();
    var anchorId = anchor && anchor.portal ? (anchor.portal.guid || anchor.portal.id) : null;
    Object.keys(self.state.portals || {}).forEach(function (id) {
      if (self.state.excluded[id]) return;
      if (anchorId && id === anchorId) return;
      mark(self.state.portals[id], '#e889ff', 8, null);
    });
    if (anchor && self.state.portals[anchorId]) {
      mark(self.state.portals[anchorId], '#ffd24a', 11, self.state.plan ? self.t('startPortal') : self.t('anchorNow'));
    }
    Object.keys(self.state.excluded || {}).forEach(function (id) {
      var pt = self.state.excluded[id];
      if (!pt || pt.lat == null || pt.lng == null) return;
      self.markerLayer.addLayer(L.circleMarker([pt.lat, pt.lng], {
        radius: 8,
        color: '#8a9694',
        weight: 2,
        dashArray: '4,3',
        fillColor: '#8a9694',
        fillOpacity: 0.08,
        interactive: false
      }));
    });
  };

  // Red dashed overlay on Intel links that cross the plan. Same test and stroke as
  // IITC Cross Links. Drawn on our own layer; window.links is not restyled.
  self.crossLinksLayerOn = function () {
    if (typeof MaxfieldCrossLinks === 'undefined' || !MaxfieldCrossLinks.isCrossLinksLayerOn) return false;
    return MaxfieldCrossLinks.isCrossLinksLayerOn(window.map, window.layerChooser);
  };

  self.onCrossLinksLayerToggle = function (event) {
    if (typeof MaxfieldCrossLinks === 'undefined' || !MaxfieldCrossLinks.isCrossLinksToggleEvent) return;
    if (!MaxfieldCrossLinks.isCrossLinksToggleEvent(event, window.layerChooser)) return;
    self.drawCrossHighlights(self.state.plan);
  };

  self.drawCrossHighlights = function (plan) {
    if (!self.crossLinkLayer || typeof L === 'undefined') return;
    self.crossLinkLayer.clearLayers();
    if (!self.crossLinksLayerOn()) return;
    if (!plan || !plan.links || !plan.links.length) return;
    if (typeof MaxfieldCrossLinks === 'undefined' || !window.links) return;
    var hits;
    try {
      hits = MaxfieldCrossLinks.crossedIntelLinks(plan.links, window.links);
    } catch (e) {
      return;
    }
    var style = {
      color: '#d22',
      opacity: 0.7,
      weight: 5,
      interactive: false,
      dashArray: '8,8'
    };
    var draw = (typeof L.geodesicPolyline === 'function') ? L.geodesicPolyline : L.polyline;
    hits.forEach(function (hit) {
      if (!hit || !hit.latlngs || hit.latlngs.length < 2) return;
      try {
        var ll = [
          L.latLng(hit.latlngs[0].lat, hit.latlngs[0].lng),
          L.latLng(hit.latlngs[1].lat, hit.latlngs[1].lng)
        ];
        self.crossLinkLayer.addLayer(draw(ll, style));
      } catch (e2) {}
    });
    if (self.crossLinkLayer.bringToFront) self.crossLinkLayer.bringToFront();
  };

  self.drawPlan = function (plan) {
    if (!self.planLayer) return;
    self.planLayer.clearLayers();
    if (!plan || typeof L === 'undefined') {
      self.drawCrossHighlights(null);
      return;
    }

    var fieldHex = self.getFieldHex();
    var linkHex = self.getLinkHex();
    var fieldStroke = self.darkenHex(fieldHex, 0.82);
    var fields = (plan.fields || []).slice().sort(function (a, b) {
      return (a.depth || 1) - (b.depth || 1);
    });
    var maxDepth = 1;
    fields.forEach(function (f) {
      var d = f && f.depth ? f.depth : 1;
      if (d > maxDepth) maxDepth = d;
    });
    if (!self.getFieldVisible()) fields = [];
    fields.forEach(function (f) {
      if (!f.a || f.a.lat == null || !f.b || f.b.lat == null || !f.c || f.c.lat == null) return;
      var depth = f.depth || 1;
      var opacity = (maxDepth <= 1) ? 0.22 : Math.min(0.055 * depth, 0.50);
      var poly = L.polygon(
        [[f.a.lat, f.a.lng], [f.b.lat, f.b.lng], [f.c.lat, f.c.lng]],
        {
          color: fieldStroke,
          weight: 1,
          opacity: 0.72,
          fill: true,
          fillColor: fieldHex,
          fillOpacity: opacity,
          interactive: false
        }
      );
      self.planLayer.addLayer(poly);
    });

    (self.getLinkVisible() ? (plan.links || []) : []).forEach(function (lk) {
      if (!lk.a || lk.a.lat == null || !lk.b || lk.b.lat == null) return;
      var line = L.polyline(
        [[lk.a.lat, lk.a.lng], [lk.b.lat, lk.b.lng]],
        {
          color: linkHex,
          weight: lk.isFanLink ? 2 : 1.5,
          opacity: 0.9,
          dashArray: lk.invalidUnderField ? [6, 6] : null,
          interactive: false
        }
      );
      self.planLayer.addLayer(line);
    });

    self.drawWalkRoute(plan);
    if (self.planLayer.bringToFront) self.planLayer.bringToFront();
    self.drawSelection();
    self.drawWalkNumbers(plan);
    self.drawCrossHighlights(plan);
  };

  self.init = function () {
    self.injectCSS();
    self.drawLayer = new L.LayerGroup();
    self.planLayer = new L.FeatureGroup();
    self.markerLayer = new L.FeatureGroup();
    self.crossLinkLayer = new L.FeatureGroup();
    self.drawLayer.addLayer(self.planLayer);
    self.drawLayer.addLayer(self.markerLayer);
    self.drawLayer.addLayer(self.crossLinkLayer);
    window.addLayerGroup('maxfield-planner', self.drawLayer, true);

    var toolbox = document.getElementById('toolbox');
    if (toolbox && !document.getElementById('mfp-toolbox-link')) {
      var a = document.createElement('a');
      a.id = 'mfp-toolbox-link';
      a.href = 'javascript:void(0)';
      a.textContent = self.t('toolbox');
      a.addEventListener('click', function (e) {
        e.preventDefault();
        self.togglePanel();
      });
      toolbox.appendChild(a);
    }

    window.addHook('portalSelected', self.onPortalSelected);
    window.addHook('mapDataRefreshEnd', function () {
      if (self.state.open || self.state.plan) {
        self.refreshNames();
        if (self.state.open) self.render();
        else if (self.state.plan) self.drawPlan(self.state.plan);
      }
      if (!self.state.plan || self.state.open) self.drawCrossHighlights(self.state.plan);
    });
    ['linkAdded', 'linkRemoved'].forEach(function (hookName) {
      try {
        window.addHook(hookName, function () {
          self.drawCrossHighlights(self.state.plan);
        });
      } catch (err) {}
    });
    if (window.map && window.map.on) {
      ['overlayadd', 'overlayremove', 'layeradd', 'layerremove'].forEach(function (evName) {
        window.map.on(evName, self.onCrossLinksLayerToggle);
      });
    }
    if (window.addHook) {
      try {
        window.addHook('portalDetailsUpdated', function () {
          if (self.state.open) {
            self.refreshNames();
            self.render();
          }
        });
      } catch (e) {}
      var keyHooks = ['pluginKeysRefreshUserData', 'pluginKeysUpdate', 'pluginKeysUpdated', 'pluginLiveInventoryUpdated'];
      var onKeys = function () {
        if (self.state.open && self.state.plan) self.renderResult();
      };
      keyHooks.forEach(function (name) {
        try { window.addHook(name, onKeys); } catch (err) {}
      });
    }

    window.addEventListener('resize', function () {
      self.updatePanelChrome();
    });

    if (window.map && window.map.on) {
      window.map.on('zoomend', function () {
        var plan = self.getPlan();
        if (plan && self.planLayer) self.drawPlan(plan);
      });
    }

    self.buildTab();
    self.buildPanel();
    self.state.open = false;
    self.updatePanelChrome();
    self.restoreCurrentLocal();
    if (self._currentKey == null) {
      self._currentKey = MaxfieldFavSync.currentKey(self.captureCurrentDoc());
    }
    if (self.getSyncToken()) {
      setTimeout(function () { self.syncFavorites(); }, 1500);
    }
  };


  function setup() {
    var p = window.plugin && window.plugin.maxfieldPlanner;
    if (p && plugin_info && plugin_info.script && plugin_info.script.version) {
      p.VERSION = String(plugin_info.script.version);
    }
    if (p && typeof p.init === 'function') p.init();
  }

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = {
    version: GM_info.script.version,
    name: GM_info.script.name,
    description: GM_info.script.description
  };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
