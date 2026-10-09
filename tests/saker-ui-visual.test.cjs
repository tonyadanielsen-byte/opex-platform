'use strict';

/*
 * Visuelle/tilgjengelighetstester for Saker: lys/mørk × fargeprofiler, kontrast, responsivitet, tetthet, fokus og dialoger.
 * Samme harness som saker-ui.test.cjs (simulert datalag). Hoppes over uten Playwright/Chromium.
 * Sett SHOTS_DIR=<mappe> for skjermbilder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, openApp, seedRibbefett } = require('./ui/harness.cjs');

const pw = loadPlaywright();
let chromiumOk = false;
if (pw) { try { chromiumOk = fs.existsSync(pw.chromium.executablePath()); } catch (_) { chromiumOk = false; } }
const skip = !chromiumOk && 'Playwright/Chromium mangler';
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };

/** Kjøres i siden: beregner kontrastforhold (WCAG) for tekst i utvalgte elementer, med ekte sammensatt bakgrunn. */
function kontrastIsiden(selectors) {
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (top, bottom) => { const a = top.a + bottom.a * (1 - top.a); return { r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a, g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a, b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      if (n === document.documentElement && getComputedStyle(document.body).backgroundImage !== 'none') break; // body-gradienten dekker html-fargen
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    // Sidebakgrunnen er en gradient: bruk et representativt, ugunstig punkt (lysest i mørk modus, mørkest i lys modus).
    const dark = document.body.dataset.appearance === 'dark';
    let acc = layers.length && layers[layers.length - 1].a >= 0.999 ? layers.pop() : (dark ? { r: 30, g: 36, b: 48, a: 1 } : { r: 232, g: 238, b: 243, a: 1 });
    while (layers.length) acc = over(layers.pop(), acc);
    return acc;
  };
  const out = [];
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!el.offsetParent || !(el.textContent || '').trim()) continue;
      const cs = getComputedStyle(el);
      const fg0 = parse(cs.color);
      if (!fg0) continue;
      const bg = bgOf(el);
      const fg = over({ ...fg0, a: fg0.a * (parseFloat(cs.opacity) || 1) }, bg);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ sel, text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return out;
}

const TEKST_VELGERE = [
  '.sak-page h1', '.sak-card-title', '.sak-card-link', '.sak-kode', '.sak-chip', '.sak-flag', '.sak-progress-text', '.sak-stat dd', '.sak-stat dt', '.sak-card-foot',
  '.sak-pagehead p', '.sak-btn', '.sak-section h2', '.sak-problem', '.sak-kpi dd', '.sak-kpi dt', '.sak-todo-text b', '.sak-todo-text small', '.sak-spor-head p',
  '.sak-arsak-tekst', '.sak-attrib', '.sak-evidence', '.sak-tiltak-title', '.sak-tiltak-meta', '.sak-due', '.sak-event-text', '.sak-event small', '.sak-day h3', '.sak-note',
];

async function open(opts) {
  const app = await openApp({ name: 'Tony Danielsen', ...opts });
  const seed = await seedRibbefett(app);
  await app.page.locator('#sakerTab').click();
  await app.reloadSaker();
  await app.page.locator('.sak-card', { hasText: 'Ribbefett 2025' }).waitFor();
  await app.page.locator('.sak-foot-item', { hasText: /Aktivitet (i dag|i går|\d+ dager)/ }).first().waitFor();
  await app.page.waitForTimeout(700); // appens egen innfading av skjermer må være ferdig før farger måles
  return { app, seed };
}

for (const appearance of ['light', 'dark']) {
  for (const appTheme of ['oee', 'green', 'graphite', 'violet']) {
    test(`kontrast ≥ 4,5:1 i oversikt, sakside og dialog: ${appearance} / ${appTheme}`, { skip, timeout: 90000 }, async (t) => {
      const { app } = await open({ appearance, appTheme });
      t.after(() => app.close());
      const { page } = app;
      const sjekk = async (hvor, min = 20) => {
        const rader = await page.evaluate(kontrastIsiden, TEKST_VELGERE);
        assert.ok(rader.length > min, 'for få tekstelementer målt i ' + hvor);
        const lave = rader.filter((r) => r.ratio < 4.5);
        assert.deepEqual(lave, [], `${hvor}: for lav kontrast (${appearance}/${appTheme})`);
      };
      await sjekk('oversikt', 8);
      await shot(page, `20-oversikt-${appearance}-${appTheme}`);
      await page.locator('.sak-card-link', { hasText: 'Ribbefett 2025' }).click();
      await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
      await page.locator('.sak-event').first().waitFor();
      await page.waitForTimeout(700);
      await sjekk('sakside');
      await shot(page, `21-detalj-${appearance}-${appTheme}`, true);
      await page.getByRole('button', { name: 'Koble tiltak' }).first().click();
      await page.locator('.sak-dialog').waitFor();
      const dlg = await page.evaluate(kontrastIsiden, ['.sak-dialog h2', '.sak-dialog label', '.sak-dialog .sak-hint', '.sak-dialog .sak-btn', '.sak-pick-text b', '.sak-pick-text small', '.sak-dialog legend']);
      assert.deepEqual(dlg.filter((r) => r.ratio < 4.5), [], `dialog: for lav kontrast (${appearance}/${appTheme})`);
      await shot(page, `22-dialog-${appearance}-${appTheme}`);
      assert.deepEqual(app.pageErrors, []);
    });
  }
}

test('høy kontrast og normal tetthet bryter ikke layout eller kontrast', { skip, timeout: 90000 }, async (t) => {
  for (const [appearance, contrast, density] of [['light', 'high', 'normal'], ['dark', 'high', 'normal']]) {
    const { app } = await open({ appearance, contrast, density, appTheme: 'oee' });
    try {
      const rader = await app.page.evaluate(kontrastIsiden, TEKST_VELGERE);
      assert.deepEqual(rader.filter((r) => r.ratio < 4.5), []);
      await shot(app.page, `23-hoy-kontrast-${appearance}`);
    } finally { await app.close(); }
  }
});

test('responsivt: ingen horisontal scroll, fanen er nåbar, tiltak/kort stables på mobil', { skip, timeout: 120000 }, async (t) => {
  for (const vp of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    const { app } = await open({ viewport: vp, appearance: 'light', appTheme: 'graphite' });
    try {
      const { page } = app;
      const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      let o = await overflow();
      assert.ok(o.sw <= o.cw + 1, `oversikt ${vp.width}px: horisontal overflow ${o.sw} > ${o.cw}`);
      const tab = page.locator('#sakerTab');
      const box = await tab.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= vp.width + 1 && box.y >= 0 && box.y + box.height <= vp.height + 1, `Saker-fanen er utenfor skjermen ved ${vp.width}px: ${JSON.stringify(box)}`);
      if (vp.width <= 640) {
        const tabs = await page.locator('.tabs .tab:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        assert.equal(new Set(tabs).size, 1, `fanene brytes over flere rader ved ${vp.width}px: ${tabs}`);
        const w = await page.locator('.sak-card').first().evaluate((e) => e.getBoundingClientRect().width);
        assert.ok(w >= vp.width - 40, 'kortet fyller bredden på mobil');
      }
      await shot(page, `30-oversikt-${vp.width}`);
      await page.locator('.sak-card-link', { hasText: 'Ribbefett 2025' }).click();
      await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
      await page.locator('.sak-event').first().waitFor();
      o = await overflow();
      assert.ok(o.sw <= o.cw + 1, `sakside ${vp.width}px: horisontal overflow ${o.sw} > ${o.cw}`);
      // berøringsflater på mobil: minst 40 px høye
      if (vp.width <= 640) {
        const smaa = await page.locator('#saker .sak-btn:visible').evaluateAll((els) => els.map((e) => ({ t: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30), h: e.getBoundingClientRect().height })).filter((x) => x.h < 40));
        assert.deepEqual(smaa, [], 'for små trykkflater på mobil');
      }
      await shot(page, `31-detalj-${vp.width}`, true);
      // dialog passer i skjermen (bunnark på mobil)
      await page.getByRole('button', { name: 'Koble tiltak' }).first().click();
      const d = await page.locator('.sak-dialog').boundingBox();
      assert.ok(d.x >= -1 && d.x + d.width <= vp.width + 1 && d.y >= -1 && d.y + d.height <= vp.height + 1, `dialogen går utenfor skjermen ved ${vp.width}px: ${JSON.stringify(d)}`);
      if (vp.width <= 640) assert.ok(Math.abs(d.y + d.height - vp.height) <= 2, 'dialogen ligger som bunnark på mobil');
      const foot = await page.locator('.sak-dlg-foot .sak-btn-primary').boundingBox();
      assert.ok(foot && foot.y + foot.height <= vp.height + 1, 'primærknappen i dialogen er synlig uten scrolling');
      await shot(page, `32-dialog-${vp.width}`);
      assert.deepEqual(app.pageErrors, []);
    } finally { await app.close(); }
  }
});

test('tastatur og fokus: dialogen fanger fokus, Esc lukker og fokus går tilbake', { skip, timeout: 60000 }, async (t) => {
  const { app } = await open({});
  try {
    const { page } = app;
    const knapp = page.getByRole('button', { name: 'Ny sak' });
    await knapp.focus();
    await page.keyboard.press('Enter');
    const dlg = page.locator('.sak-dialog');
    await dlg.waitFor();
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sak-dialog')), true, 'fokus inne i dialogen');
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sak-dialog')), true, 'Tab forlater ikke dialogen');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sak-dialog')), true);
    assert.equal(await dlg.getAttribute('aria-modal'), 'true');
    assert.ok(await dlg.getAttribute('aria-labelledby'));
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim()), 'Ny sak', 'fokus tilbake på utløseren');
    // kort kan åpnes med tastatur
    const link = page.locator('.sak-card-link').first();
    await link.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
  } finally { await app.close(); }
});

test('nettleserens tilbake-knapp går fra sak til oversikt; direkte lenke åpner saken', { skip, timeout: 60000 }, async (t) => {
  const { app, seed } = await open({});
  try {
    const { page } = app;
    await page.locator('.sak-card-link').first().click();
    await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
    await page.goBack();
    await page.locator('.sak-card', { hasText: 'Ribbefett 2025' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#saker');
    await page.evaluate((id) => { location.hash = '#saker/' + id; }, seed.sakId);
    await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
    await page.evaluate(() => { location.hash = '#saker/finnes-ikke'; });
    await page.getByText('Fant ikke saken').waitFor();
  } finally { await app.close(); }
});

test('lukket sak er låst for endring, men kan åpnes igjen via status', { skip, timeout: 60000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen' });
  try {
    const { page } = app;
    await seedRibbefett(app, { status: 'Lukket' });
    await page.locator('#sakerTab').click();
    await app.reloadSaker();
    await page.locator('details.sak-closed-group summary').click();
    await page.locator('.sak-card-link', { hasText: 'Ribbefett 2025' }).click();
    await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Koble tiltak' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Rediger', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Registrer årsak' }).count(), 0);
    await page.getByText(/Saken er lukket og låst/).first().waitFor();
    await page.getByRole('button', { name: 'Endre status' }).click();
    await page.getByRole('radio', { name: /Under oppfølging/ }).check();
    await page.getByRole('button', { name: 'Sett status' }).click();
    await page.getByRole('button', { name: 'Koble tiltak' }).first().waitFor();
    await shot(page, '40-lukket-sak-gjenåpnet');
  } finally { await app.close(); }
});

test('alle tiltak ferdig: systemet foreslår «Løst», men endrer aldri status selv', { skip, timeout: 60000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen' });
  try {
    const { page, backend } = app;
    const fx = require('./ui/fixtures.cjs');
    for (const k of Object.keys(backend.db.at('/tiltak'))) if (k.startsWith('-Orib')) await backend.db.ref('/tiltak/' + k + '/status').set('Fullført');
    await seedRibbefett(app, { utenArsaker: true });
    await page.locator('#sakerTab').click();
    await app.reloadSaker();
    await page.locator('.sak-card-link', { hasText: 'Ribbefett 2025' }).click();
    await page.getByText('Alle tiltak er fullført').waitFor();
    assert.equal(Object.values(backend.db.at('/saker'))[0].status, 'Åpen', 'status er uendret');
    await page.locator('.sak-todo-item', { hasText: 'Alle tiltak er fullført' }).getByRole('button', { name: 'Endre status' }).click();
    assert.match(await page.locator('.sak-radio.is-suggested').textContent(), /Løst/);
    void fx;
  } finally { await app.close(); }
});
