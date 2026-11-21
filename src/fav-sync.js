/* Favorites sync for maxfield-planner: merge logic (pure) + GitHub Gist client.
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

    return { findGist: findGist, createGist: createGist, readGist: readGist, writeGist: writeGist };
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

  return {
    GIST_FILE: GIST_FILE,
    newId: newId,
    migrate: migrate,
    normalizeDoc: normalizeDoc,
    merge: merge,
    sameDoc: sameDoc,
    createClient: createClient,
    syncOnce: syncOnce,
    SyncError: SyncError
  };
});
