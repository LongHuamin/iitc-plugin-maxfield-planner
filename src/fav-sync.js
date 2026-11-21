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
