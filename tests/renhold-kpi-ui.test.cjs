'use strict';

/*
 * UI-test for KPI Renhold: ekte index.html i Chromium + simulert Firebase + de EKTE renhold-kpi-core-operasjonene.
 * Flyt: tom tilstand -> import fra Excel (syntetisk arbeidsbok) -> oversikt -> registrering -> tiltak i felles liste.
 * Hoppes over hvis Playwright/Chromium mangler. Sett SHOTS_DIR=<mappe> for skjermbilder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, openApp, fx } = require('./ui/harness.cjs');

const pw = loadPlaywright();
let chromiumOk = false;
if (pw) { try { chromiumOk = fs.existsSync(pw.chromium.executablePath()); } catch (_) { chromiumOk = false; } }
const skip = !chromiumOk && 'Playwright/Chromium mangler';
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };

const MAANEDER = ['Januar', 'Februar', 'Mars', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Desember'];

/** SheetJS-lik arbeidsbok med samme struktur som «KPI 2026 Renhold» (syntetiske tall). */
function syntetiskArbeidsbok() {
  const defs = [
    ['HMS', 'Antall farlige forhold', 'Antall', 20, 24, 'Opp', 'Sum', 'HIA', [3, 2, 2, 2, 2, 0, 1, 0, 0]],
    ['HMS', 'Antall HMS-hendelser', 'Antall', 8, 12, 'Opp', 'Sum', 'HIA', [1, 1, 1, 1, 1, 0, 1, 1, 1]],
    ['HMS', 'Tilstedeværelse', '%', 0.866, 0.94, 'Opp', 'Snitt', 'Fast', [0.91, 0.93, 0.95, 0.94, 0.92, null, 0.94, 0.95, 0.96]],
    ['KF', 'Økonomisk effekt av KF-tiltak', 'Kr', 650000, 480000, 'Opp', 'Sum', 'HIA', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['Renholdsresultater', 'Snitt fabrikk', 'Score', 1.63, 1.5, 'Ned', 'Snitt', 'Fast', [1.74, 1.53, 1.61, 1.71, 1.61, 1.65, 1.63, 1.72, 1.75]],
  ];
  const Sheets = {};
  MAANEDER.forEach((navn, mi) => {
    const s = { C6: { v: 'KPI' }, F6: { v: 'Mål 2026' } };
    defs.forEach((d, i) => {
      const r = 8 + i;
      ['B', 'C', 'D', 'E', 'F', 'H', 'M', 'N'].forEach((col, j) => { s[col + r] = { v: d[j] }; });
      const v = d[8][mi];
      if (v !== undefined && v !== null) s['J' + r] = { v };
      if (mi < 12) s['I' + r] = { v: d[2] === '%' ? 0.87 : d[2] === 'Score' ? 1.6 : 1 };
    });
    Sheets[navn] = s;
  });
  return { SheetNames: ['Dashboard'].concat(MAANEDER), Sheets };
}

test('KPI Renhold: import, oversikt, registrering og tiltak (én økt)', { skip, timeout: 120000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen', now: '2026-10-09T10:00:00.000Z', side: 'renhold-kpi/index.html' });
  const { page, backend } = app;
  t.after(() => app.close());

  await t.test('egen app: innlogget bruker ser tom KPI-side med vei til oppsett og lenke til tiltakslista', async () => {
    await page.getByRole('heading', { name: 'Ingen KPI-er for 2026 ennå' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#kpi');
    assert.equal(await page.locator('#kpiLogin').isVisible(), false);
    assert.equal(await page.locator('#kpiTiltakLenke').getAttribute('href'), '../');
    assert.match(await page.locator('#kpiBrukerNavn').textContent(), /Tony/);
    await page.getByRole('button', { name: 'Gå til oppsett' }).click();
    assert.equal(await page.evaluate(() => location.hash), '#kpi/oppsett');
  });

  await t.test('import fra Excel viser forslag og lagrer først ved bekreftelse', async () => {
    const wb = syntetiskArbeidsbok();
    await page.evaluate((w) => { window.XLSX = { read: () => w }; }, wb);
    await page.locator('.kpi-import input[type=file]').setInputFiles({ name: 'KPI_renhold_2026.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await page.getByText('Fant 5 KPI-er for 2026').waitFor();
    assert.match(await page.locator('.kpi-import').textContent(), /HMS-hendelser.*Opp til Ned/);
    assert.equal(backend.calls.filter((c) => c.fn === 'importRenholdKpiV1').length, 0);
    await shot(page, 'kpi-01-import');
    await page.getByRole('button', { name: 'Importer til 2026' }).click();
    await page.locator('.kpi-flis').first().waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#kpi');
    const cfg = backend.db.at('/renholdKpi/config/2026');
    assert.equal(Object.keys(cfg.kpier).length, 5);
    assert.equal(cfg.kpier['antall-hms-hendelser'].retning, 'Ned');
    assert.equal(backend.db.at('/renholdKpi/verdier/2026/01/tilstedevaerelse'), 91);
  });

  await t.test('oversikten viser status per KPI for siste måned med data (september)', async () => {
    assert.equal(await page.locator('.kpi-velgere select').first().inputValue(), '9');
    const kort = (navn) => page.locator('.kpi-flis', { hasText: navn });
    // farlige: 12 mot mål 18 -> ikke på mål; hendelser: 8 mot 9 (Ned) -> på mål; fabrikk snitt 1,66 mot 1,5 (+10,5 %) -> nær mål
    assert.match(await kort('Antall farlige forhold').textContent(), /Ikke på mål/);
    assert.match(await kort('Antall HMS-hendelser').textContent(), /På mål/);
    assert.match(await kort('Snitt fabrikk').textContent(), /Nær mål/);
    assert.match(await page.locator('.kpi-hero').textContent(), /3\/5på eller nær mål/);
    assert.match(await page.locator('.kpi-prio-liste').textContent(), /Antall farlige forhold/);
    assert.equal(await page.locator('.kpi-graf-panel').count() > 0, true);
    await shot(page, 'kpi-02-oversikt', true);
  });

  await t.test('bytte måned beregner på nytt', async () => {
    await page.locator('.kpi-velgere select').first().selectOption('1');
    const kort = page.locator('.kpi-flis', { hasText: 'Antall farlige forhold' });
    assert.match(await kort.textContent(), /På mål/); // 3 mot 2
    await page.locator('.kpi-velgere select').first().selectOption('10');
    await page.getByText(/Ingen verdier registrert for oktober/).waitFor();
  });

  await t.test('registrering: ugyldig tall stoppes i klienten, gyldige lagres og logges', async () => {
    await page.getByRole('tab', { name: 'Registrer' }).click();
    await page.getByRole('heading', { name: 'Verdier for oktober 2026' }).waitFor();
    await page.getByLabel(/Antall farlige forhold/).fill('to');
    await page.getByRole('button', { name: 'Lagre oktober' }).click();
    await page.getByRole('alert').filter({ hasText: 'Sjekk tallene' }).waitFor();
    assert.equal(backend.calls.filter((c) => c.fn === 'saveRenholdKpiMaanedV1').length, 0);
    await page.getByLabel(/Antall farlige forhold/).fill('2');
    await page.getByLabel(/Tilstedeværelse/).fill('94,8');
    await page.getByLabel(/Snitt fabrikk/).fill('1,79');
    await shot(page, 'kpi-03-registrer', true);
    await page.getByRole('button', { name: 'Lagre oktober' }).click();
    await page.locator('.kpi-flis').first().waitFor();
    assert.deepEqual(backend.db.at('/renholdKpi/verdier/2026/10'), { 'antall-farlige-forhold': 2, tilstedevaerelse: 94.8, 'snitt-fabrikk': 1.79 });
    assert.equal(backend.db.at('/renholdKpi/registrert/2026/10').av, fx.TONY);
    assert.match(await page.locator('.kpi-varsel').textContent(), /oktober mangler 2 av 5/i);
  });

  await t.test('graf viser verdier ved hover', async () => {
    const graf = page.locator('.kpi-graf-panel').first();
    await graf.locator('.kc-treff').hover({ position: { x: 10, y: 20 } });
    const tip = graf.locator('.kc-tip');
    await tip.waitFor();
    assert.match(await tip.textContent(), /Januar/);
  });

  await t.test('nytt tiltak fra KPI-rad havner i felles tiltaksliste og vises i detaljene', async () => {
    await page.locator('.kpi-rad-knapp', { hasText: 'Antall farlige forhold' }).click();
    await page.locator('.kpi-detalj').waitFor();
    await page.getByRole('button', { name: 'Nytt tiltak for Antall farlige forhold' }).click();
    const dialog = page.locator('.sak-dialog');
    await dialog.waitFor();
    await dialog.getByLabel('Hva skal gjøres?').fill('Vernerunde på kveld må gjennomføres');
    await dialog.getByLabel('Eier').selectOption('Kenneth Nordbakk');
    await shot(page, 'kpi-04-tiltak');
    await dialog.getByRole('button', { name: 'Opprett tiltak' }).click();
    await dialog.waitFor({ state: 'detached' });
    const alle = backend.db.at('/tiltak');
    const nytt = Object.values(alle).find((x) => x.kpiId === 'antall-farlige-forhold');
    assert.ok(nytt, 'tiltaket ble ikke opprettet');
    assert.equal(nytt.eier, 'Kenneth Nordbakk');
    assert.equal(nytt.omrade, 'Renhold');
    assert.equal(nytt.kategori, 'HMS');
    await page.locator('.kpi-detalj').getByText('Vernerunde på kveld må gjennomføres').waitFor();
    assert.match(await page.locator('#kpi-rad-antall-farlige-forhold').textContent(), /1 åpne/);
  });

  await t.test('oppsett: endret grense lagres og påvirker status', async () => {
    await page.getByRole('tab', { name: 'Oppsett' }).click();
    await page.getByLabel('Grense for «nær mål» (%)').fill('5');
    await page.getByRole('button', { name: 'Lagre oppsett for 2026' }).click();
    for (let i = 0; i < 100 && !backend.calls.some((c) => c.fn === 'getRenholdKpiV1' && backend.calls.findIndex((x) => x.fn === 'saveRenholdKpiConfigV1') >= 0 && backend.calls.indexOf(c) > backend.calls.findIndex((x) => x.fn === 'saveRenholdKpiConfigV1')); i++) await new Promise((r) => setTimeout(r, 50));
    await page.getByRole('button', { name: 'Lagre oppsett for 2026' }).waitFor();
    assert.equal(backend.calls.filter((c) => c.fn === 'saveRenholdKpiConfigV1' && c.ok).length, 1, JSON.stringify(await page.locator('#kpi [role=alert]').allTextContents()));
    assert.equal(backend.db.at('/renholdKpi/config/2026/naerMaalProsent'), 5);
    await page.getByRole('tab', { name: 'Oversikt' }).click();
    await page.locator('.kpi-velgere select').first().selectOption('9');
    assert.match(await page.locator('.kpi-flis', { hasText: 'Snitt fabrikk' }).textContent(), /Ikke på mål/);
  });

  await t.test('ingen feil i konsollen', async () => {
    assert.deepEqual(app.pageErrors, []);
  });
});

test('KPI Renhold: bruker uten registreringsrett ser bare oversikten (mobil)', { skip, timeout: 60000 }, async (t) => {
  const app = await openApp({ uid: fx.ERLING, name: 'Erling Magnussen', viewport: { width: 390, height: 844 }, side: 'renhold-kpi/index.html', hash: '#kpi/registrer' });
  const { page, backend } = app;
  t.after(() => app.close());
  await backend.handle('importRenholdKpiV1', fx.TONY, {
    aar: 2026,
    config: { kpier: { farlige: { navn: 'Antall farlige forhold', omrade: 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: 24 } } },
    verdier: { '01': { farlige: 3 } },
  });
  await page.evaluate(() => OpExKpi.last());
  await page.locator('.kpi-flis').first().waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Registrer' }).count(), 0);
  assert.equal(await page.getByRole('tab', { name: 'Oppsett' }).count(), 0);
  const bredde = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(bredde <= 390, `horisontal scroll på mobil (${bredde}px)`);
  await shot(page, 'kpi-05-mobil', true);
  assert.deepEqual(app.pageErrors, []);
});

test('OpEx Hub lenker til KPI Renhold som egen app', { skip, timeout: 60000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen' });
  t.after(() => app.close());
  const tab = app.page.locator('#kpiTab');
  assert.match((await tab.textContent()).trim(), /KPI Renhold/);
  assert.match(await tab.getAttribute('onclick'), /renhold-kpi\//);
  assert.equal(await app.page.locator('#kpi').count(), 0, 'KPI-modulen skal ikke ligge inne i OpEx Hub');
});

test('KPI-appen viser innlogging når brukeren ikke er logget inn', { skip, timeout: 60000 }, async (t) => {
  const { openApp: open2 } = require('./ui/harness.cjs');
  const app = await open2({ side: 'renhold-kpi/index.html', name: 'X', signedOut: true });
  t.after(() => app.close());
  await app.page.locator('#kpiLogin').waitFor();
  assert.equal(await app.page.locator('#kpi').isVisible(), false);
  await app.page.getByLabel('E-post').fill('feil@example.test');
  await app.page.getByLabel('Passord').fill('x');
  await app.page.getByRole('button', { name: 'Logg inn' }).click();
  await app.page.getByText('Feil e-post eller passord.').waitFor();
});
