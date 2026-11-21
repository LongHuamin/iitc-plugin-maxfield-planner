#!/usr/bin/env node
'use strict';
var S = require('../src/fav-sync');
var passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('  ok  ' + m); } else { failed++; console.log('  FAIL  ' + m); } }
function ids(doc) { return doc.favorites.map(function (f) { return f.id; }).join(','); }

console.log('1. migrate');
var m = S.migrate([{ name: 'old', savedAt: 1000 }, { id: 'x', name: 'x' }, { id: 'x', name: 'dup', savedAt: 5 }, null], 9999);
ok(m.changed, 'migration reports a change');
ok(m.list.length === 3, 'null entry dropped, 3 kept');
ok(m.list.every(function (f) { return f.id && f.updatedAt && f.savedAt; }), 'all get id/updatedAt/savedAt');
ok(m.list[0].updatedAt === 1000, 'updatedAt falls back to savedAt');
ok(m.list[1].updatedAt === 9999, 'updatedAt falls back to now');
ok(m.list[2].id !== 'x', 'duplicate id gets a new id');
var m2 = S.migrate(m.list);
ok(!m2.changed, 'second migration is a no-op');

console.log('2. merge');
var A = { favorites: [{ id: 'a', name: 'A1', savedAt: 10, updatedAt: 10 }, { id: 'b', name: 'B-old', savedAt: 20, updatedAt: 20 }], tombstones: {} };
var B = { favorites: [{ id: 'b', name: 'B-new', savedAt: 20, updatedAt: 30 }, { id: 'c', name: 'C', savedAt: 40, updatedAt: 40 }], tombstones: { a: 15 } };
var r = S.merge(A, B);
ok(ids(r) === 'c,b', 'a deleted by newer tombstone, sorted newest first: ' + ids(r));
ok(r.favorites[1].name === 'B-new', 'newest updatedAt wins');
ok(r.tombstones.a === 15, 'tombstone kept');
ok(ids(S.merge(B, A)) === ids(r), 'merge is symmetric');
var r2 = S.merge(r, { favorites: [{ id: 'a', name: 'A2', savedAt: 10, updatedAt: 99 }], tombstones: {} });
ok(r2.favorites.some(function (f) { return f.id === 'a'; }), 'favorite updated after its tombstone survives');
ok(S.sameDoc(S.merge(r, r), r), 'merge is idempotent');
ok(S.sameDoc(S.normalizeDoc([{ id: 'q', savedAt: 1, updatedAt: 1 }]), { favorites: [{ id: 'q', savedAt: 1, updatedAt: 1 }], tombstones: {} }), 'plain array is accepted as a document');

console.log('3. syncOnce against a mock Gist API');
function mockApi() {
  var gists = {}; var n = 0; var calls = [];
  function resp(status, body) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status: status,
      json: function () { return Promise.resolve(body); }, text: function () { return Promise.resolve(JSON.stringify(body)); } });
  }
  function f(url, init) {
    calls.push({ url: url, method: init.method, auth: init.headers && init.headers.Authorization });
    if (!init.headers || init.headers.Authorization !== 'Bearer good') return resp(401, {});
    var u = url.replace('https://api.github.com', '');
    var body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'GET' && /^\/gists\?/.test(u)) {
      return resp(200, Object.keys(gists).map(function (id) { return { id: id, files: gists[id].files }; }));
    }
    if (init.method === 'POST' && u === '/gists') {
      var id = 'g' + (++n) + 'aaaaaaaaaaaaaaaaaaaa';
      ok(body.public === false, 'created gist is private');
      gists[id] = { id: id, files: body.files };
      return resp(201, gists[id]);
    }
    var mm = u.match(/^\/gists\/([^/?]+)$/);
    if (mm) {
      var g = gists[mm[1]];
      if (!g) return resp(404, {});
      if (init.method === 'GET') return resp(200, g);
      if (init.method === 'PATCH') { Object.keys(body.files).forEach(function (k) { g.files[k] = body.files[k]; }); return resp(200, g); }
    }
    return resp(400, {});
  }
  return { fetch: f, gists: gists, calls: calls };
}

var api = mockApi();
var desktop = { favorites: [{ id: 'd1', name: 'D1', savedAt: 100, updatedAt: 100 }], tombstones: {} };
var mobile = { favorites: [{ id: 'm1', name: 'M1', savedAt: 200, updatedAt: 200 }], tombstones: {} };

S.syncOnce({ token: 'good', gistId: '', local: desktop, fetch: api.fetch }).then(function (res1) {
  ok(res1.pushed && res1.gistId, 'desktop: no gist yet -> created ' + res1.gistId);
  return S.syncOnce({ token: 'good', gistId: '', local: mobile, fetch: api.fetch }).then(function (res2) {
    ok(res2.gistId === res1.gistId, 'mobile without gist id finds the same gist');
    ok(ids(res2.doc) === 'm1,d1', 'mobile now has both: ' + ids(res2.doc));
    ok(res2.pushed, 'mobile pushed merged result');
    // desktop deletes d1 (tombstone) and syncs
    var desk2 = { favorites: [], tombstones: { d1: 300 } };
    return S.syncOnce({ token: 'good', gistId: res1.gistId, local: desk2, fetch: api.fetch });
  }).then(function (res3) {
    ok(ids(res3.doc) === 'm1', 'deletion propagates via tombstone: ' + ids(res3.doc));
    var mob2 = { favorites: [{ id: 'm1', name: 'M1', savedAt: 200, updatedAt: 200 }, { id: 'd1', name: 'D1', savedAt: 100, updatedAt: 100 }], tombstones: {} };
    return S.syncOnce({ token: 'good', gistId: res1.gistId, local: mob2, fetch: api.fetch });
  }).then(function (res4) {
    ok(ids(res4.doc) === 'm1', 'mobile stale copy does not resurrect deleted favorite');
    ok(!res4.pushed, 'nothing to push when merged equals remote');
    return S.syncOnce({ token: 'bad', gistId: res1.gistId, local: mobile, fetch: api.fetch }).then(function () {
      ok(false, 'bad token should fail');
    }, function (err) { ok(err && err.code === 'auth', 'bad token -> auth error'); });
  }).then(function () {
    return S.syncOnce({ token: 'good', gistId: 'nope', local: mobile, fetch: api.fetch }).then(function () {
      ok(false, 'missing gist should fail');
    }, function (err) { ok(err && err.code === 'notfound', 'unknown gist id -> notfound'); });
  }).then(function () {
    return S.syncOnce({ token: 'good', gistId: '', local: mobile, fetch: function () { return Promise.reject(new Error('offline')); } }).then(function () {
      ok(false, 'offline should fail');
    }, function (err) { ok(err && err.code === 'network', 'offline -> network error'); });
  });
}).then(function () {
  ok(api.calls.every(function (c) { return c.url.indexOf('https://api.github.com/') === 0; }), 'only api.github.com is called');
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, function (e) { console.log('  FAIL  unexpected ' + (e && (e.code || e.message))); process.exit(1); });
