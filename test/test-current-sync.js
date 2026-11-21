#!/usr/bin/env node
'use strict';
var S = require('../src/fav-sync');
var passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  ok  ' + m); }
  else { failed++; console.log('  FAIL  ' + m); }
}

function portal(guid, name) {
  return { guid: guid, lat: 1, lng: 2, name: name || guid };
}
function doc(extra) {
  var d = {
    updatedAt: 100,
    clientId: 'desk',
    planned: true,
    startingpointIndex: 1,
    is_clockwise: true,
    stardirection: -1,
    availableSBUL: 2,
    portals: [portal('a', 'A'), portal('b', 'B'), portal('c', 'C')],
    excluded: [portal('x', 'X')],
    listOrder: ['a', 'x', 'b', 'c']
  };
  Object.keys(extra || {}).forEach(function (k) { d[k] = extra[k]; });
  return d;
}

console.log('1. newest remote wins, older remote does not');
ok(S.shouldApplyCurrent(doc({ updatedAt: 100, clientId: 'desk' }), doc({ updatedAt: 200, clientId: 'phone' }), 'desk'),
  'newer plan from another device replaces local');
ok(!S.shouldApplyCurrent(doc({ updatedAt: 300, clientId: 'desk' }), doc({ updatedAt: 200, clientId: 'phone' }), 'desk'),
  'older remote does not replace newer local');
ok(!S.shouldApplyCurrent(doc({ updatedAt: 200, clientId: 'desk' }), doc({ updatedAt: 200, clientId: 'phone' }), 'desk'),
  'equal timestamp does not replace local');
ok(S.decideCurrent(doc({ updatedAt: 100 }), doc({ updatedAt: 250, clientId: 'phone', availableSBUL: 4 }), 'desk').action === 'apply',
  'decide applies the newer other-device plan');
ok(S.decideCurrent(doc({ updatedAt: 400, availableSBUL: 1 }), doc({ updatedAt: 250, clientId: 'phone' }), 'desk').action === 'push',
  'decide pushes when local is newer');

console.log('2. same clientId is not applied');
ok(!S.shouldApplyCurrent(doc({ updatedAt: 100, clientId: 'desk' }), doc({ updatedAt: 999, clientId: 'desk' }), 'desk'),
  'newer remote written by this device is skipped');
ok(S.decideCurrent(doc({ updatedAt: 100, clientId: 'desk' }), doc({ updatedAt: 999, clientId: 'desk', portals: [portal('z')] }), 'desk').action === 'skip',
  'same-client remote is not applied and does not get overwritten');
ok(S.sameCurrent(doc({ updatedAt: 1, clientId: 'desk' }), doc({ updatedAt: 9, clientId: 'phone' })),
  'content compare ignores updatedAt and clientId');

console.log('3. syncCurrent against a mock gist');
function mockApi() {
  var gists = {}; var n = 0; var calls = [];
  function resp(status, body) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); }
    });
  }
  function f(url, init) {
    calls.push({ url: url, method: init.method });
    if (!init.headers || init.headers.Authorization !== 'Bearer good') return resp(401, {});
    var u = url.replace('https://api.github.com', '');
    var body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'GET' && /^\/gists\?/.test(u)) {
      return resp(200, Object.keys(gists).map(function (id) { return { id: id, files: gists[id].files }; }));
    }
    if (init.method === 'POST' && u === '/gists') {
      var id = 'g' + (++n) + 'bbbbbbbbbbbbbbbbbbbb';
      ok(body.public === false, 'created gist is private');
      gists[id] = { id: id, files: body.files };
      return resp(201, gists[id]);
    }
    var mm = u.match(/^\/gists\/([^/?]+)$/);
    if (mm) {
      var g = gists[mm[1]];
      if (!g) return resp(404, {});
      if (init.method === 'GET') return resp(200, g);
      if (init.method === 'PATCH') {
        Object.keys(body.files).forEach(function (k) { g.files[k] = body.files[k]; });
        return resp(200, g);
      }
    }
    return resp(400, {});
  }
  return { fetch: f, gists: gists, calls: calls };
}
function patches(api) {
  return api.calls.filter(function (c) { return c.method === 'PATCH'; }).length;
}
function posts(api) {
  return api.calls.filter(function (c) { return c.method === 'POST'; }).length;
}
function currentText(api, id) {
  var file = api.gists[id].files[S.CURRENT_FILE];
  return file && file.content;
}

var api = mockApi();
var favBody = JSON.stringify({ favorites: [{ id: 'keep', updatedAt: 1, savedAt: 1 }], tombstones: {} });
api.gists.seedaaaaaaaaaaaaaaaaaaaa = {
  id: 'seedaaaaaaaaaaaaaaaaaaaa',
  files: { 'maxfield-planner-favorites.json': { content: favBody } }
};

var localNewer = doc({ updatedAt: 500, clientId: 'desk' });
var remoteOlder = doc({ updatedAt: 100, clientId: 'phone', startingpointIndex: 0 });
api.gists.seedaaaaaaaaaaaaaaaaaaaa.files[S.CURRENT_FILE] = { content: JSON.stringify(remoteOlder) };

S.syncCurrent({ token: 'good', gistId: 'seedaaaaaaaaaaaaaaaaaaaa', local: localNewer, clientId: 'desk', fetch: api.fetch })
.then(function (res) {
  ok(res.pushed && !res.apply, 'newer local plan is pushed');
  ok(patches(api) === 1, 'one PATCH for a real change');
  var saved = JSON.parse(currentText(api, res.gistId));
  ok(saved.startingpointIndex === 1 && saved.clientId === 'desk', 'pushed plan keeps anchor and clientId');
  ok(saved.portals.map(function (p) { return p.guid; }).join(',') === 'a,b,c', 'selected portals stay in list order');
  ok(saved.excluded[0].guid === 'x' && saved.excluded[0].name === 'X', 'excluded portal is stored');
  ok(api.gists[res.gistId].files['maxfield-planner-favorites.json'].content === favBody, 'favorites file is left untouched');
  var sameAgain = doc({ updatedAt: 800, clientId: 'desk' });
  return S.syncCurrent({ token: 'good', gistId: res.gistId, local: sameAgain, clientId: 'desk', fetch: api.fetch });
}).then(function (res2) {
  ok(!res2.pushed && !res2.apply, 'unchanged content is not pushed');
  ok(patches(api) === 1, 'no second PATCH when only updatedAt changed');
  var phone = doc({ updatedAt: 900, clientId: 'phone', availableSBUL: 4, stardirection: 1, is_clockwise: false });
  api.gists[res2.gistId].files[S.CURRENT_FILE] = { content: JSON.stringify(phone) };
  return S.syncCurrent({ token: 'good', gistId: res2.gistId, local: doc({ updatedAt: 500, clientId: 'desk' }), clientId: 'desk', fetch: api.fetch })
    .then(function (res3) {
      ok(res3.apply && !res3.pushed && res3.doc.clientId === 'phone', 'newer other-device plan is applied, not overwritten');
      ok(res3.doc.availableSBUL === 4 && res3.doc.stardirection === 1 && res3.doc.is_clockwise === false,
        'applied plan keeps SBUL, direction and clockwise');
      ok(patches(api) === 1, 'apply does not PATCH');
      api.gists[res2.gistId].files[S.CURRENT_FILE] = {
        content: JSON.stringify(doc({ updatedAt: 2000, clientId: 'desk', availableSBUL: 0 }))
      };
      return S.syncCurrent({
        token: 'good', gistId: res2.gistId,
        local: doc({ updatedAt: 100, clientId: 'desk', portals: [portal('only')] }),
        clientId: 'desk', fetch: api.fetch
      });
    });
}).then(function (res4) {
  ok(!res4.apply && !res4.pushed, 'same clientId does not apply and does not overwrite the gist');
  ok(patches(api) === 1, 'same-client skip performs no PATCH');
  var cleared = doc({
    updatedAt: 3000, clientId: 'phone', planned: false, startingpointIndex: 0,
    portals: [], excluded: [], listOrder: []
  });
  return S.syncCurrent({ token: 'good', gistId: 'seedaaaaaaaaaaaaaaaaaaaa', local: cleared, clientId: 'phone', fetch: api.fetch });
}).then(function (res5) {
  ok(res5.pushed, 'a cleared plan is still pushed');
  var saved = JSON.parse(currentText(api, res5.gistId));
  ok(saved.planned === false && saved.portals.length === 0, 'cleared snapshot has no portals and no plan');
  ok(api.gists[res5.gistId].files['maxfield-planner-favorites.json'].content === favBody, 'clearing the plan does not touch favorites');
  var fresh = mockApi();
  return S.syncCurrent({
    token: 'good', gistId: '', local: doc({ updatedAt: 0, clientId: 'desk', planned: false, portals: [], excluded: [], listOrder: [] }),
    clientId: 'desk', fetch: fresh.fetch
  }).then(function (res6) {
    ok(!res6.pushed && posts(fresh) === 0, 'untouched local state does not create a gist');
    return S.syncCurrent({
      token: 'good', gistId: '', local: doc({ updatedAt: 50, clientId: 'desk' }), clientId: 'desk', fetch: fresh.fetch
    });
  });
}).then(function (res7) {
  ok(res7.pushed && res7.gistId, 'first real plan creates the gist when none exists');
  ok(api.calls.every(function (c) { return c.url.indexOf('https://api.github.com/') === 0; }), 'only api.github.com is called');
  return debounceTest();
}).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, function (e) {
  console.log('  FAIL  unexpected ' + (e && (e.stack || e.message || e)));
  process.exit(1);
});

function debounceTest() {
  console.log('4. debounce and no-change skip');
  var items = [];
  var seq = 0;
  var pushes = [];
  var harness = {
    setTimer: function (fn, ms) {
      var t = { id: ++seq, fn: fn, ms: ms, on: true };
      items.push(t);
      return t.id;
    },
    clearTimer: function (id) {
      items.forEach(function (t) { if (t.id === id) t.on = false; });
    }
  };
  function active() { return items.filter(function (t) { return t.on; }); }
  var current = doc({ updatedAt: 10, clientId: 'desk' });
  var sched = S.createCurrentScheduler({
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
    getDoc: function () { return current; },
    push: function (d) {
      pushes.push(S.currentKey(d));
      return Promise.resolve({ pushed: true });
    }
  });
  ok(sched.delay === 2000, 'default debounce is 2s');
  sched.schedule();
  sched.schedule();
  var pending = active();
  ok(pending.length === 1, 'two edits collapse to one timer');
  ok(pending[0].ms === 2000, 'timer waits about 2s');
  pending[0].on = false;
  pending[0].fn();
  ok(pushes.length === 1, 'timer fires a single push');
  sched.schedule();
  var again = active();
  ok(again.length === 1, 'a later edit schedules again');
  again[0].on = false;
  again[0].fn();
  ok(pushes.length === 1, 'same content does not push again');
  current = doc({
    updatedAt: 40, clientId: 'desk', planned: false, startingpointIndex: 0,
    portals: [], excluded: [], listOrder: []
  });
  sched.schedule();
  var cleared = active();
  cleared[0].on = false;
  cleared[0].fn();
  ok(pushes.length === 2, 'clearing the plan pushes the empty state');
  return Promise.resolve();
}
