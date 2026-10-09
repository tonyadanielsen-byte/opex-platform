'use strict';

/*
 * UI-testharness: kjører den EKTE index.html (med samme injiserte filer som service workeren legger til i produksjon)
 * i Chromium (Playwright), mot
 *   - en Firebase-stub i nettleseren (tests/ui/firebase-stub.js), og
 *   - en simulert backend: de EKTE sak-core-funksjonene mot FakeRtdb, nådd via den vanlige callable-protokollen.
 * Etter hver callable synkroniseres /tiltak til siden, som en ekte sanntidslytter ville gjort.
 * Dette er SIMULERT datalag: det beviser at UI og kontrakten fungerer sammen, ikke at ekte Firebase gjør det.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../functions/sak-core');
const { FakeRtdb } = require('../helpers/fake-rtdb.cjs');
const fx = require('./fixtures.cjs');

const ROOT = path.join(__dirname, '..', '..');
const FUNCTIONS_HOST = 'europe-west1-opex-nortura.cloudfunctions.net';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const OPS = {
  createSakV1: core.createSak, getSakerV1: core.getSaker, getSakV1: core.getSak, updateSakV1: core.updateSak,
  setTiltakSakV1: core.setTiltakSak, removeTiltakSakV1: core.removeTiltakSak, createArsakV1: core.createArsak, updateArsakV1: core.updateArsak,
};
const HTTP = { 'invalid-argument': [400, 'INVALID_ARGUMENT'], unauthenticated: [401, 'UNAUTHENTICATED'], 'permission-denied': [403, 'PERMISSION_DENIED'], 'not-found': [404, 'NOT_FOUND'], aborted: [409, 'ABORTED'], 'failed-precondition': [400, 'FAILED_PRECONDITION'], internal: [500, 'INTERNAL'] };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST,OPTIONS' };

function loadPlaywright() {
  for (const id of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright']) {
    if (!id) continue;
    try { return require(id); } catch (_) { /* neste */ }
  }
  return null;
}

/** Samme injeksjon som sw.js (injectPushModule) gjør ved navigasjon i produksjon. */
function injectLikeServiceWorker(html) {
  let i = html;
  if (!i.includes('push-deeplink-v1d.js')) i = i.replace('</body>', '<script src="./push-deeplink-v1d.js"></script></body>');
  if (!i.includes('ui-v1f.css')) i = i.replace('</head>', '<link rel="stylesheet" href="./ui-v1f.css?v=1"></head>');
  if (!i.includes('live-v38.css')) i = i.replace('</head>', '<link rel="stylesheet" href="./live-v38.css?v=38"></head>');
  if (!i.includes('ui-v1f.js')) i = i.replace('</body>', '<script src="./ui-v1f.js?v=43"></script></body>');
  if (!i.includes('id-v1.js')) i = i.replace('</body>', '<script src="./id-v1.js?v=43"></script></body>');
  return i;
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (rel === '/index.html') body = Buffer.from(injectLikeServiceWorker(body.toString('utf8')));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

class SimBackend {
  constructor({ tiltak, authorized = fx.AUTHORIZED, now = fx.NOW_ISO }) {
    this.db = new FakeRtdb({ authorizedUsers: authorized, tiltak: JSON.parse(JSON.stringify(tiltak)) });
    this.t = Date.parse(now);
    this.deps = { db: this.db, now: () => new Date(++this.t), sleep: async () => {}, log: { error: () => {} } };
    this.calls = [];        // {fn, uid, data, ok, code}
    this.failures = [];     // {fn, code, message, times}
    this.latency = 0;
    this.pageSync = null;
  }
  failNext(fn, code, message, times = 1) { this.failures.push({ fn, code, message, times }); }
  async handle(fn, uid, data) {
    if (this.latency) await new Promise((r) => setTimeout(r, this.latency));
    const f = this.failures.find((x) => x.fn === fn && x.times > 0);
    if (f) { f.times -= 1; this.calls.push({ fn, uid, data, ok: false, code: f.code }); return { error: { code: f.code, message: f.message } }; }
    const op = OPS[fn];
    if (!op) { this.calls.push({ fn, uid, data, ok: true, ignored: true }); return { result: { items: [], comments: [] } }; }
    try {
      const result = await op(this.deps, uid, data);
      this.calls.push({ fn, uid, data, ok: true });
      if (this.pageSync) await this.pageSync(this.db.at('/tiltak'));
      return { result };
    } catch (err) {
      this.calls.push({ fn, uid, data, ok: false, code: err.code });
      if (this.pageSync) await this.pageSync(this.db.at('/tiltak'));
      return { error: { code: err.code || 'internal', message: err.code ? err.message : 'Uventet feil. Prøv igjen.' } };
    }
  }
}

/**
 * Fyller backend med en realistisk «Ribbefett»-sak via de ekte sak-core-operasjonene (ikke hardkodet i produktet).
 * Returnerer { sakId, sporA, sporB, kode }. Bruker siden må deretter oppdateres (app.reloadSaker()).
 */
async function seedRibbefett(app, opts = {}) {
  const { backend } = app;
  const uid = fx.TONY;
  const call = (op, data) => op(backend.deps, uid, data);
  const sak = await call(core.createSak, {
    tittel: 'Ribbefett 2025', problemstilling: 'Restlager på 2 318 kg ribbefett. Tapet er anslått til ca. 168 700 kr (72,78 kr/kg). Vi må forstå hvorfor det oppstod og hindre at det skjer igjen.',
    eierUid: uid, omrader: ['Ferdigmat', 'Frysa'],
    spor: [{ sporsmal: 'Hvorfor ble det restlager?' }, { sporsmal: 'Hvordan unngår vi utgått vare i kjeden?' }],
  });
  const [a, b] = sak.sporIds.map((x) => x.sporId);
  const link = (id, ids) => call(core.setTiltakSak, { sakId: sak.sakId, tiltakId: id, sporIds: ids });
  if (!opts.utenTiltak) {
    await link('-Orib1', [a]); await link('-Orib2', [a]); await link('-Orib3', [a]);
    await link('-Orib4', [b]); await link('-Orib5', [b]); await link('-Orib6', [a, b]);
    await link('-Orib7', []);
  }
  if (!opts.utenArsaker) {
    await call(core.createArsak, { sakId: sak.sakId, sporId: a, tekst: 'Bestilling fra Constellation ble ikke batchstyrt', status: 'bekreftet', grunnlag: 'Bekreftet i møte 12.09 med innkjøp.' });
    await call(core.createArsak, { sakId: sak.sakId, sporId: a, tekst: 'Utgått vare ble sendt videre fra Frysa', status: 'hypotese' });
    await call(core.createArsak, { sakId: sak.sakId, sporId: b, tekst: 'Datokontroll mangler ved mottak', status: 'støttet', grunnlag: 'Tre avvik siste kvartal uten datosjekk.' });
  }
  if (opts.status) await call(core.updateSak, { sakId: sak.sakId, status: opts.status });
  return { sakId: sak.sakId, kode: sak.kode, sporA: a, sporB: b };
}

/** Synker tiltak til siden og tvinger Saker-visningen til å hente på nytt (etter seeding utenom UI). */
async function reloadSaker(app) {
  await app.backend.pageSync(app.backend.db.at('/tiltak'));
  await app.page.evaluate(() => { OpExSakStore.nullstill(OpExHost.getUser().uid); OpExSaker.render({ tvinges: true }); });
}

/**
 * Åpner appen innlogget som `uid`.
 * options: { uid, name, tiltak, viewport, appearance:'light'|'dark', appTheme:'oee'|'green'|'graphite'|'violet', contrast, density, now }
 */
async function openApp(options = {}) {
  const pw = loadPlaywright();
  if (!pw) throw new Error('playwright mangler');
  const server = await startStaticServer();
  const port = server.address().port;
  const backend = new SimBackend({ tiltak: options.tiltak || { ...fx.RIBBEFETT_TILTAK, ...fx.ANDRE_TILTAK }, now: options.now || fx.NOW_ISO });
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    serviceWorkers: 'block',
    locale: 'nb-NO',
    timezoneId: 'Europe/Oslo',
    colorScheme: options.appearance === 'dark' ? 'dark' : 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));

  const uid = options.uid || fx.TONY;
  const prefs = {
    appearance: options.appearance || 'light',
    appTheme: options.appTheme || 'graphite',
    contrast: options.contrast || 'standard',
    density: options.density || 'compact',
  };
  const stubInit = {
    uid, email: 'bruker@example.test', name: options.name || 'Test Bruker',
    data: { authorizedUsers: fx.AUTHORIZED, tiltak: backend.db.at('/tiltak'), userPreferences: { [uid]: prefs } },
  };
  await page.addInitScript(`window.__STUB_INIT__ = ${JSON.stringify(stubInit)};`);
  await page.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'firebase-stub.js'), 'utf8') });
  await page.clock.setFixedTime(new Date(options.now || fx.NOW_ISO));

  // Eksterne avhengigheter: Firebase-SDK-ene erstattes av stubben (lastet via addInitScript), xlsx stubbes.
  // Playwright matcher sist registrerte rute først: den generelle blokkeringen må registreres FØRST.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost).*/, (route) => route.abort()); // alt annet utenfor: blokkert
  await context.route(/gstatic\.com\/firebasejs\/.*/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' }));
  await context.route(/cdn\.jsdelivr\.net\/npm\/xlsx.*/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.XLSX={};' }));
  await context.route(new RegExp(`^https://${FUNCTIONS_HOST.replace(/\./g, '\\.')}/`), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
    const fn = new URL(req.url()).pathname.replace(/^\//, '');
    const auth = req.headers().authorization || '';
    const callerUid = auth.startsWith('Bearer TOKEN-') ? auth.slice('Bearer TOKEN-'.length) : undefined;
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (_) { /* tom */ }
    const out = await backend.handle(fn, callerUid, body.data);
    if (out.error) {
      const [status, st] = HTTP[out.error.code] || [500, 'INTERNAL'];
      await route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { message: out.error.message, status: st } }) });
    } else {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ result: out.result }) });
    }
  });

  backend.pageSync = (tiltak) => page.evaluate((t) => window.__stubDb && window.__stubDb.set('tiltak', t), tiltak);

  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.OpExHost !== undefined || document.querySelector('.tabs'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('login') && getComputedStyle(document.getElementById('login')).display === 'none', null, { timeout: 15000 });

  return {
    page, backend, port, consoleErrors, pageErrors, context,
    reloadSaker() { return reloadSaker(this); },
    stubWrites: () => page.evaluate(() => window.__stubDb.writes.slice()),
    async close() { await browser.close(); await new Promise((r) => server.close(r)); },
  };
}

module.exports = { seedRibbefett, openApp, loadPlaywright, SimBackend, injectLikeServiceWorker, fx };
