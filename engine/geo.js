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
