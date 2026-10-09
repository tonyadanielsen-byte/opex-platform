'use strict';

/*
 * Simulert Realtime Database for tester (bare det Saker-datalaget trenger). IKKE en erstatning for
 * ekte Firebase, men bevisst streng på det som lett går galt:
 *  - nøkler med . $ # [ ] / eller kontrolltegn avvises (som ekte RTDB)
 *  - undefined-verdier avvises (som ekte RTDB)
 *  - null sletter; tomme objekter lagres ikke
 *  - update() er atomisk (alt eller ingenting) og avviser overlappende stier
 *  - transaction() følger server-semantikken: funksjonen kan få null først (kald cache) og kalles på nytt
 *    hvis serverens verdi er en annen enn den funksjonen så; undefined avbryter
 *  - hooks for å simulere feil og samtidige skrivinger
 */

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const BAD_SEGMENT = /[.#$\[\]\u0000-\u001f\u007f]/;

function segments(path) {
  const parts = String(path).split('/').filter((p, i, a) => !(p === '' && (i === 0 || i === a.length - 1)));
  for (const p of parts) {
    if (p === '' || BAD_SEGMENT.test(p) || p.length > 700) throw new Error(`Ugyldig RTDB-nøkkel i sti: ${JSON.stringify(path)}`);
  }
  return parts;
}

function normalizeValue(value, where) {
  if (value === undefined) throw new Error(`Verdi er undefined på ${where}`);
  if (value === null) return null;
  if (Array.isArray(value)) throw new Error(`Arrays er ikke tillatt i denne modellen (${where})`);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '' || BAD_SEGMENT.test(k)) throw new Error(`Ugyldig RTDB-nøkkel ${JSON.stringify(k)} på ${where}`);
      const n = normalizeValue(v, `${where}/${k}`);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Ugyldig tall på ${where}`);
  return value;
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

class Snapshot {
  constructor(key, value) { this.key = key; this._v = value === undefined ? null : clone(value); }
  exists() { return this._v !== null; }
  val() { return clone(this._v); }
}

class Query {
  constructor(db, path, mods = {}) { this.db = db; this.path = path; this.mods = mods; }
  orderByChild(child) { return new Query(this.db, this.path, { ...this.mods, order: { child } }); }
  orderByKey() { return new Query(this.db, this.path, { ...this.mods, order: { key: true } }); }
  equalTo(value) { return new Query(this.db, this.path, { ...this.mods, equal: value }); }
  limitToLast(n) { return new Query(this.db, this.path, { ...this.mods, last: n }); }
  async get() {
    this.db.reads.push(this.path);
    if (this.db.onGet) await this.db.onGet(this.path);
    const node = this.db._get(segments(this.path));
    if (!this.mods.order && !this.mods.last && !('equal' in this.mods)) {
      return new Snapshot(this.path.split('/').pop() || null, node); // vanlig get(): selve verdien (også enkeltverdier)
    }
    let entries = node && typeof node === 'object' ? Object.entries(node) : [];
    if (this.mods.order?.child) {
      const c = this.mods.order.child;
      entries = entries.filter(([, v]) => v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, c));
      if ('equal' in this.mods) entries = entries.filter(([, v]) => v[c] === this.mods.equal);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (this.mods.last) entries = entries.slice(-this.mods.last);
    const value = entries.length ? Object.fromEntries(entries) : null;
    return new Snapshot(this.path.split('/').pop() || null, value);
  }
}

class Ref extends Query {
  get key() { const s = segments(this.path); return s.length ? s[s.length - 1] : null; }
  child(p) { return new Ref(this.db, `${this.path}/${p}`); }
  push() { return new Ref(this.db, `${this.path}/${this.db._nextKey()}`); }
  async set(value) { return this.db._applyMany({ [this.path]: value }); }
  async update(updates) {
    const base = segments(this.path);
    const abs = {};
    for (const [k, v] of Object.entries(updates)) abs['/' + [...base, ...segments(k)].join('/')] = v;
    if (this.db.onBeforeUpdate) await this.db.onBeforeUpdate(Object.keys(abs));
    return this.db._applyMany(abs, true);
  }
  async transaction(fn) {
    return this.db._transaction(this.path, fn);
  }
}

class FakeRtdb {
  constructor(initial = {}, opts = {}) {
    this.data = normalizeValue(initial, '/') || {};
    this.coldTransactions = !!opts.coldTransactions; // første kall av transaksjonsfunksjonen får null
    this.reads = [];
    this.updateCalls = [];   // vellykkede update()-kall (dyp kopi)
    this.transactionCalls = []; // {path, committed}
    this.failUpdates = 0;    // antall kommende update()-kall som skal feile
    this.failWhen = null;    // (updates) => boolean — feiler bare update()-kall som matcher (målrettet feilinjeksjon)
    this.onBeforeUpdate = null; // async (paths) => void — kjøres rett FØR en update() skrives (lar andre operasjoner slippe til)
    this.beforeCommit = null; // (path) => void  — kjøres midt i en transaksjon (simulerer samtidig skriving)
    this.onGet = null;       // async (path) => void — kjøres før en lesing (lar en test endre tilstand på et presist sted)
    this.onTransaction = null; // async (path) => void — kjøres før en transaksjon starter; kan kaste eller kjøre andre operasjoner
    this._keys = 0;
  }
  ref(path = '/') { return new Ref(this, '/' + segments(path).join('/')); }
  _nextKey() { this._keys += 1; return '-Ofake' + String(this._keys).padStart(6, '0'); }
  _get(segs) {
    let node = this.data;
    for (const s of segs) {
      if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, s)) return null;
      node = node[s];
    }
    return node === undefined ? null : node;
  }
  _setRaw(segs, value) {
    if (!segs.length) { this.data = value || {}; return; }
    let node = this.data;
    for (let i = 0; i < segs.length - 1; i++) {
      if (node[segs[i]] === null || typeof node[segs[i]] !== 'object') node[segs[i]] = {};
      node = node[segs[i]];
    }
    const last = segs[segs.length - 1];
    if (value === null) delete node[last]; else node[last] = value;
    this._prune(segs);
  }
  _prune(segs) {
    for (let n = segs.length - 1; n >= 1; n--) {
      const parent = this._get(segs.slice(0, n));
      if (parent && typeof parent === 'object' && Object.keys(parent).length === 0) this._setRaw(segs.slice(0, n), null);
      else break;
    }
  }
  // Atomisk: valider alt først, deretter bruk alt.
  _applyMany(paths, isUpdate = false) {
    const entries = Object.entries(paths).map(([p, v]) => [segments(p), normalizeValue(v, p)]);
    if (isUpdate) {
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        const [a, b] = [entries[i][0], entries[j][0]];
        const n = Math.min(a.length, b.length);
        if (a.slice(0, n).join('/') === b.slice(0, n).join('/')) throw new Error('Overlappende stier i update(): ' + a.join('/') + ' og ' + b.join('/'));
      }
    }
    if (isUpdate && this.failWhen && this.failWhen(clone(paths))) throw new Error('simulert databasefeil (målrettet)');
    if (this.failUpdates > 0) { this.failUpdates -= 1; throw new Error('simulert databasefeil'); }
    for (const [segs, value] of entries) this._setRaw(segs, clone(value));
    if (isUpdate) this.updateCalls.push(clone(paths));
  }
  async _transaction(path, fn) {
    if (this.onTransaction) await this.onTransaction(path);
    const segs = segments(path);
    let seen = this.coldTransactions ? null : clone(this._get(segs));
    for (let attempt = 0; attempt < 25; attempt++) {
      const next = fn(clone(seen));
      if (this.beforeCommit) this.beforeCommit(path);
      const actual = clone(this._get(segs));
      if (next === undefined) {
        this.transactionCalls.push({ path, committed: false });
        return { committed: false, snapshot: new Snapshot(segs[segs.length - 1] || null, actual) };
      }
      if (deepEqual(seen, actual)) {
        const normalized = normalizeValue(next, path);
        this._setRaw(segs, clone(normalized));
        this.transactionCalls.push({ path, committed: true });
        return { committed: true, snapshot: new Snapshot(segs[segs.length - 1] || null, normalized) };
      }
      seen = actual; // serveren hadde en annen verdi: prøv på nytt med den
    }
    throw new Error('transaksjon ga opp');
  }
  /** Hjelper for tester. */
  at(path) { return clone(this._get(segments(path))); }
}

module.exports = { FakeRtdb, clone };
