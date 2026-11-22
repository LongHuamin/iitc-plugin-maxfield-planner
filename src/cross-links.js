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
