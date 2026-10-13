/*
 * Nettleser-stub av Firebase compat-SDK, kun for UI-tester. Erstatter gstatic-skriptene.
 * Oppfører seg som den ekte klienten på de punktene OpEx bruker:
 *  - firebase.auth(): setPersistence, onAuthStateChanged, currentUser (med getIdToken), signOut
 *  - firebase.database().ref(path): on/once/off('value'), child, push, set, update, remove
 *  - sanntidslytter: tiltak-oppdateringer fra "serveren" (testharnessen) utløser on('value') på nytt
 * Alle klientskrivinger logges i window.__stubDb.writes, slik at tester kan bevise at UI ikke skriver direkte.
 */
(function () {
  var init = window.__STUB_INIT__ || {};
  var data = JSON.parse(JSON.stringify(init.data || {}));
  var writes = [];
  var listeners = [];
  var seq = 0;

  function parts(path) { return String(path).split('/').filter(Boolean); }
  function getAt(path) {
    var node = data;
    var p = parts(path);
    for (var i = 0; i < p.length; i++) {
      if (node === null || typeof node !== 'object' || !(p[i] in node)) return null;
      node = node[p[i]];
    }
    return node === undefined ? null : node;
  }
  function setAt(path, value) {
    var p = parts(path);
    if (!p.length) { data = value || {}; return; }
    var node = data;
    for (var i = 0; i < p.length - 1; i++) {
      if (node[p[i]] === null || typeof node[p[i]] !== 'object') node[p[i]] = {};
      node = node[p[i]];
    }
    if (value === null || value === undefined) delete node[p[p.length - 1]];
    else node[p[p.length - 1]] = JSON.parse(JSON.stringify(value));
  }
  function related(a, b) { // en lytter på `a` berøres av en endring på `b` hvis den ene er prefiks av den andre
    var x = parts(a).join('/'), y = parts(b).join('/');
    return x === y || x.indexOf(y + '/') === 0 || y.indexOf(x + '/') === 0 || x === '' || y === '';
  }
  function snapshot(path) {
    var value = getAt(path);
    var p = parts(path);
    return {
      key: p.length ? p[p.length - 1] : null,
      val: function () { return value === null ? null : JSON.parse(JSON.stringify(value)); },
      exists: function () { return value !== null; },
      forEach: function (cb) {
        if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { cb(snapshot(path + '/' + k)); });
      },
    };
  }
  function notify(changedPath) {
    listeners.slice().forEach(function (l) {
      if (related(l.path, changedPath)) setTimeout(function () { l.cb(snapshot(l.path)); }, 0);
    });
  }

  function Ref(path) { this.path = parts(path).join('/'); this.key = parts(path).slice(-1)[0] || null; }
  Ref.prototype.child = function (p) { return new Ref(this.path + '/' + p); };
  Ref.prototype.on = function (evt, cb) {
    var self = this;
    listeners.push({ path: this.path, cb: cb });
    setTimeout(function () { cb(snapshot(self.path)); }, 0);
    return cb;
  };
  Ref.prototype.off = function () { var p = this.path; listeners = listeners.filter(function (l) { return l.path !== p; }); };
  Ref.prototype.once = function () { var self = this; return Promise.resolve(snapshot(self.path)); };
  Ref.prototype.set = function (v) { writes.push({ op: 'set', path: this.path }); setAt(this.path, v); notify(this.path); return Promise.resolve(); };
  Ref.prototype.update = function (obj) {
    var self = this;
    writes.push({ op: 'update', path: this.path, keys: Object.keys(obj || {}) });
    Object.keys(obj || {}).forEach(function (k) { setAt(self.path + '/' + k, obj[k]); });
    notify(this.path);
    return Promise.resolve();
  };
  Ref.prototype.remove = function () { writes.push({ op: 'remove', path: this.path }); setAt(this.path, null); notify(this.path); return Promise.resolve(); };
  Ref.prototype.push = function (v) {
    seq += 1;
    var key = '-Ostub' + String(seq).padStart(6, '0');
    var child = this.child(key);
    var promise = Promise.resolve();
    promise.key = key;
    if (v !== undefined) { writes.push({ op: 'push', path: this.path }); setAt(child.path, v); notify(child.path); }
    return promise;
  };

  var user = {
    uid: init.uid || 'uid-a',
    email: init.email || 'bruker@example.test',
    displayName: init.name || 'Test Bruker',
    getIdToken: function () { return Promise.resolve('TOKEN-' + (init.uid || 'uid-a')); },
  };
  var authCbs = [];
  var authObj = {
    currentUser: null,
    setPersistence: function () { return Promise.resolve(); },
    onAuthStateChanged: function (cb) {
      authCbs.push(cb);
      setTimeout(function () { authObj.currentUser = init.signedOut ? null : user; cb(authObj.currentUser); }, 0);
      return function () {};
    },
    signOut: function () { authObj.currentUser = null; authCbs.forEach(function (cb) { cb(null); }); return Promise.resolve(); },
    signInWithEmailAndPassword: function () { return Promise.reject({ code: 'auth/invalid-credential' }); },
    sendPasswordResetEmail: function () { return Promise.resolve(); },
  };

  var dbObj = { ref: function (p) { return new Ref(p || ''); } };

  window.firebase = {
    initializeApp: function () { return {}; },
    database: function () { return dbObj; },
    auth: function () { return authObj; },
  };
  window.firebase.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };

  // Kontroll fra testharnessen (representerer «serveren» som sender oppdateringer til den åpne klienten).
  window.__stubDb = {
    writes: writes,
    get: function (p) { return getAt(p); },
    set: function (p, v) { setAt(p, v); notify(p); },
  };
})();
