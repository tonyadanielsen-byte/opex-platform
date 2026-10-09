'use strict';

/*
 * UI-tester for Saker (fase 1d): ekte index.html i Chromium (Playwright) + simulert Firebase + de EKTE sak-core-operasjonene
 * over callable-protokollen. Beviser at UI og kontrakten fungerer sammen; beviser IKKE at ekte Firebase oppfører seg likt.
 * Hoppes over hvis Playwright/Chromium ikke finnes. Sett SHOTS_DIR=<mappe> for å lagre skjermbilder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, openApp, seedRibbefett, fx } = require('./ui/harness.cjs');

const pw = loadPlaywright();
let chromiumOk = false;
if (pw) { try { chromiumOk = fs.existsSync(pw.chromium.executablePath()); } catch (_) { chromiumOk = false; } }
const skip = !chromiumOk && 'Playwright/Chromium mangler';
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };

const SAK_NODER = /^(saker|sakSpor|sakArsaker|sakEvents|sakTiltakSpor|sakLocks|tiltakEvents|sakTeller|sakCounter)/;

test('Saker: navigasjon, opprettelse, kobling, årsaker, frakobling (én økt)', { skip, timeout: 120000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen' });
  const { page, backend } = app;
  t.after(() => app.close());
  const dialog = page.locator('.sak-dialog');

  await t.test('fanen finnes med linjeikon og åpner tom Saker-side', async () => {
    const tab = page.locator('#sakerTab');
    assert.equal((await tab.textContent()).trim(), 'Saker');
    assert.equal(await tab.locator('svg').count(), 1);
    await tab.click();
    await page.locator('#saker.active').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#saker');
    await page.getByRole('heading', { name: 'Ingen saker ennå' }).waitFor();
    assert.equal(await page.locator('#dashboard.active').count(), 0);
    assert.equal(await tab.evaluate((el) => el.classList.contains('active')), true);
    await shot(page, '01-tom-oversikt');
    await page.locator('button.tab', { hasText: 'Dashboard' }).click();
    assert.equal(await page.locator('#saker.active').count(), 0);
    await tab.click();
    await page.locator('#saker.active').waitFor();
  });

  await t.test('ny sak: validering vises i dialogen uten serverkall', async () => {
    await page.getByRole('button', { name: 'Opprett første sak' }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Opprett sak' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').textContent(), /Tittel må ha minst 3 tegn/);
    assert.equal(backend.calls.filter((c) => c.fn === 'createSakV1').length, 0);
    await shot(page, '02-ny-sak-dialog');
  });

  await t.test('serverfeil ved opprettelse: dialogen blir stående, ingen falsk suksess, input beholdes', async () => {
    await dialog.getByLabel('Tittel').fill('Ribbefett 2025');
    backend.failNext('createSakV1', 'unavailable', 'Tjenesten er midlertidig utilgjengelig.');
    await dialog.getByRole('button', { name: 'Opprett sak' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'midlertidig utilgjengelig' }).waitFor();
    assert.equal(await dialog.count(), 1);
    assert.equal(await dialog.getByLabel('Tittel').inputValue(), 'Ribbefett 2025');
    assert.equal(await page.locator('#toast').evaluate((el) => getComputedStyle(el).display), 'none', 'ingen suksessmelding ved feil');
    assert.equal(Object.keys(backend.db.at('/saker') || {}).length, 0, 'ingenting lagret');
    await shot(page, '03-feil-ved-opprettelse');
  });

  await t.test('ny sak: opprettes med spor, åpnes først etter serverbekreftelse', async () => {
    await dialog.getByLabel('Problemstilling').fill('Restlager på 2 318 kg. Vi må forstå hvorfor.');
    await dialog.getByLabel('Spørsmål for spor A').fill('Hvorfor ble det restlager?');
    await dialog.getByRole('button', { name: 'Legg til spor' }).click();
    await dialog.getByLabel('Spørsmål for spor B').fill('Hvordan unngår vi det i fremtiden?');
    await dialog.getByLabel('Områder').fill('Ferdigmat, Frysa');
    await dialog.getByRole('button', { name: 'Opprett sak' }).click();
    await page.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
    assert.equal(await dialog.count(), 0);
    assert.match(await page.locator('.sak-detail-title .sak-kode').textContent(), /^SAK-\d{4}$/);
    assert.match(await page.evaluate(() => location.hash), /^#saker\/.+/);
    const sak = Object.values(backend.db.at('/saker'))[0];
    assert.equal(sak.tittel, 'Ribbefett 2025');
    assert.equal(sak.eierUid, fx.TONY);
    assert.deepEqual(Object.keys(sak.omrader).sort(), ['Ferdigmat', 'Frysa']);
    assert.equal(Object.keys(backend.db.at('/sakSpor/' + Object.keys(backend.db.at('/saker'))[0])).length, 2);
  });

  await t.test('tom sak: tydelige tomtilstander og anbefalt handling', async () => {
    const main = page.locator('#saker');
    await main.getByText('Ingen tiltak er koblet til denne saken.').waitFor();
    await main.locator('.sak-todo').getByText('Ingen tiltak er koblet til saken').waitFor();
    assert.equal(await main.getByText('Ingen årsaker registrert for dette sporet ennå.').count(), 2);
    await main.getByText('Saken ble opprettet').waitFor();
    for (const h2 of ['Ledelsesbilde', 'Krever handling', 'Årsaksbilde', 'Tiltak', 'Aktivitet']) await main.getByRole('heading', { level: 2, name: h2 }).waitFor();
    const order = await main.locator('.sak-section h2').allTextContents();
    assert.deepEqual(order.map((x) => x.trim()), ['Ledelsesbilde', 'Krever handling', 'Årsaksbilde', 'Tiltak', 'Aktivitet']);
    await shot(page, '04-tom-sak');
  });

  await t.test('koble tiltak: søk, spor-valg, testtiltak tilbys ikke, per-tiltak-resultat fra serveren', async () => {
    await page.getByRole('button', { name: 'Koble tiltak' }).first().click();
    await dialog.waitFor();
    assert.equal(await dialog.getByText('Testtiltak som ikke skal telle').count(), 0, 'test-miljø-tiltak skal ikke kunne kobles');
    await dialog.getByLabel('Søk i tiltak').fill('ribbefett');
    await dialog.getByLabel('Søk i tiltak').fill('');
    await dialog.getByLabel('Søk i tiltak').fill('Constellation');
    assert.equal(await dialog.locator('.sak-pick input[type=checkbox]').count(), 3, 'tre tiltak nevner Constellation');
    await dialog.locator('.sak-pick', { hasText: 'Fast lagergjennomgang' }).locator('input').check();
    await dialog.locator('.sak-pick', { hasText: 'Batchstyring' }).locator('input').check();
    await dialog.getByRole('group', { name: 'Tiltak som kan kobles' }).waitFor();
    await dialog.locator('label.sak-check', { hasText: 'Spor A' }).locator('input').check();
    await shot(page, '05-koble-tiltak');
    // Første tiltak feiler på serveren: det andre skal likevel kobles, og feilen vises tydelig.
    backend.failNext('setTiltakSakV1', 'aborted', 'Noen andre endret dette samtidig.');
    await dialog.getByRole('button', { name: 'Koble valgte' }).click();
    await dialog.getByRole('alert').filter({ hasText: '1 av 2 tiltak ble koblet' }).waitFor();
    const koblet = Object.entries(backend.db.at('/tiltak')).filter(([, v]) => v.sakId).map(([k]) => k);
    assert.equal(koblet.length, 1, 'bare det serveren bekreftet er koblet');
    assert.equal(await dialog.locator('.sak-pick input:checked').count(), 1, 'feilede tiltak blir stående valgt');
    await dialog.getByRole('button', { name: 'Koble valgte' }).click();
    await page.locator('.sak-dialog').waitFor({ state: 'detached' });
    assert.equal(Object.values(backend.db.at('/tiltak')).filter((v) => v.sakId).length, 2);
  });

  await t.test('tiltak vises under spor, med frist, status og eier; klikk åpner eksisterende tiltaksmodal', async () => {
    const main = page.locator('#saker');
    const sporA = main.locator('.sak-group', { hasText: 'Spor A' }).first();
    await sporA.getByText('Fast lagergjennomgang hos Constellation').waitFor();
    assert.equal(await sporA.locator('.sak-tiltak').count(), 2);
    await main.getByRole('heading', { name: 'Ikke koblet til spor' }).count().then((n) => assert.equal(n, 0));
    await main.locator('.sak-kpi', { hasText: 'Tiltak' }).first().waitFor();
    await sporA.getByRole('button', { name: /Åpne tiltak: Fast lagergjennomgang/ }).click();
    await page.waitForFunction(() => document.getElementById('modal').classList.contains('open'));
    assert.equal(await page.locator('#modalTitle').isVisible(), true);
    try { assert.equal(await page.evaluate(() => [...document.querySelectorAll('#modal input')].some((i) => i.value === 'Fast lagergjennomgang hos Constellation')), true); }
    finally { await page.evaluate(() => closeModal()); }
  });

  await t.test('årsaker: støttet uten grunnlag avvises før serverkall; menneskelig vurdering viser hvem og når', async () => {
    const main = page.locator('#saker');
    await main.locator('.sak-spor', { hasText: 'Spor A' }).getByRole('button', { name: 'Registrer årsak' }).click();
    await dialog.waitFor();
    await dialog.getByLabel(/^Årsak/).fill('Bestilling ble ikke batchstyrt');
    await dialog.getByRole('radio', { name: /Støttet/ }).check();
    const før = backend.calls.length;
    await dialog.getByRole('button', { name: 'Registrer' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'krever et grunnlag' }).waitFor();
    assert.equal(backend.calls.length, før, 'ingen serverkall ved klientvalidering');
    await dialog.getByRole('textbox', { name: /^Grunnlag/ }).fill('Mail fra Constellation 3. sept.');
    await dialog.getByRole('button', { name: 'Registrer' }).click();
    await dialog.waitFor({ state: 'detached' });
    const kort = main.locator('.sak-arsak', { hasText: 'Bestilling ble ikke batchstyrt' });
    await kort.waitFor();
    assert.match(await kort.textContent(), /Støttet/);
    assert.match(await kort.textContent(), /Vurdert av Tony Danielsen/);
    assert.match(await kort.textContent(), /Menneskelig vurdering/);
    assert.match(await kort.locator('details').textContent(), /Mail fra Constellation/);
    const rec = Object.values(backend.db.at('/sakArsaker/' + Object.keys(backend.db.at('/saker'))[0]))[0];
    assert.equal(rec.vurdertAv, fx.TONY);
    await shot(page, '06-arsaker');
  });

  await t.test('endre vurdering og fjerne årsak går via serveren; fjernede kan vises', async () => {
    const main = page.locator('#saker');
    const kort = () => main.locator('.sak-arsak', { hasText: 'Bestilling ble ikke batchstyrt' });
    await kort().getByRole('button', { name: 'Vurder' }).click();
    await dialog.getByRole('radio', { name: /Bekreftet/ }).check();
    await dialog.getByRole('button', { name: 'Lagre vurdering' }).click();
    await dialog.waitFor({ state: 'detached' });
    await kort().getByText('Bekreftet').first().waitFor();
    await kort().getByRole('button', { name: 'Fjern' }).click();
    await dialog.getByRole('button', { name: 'Fjern', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await kort().count(), 0);
    await main.getByRole('button', { name: /Vis fjernede \(1\)/ }).click();
    await kort().waitFor();
    assert.match(await kort().textContent(), /Fjernet/);
  });

  await t.test('endre spor og frakoble: bekreftes, loggføres, og tiltaket slettes ikke', async () => {
    const main = page.locator('#saker');
    const rad = main.locator('.sak-tiltak', { hasText: 'Batchstyring ved bestilling' });
    await rad.getByRole('button', { name: /Endre spor for/ }).click();
    await dialog.locator('label.sak-check', { hasText: 'Spor B' }).locator('input').check();
    await dialog.getByRole('button', { name: 'Lagre spor' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await main.locator('.sak-tiltak', { hasText: 'Batchstyring' }).first().textContent(), /også i/);
    const rad2 = main.locator('.sak-tiltak', { hasText: 'Batchstyring ved bestilling' }).first();
    await rad2.getByRole('button', { name: /Frakoble Batchstyring/ }).click();
    await dialog.getByText('Selve tiltaket slettes ikke').waitFor();
    backend.failNext('removeTiltakSakV1', 'internal', 'Noe gikk galt hos serveren.');
    await dialog.getByRole('button', { name: 'Frakoble' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Noe gikk galt' }).waitFor();
    assert.equal(await main.locator('.sak-tiltak', { hasText: 'Batchstyring' }).count() > 0, true, 'feil: tiltaket står fortsatt i saken');
    await dialog.getByRole('button', { name: 'Frakoble' }).click();
    await dialog.waitFor({ state: 'detached' });
    // Medlemskap leses fra live tiltaksdata i siden: raden forsvinner så snart sanntidslytteren har fått endringen.
    await main.locator('.sak-tiltak', { hasText: 'Batchstyring' }).first().waitFor({ state: 'detached' });
    const t2 = Object.values(backend.db.at('/tiltak')).find((v) => v.tittel.startsWith('Batchstyring'));
    assert.ok(t2 && !t2.sakId, 'tiltaket finnes fortsatt, uten sakId');
    await main.getByText(/ble fjernet fra saken/).first().waitFor();
  });

  await t.test('status: manuell endring, aldri automatisk', async () => {
    const main = page.locator('#saker');
    await main.getByRole('button', { name: 'Endre status' }).click();
    await dialog.getByText('Status settes alltid manuelt').waitFor();
    await dialog.getByRole('button', { name: 'Sett status' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'allerede denne statusen' }).waitFor();
    await dialog.getByRole('radio', { name: /Under oppfølging/ }).check();
    await dialog.getByRole('button', { name: 'Sett status' }).click();
    await dialog.waitFor({ state: 'detached' });
    await main.locator('.sak-detail-title').getByText('Under oppfølging').waitFor();
    assert.equal(Object.values(backend.db.at('/saker'))[0].status, 'Under oppfølging');
  });

  await t.test('tilbake til oversikten viser kortet', async () => {
    await page.getByRole('button', { name: 'Alle saker' }).click();
    const kort = page.locator('.sak-card', { hasText: 'Ribbefett 2025' });
    await kort.waitFor();
    assert.match(await kort.textContent(), /SAK-\d{4}/);
    assert.match(await kort.textContent(), /Under oppfølging/);
    await shot(page, '07-oversikt-ett-kort');
  });

  await t.test('klienten skrev aldri direkte til noen sak-node eller tiltak; ingen konsollfeil', async () => {
    const writes = await app.stubWrites();
    // Eksisterende id-v1.js skriver systemId* på tiltak som mangler det (uavhengig av Saker). Alt annet på tiltak, og alle sak-noder, er forbudt.
    const bad = writes.filter((w) => SAK_NODER.test(w.path) || (/^tiltak(\/|$)/.test(w.path) && !(w.keys || []).every((k) => /^systemId/.test(k))) || (w.keys || []).some((k) => /sak/i.test(k)));
    assert.deepEqual(bad, [], 'direkte klientskriving funnet: ' + JSON.stringify(bad));
    // Nettleseren logger HTTP-feilene vi selv injiserte (409/500). Alt annet er en reell feil.
    assert.deepEqual(app.consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of (409|500|503)/.test(e)), []);
    assert.deepEqual(app.pageErrors, []);
  });
});

test('Saker: Ribbefett-oppsett gir riktig ledelsesbilde, handlingsliste, spor og aktivitet', { skip, timeout: 90000 }, async (t) => {
  const app = await openApp({ name: 'Tony Danielsen' });
  const { page } = app;
  t.after(() => app.close());
  const seed = await seedRibbefett(app);
  await page.locator('#sakerTab').click();
  await app.reloadSaker();
  const kort = page.locator('.sak-card', { hasText: 'Ribbefett 2025' });
  await kort.waitFor();

  await t.test('kortet viser alt som trengs for å prioritere', async () => {
    await page.locator('.sak-card .sak-foot-item', { hasText: /Aktivitet (i dag|i går|\d+ dager siden)/ }).first().waitFor();
    const txt = (await kort.innerText()).replace(/\s+/g, ' ');
    assert.match(txt, /SAK-0001/);
    assert.match(txt, /Ribbefett 2025/);
    assert.match(txt, /Under oppfølging|Åpen/);
    assert.match(txt, /Krever handling: 1 forfalt tiltak/);
    assert.match(txt, /Tiltak 7|7 Tiltak/);
    assert.match(txt, /Tony Danielsen/);
    assert.match(txt, /Neste frist: I dag/);
    assert.match(txt, /1 av 7 fullført/);
    await shot(page, '10-ribbefett-oversikt');
  });

  await t.test('detaljsiden: tall stemmer med tiltakene og er merket som beregnet', async () => {
    await kort.getByRole('button', { name: /Ribbefett 2025/ }).click();
    const main = page.locator('#saker');
    await main.getByRole('heading', { level: 1, name: 'Ribbefett 2025' }).waitFor();
    const kpi = async (label) => (await main.locator('.sak-kpi', { has: page.locator('dt', { hasText: new RegExp('^' + label + '$') }) }).locator('dd').textContent()).trim();
    assert.equal(await kpi('Tiltak'), '7');
    assert.equal(await kpi('Forfalt'), '1');
    assert.equal(await kpi('Fullført'), '1');
    assert.equal(await kpi('Gjenstår'), '6');
    await main.getByText('Tallene beregnes fra tiltakene').waitFor();
    await shot(page, '11-ribbefett-detalj-topp');
  });

  await t.test('krever handling: forfalt tiltak først, deretter godkjenning og tiltak uten spor', async () => {
    const main = page.locator('#saker');
    const items = await main.locator('.sak-todo-item').allInnerTexts();
    const flat = items.map((x) => x.replace(/\s+/g, ' '));
    assert.match(flat[0], /datokontroll ved mottak på Frysa/);
    assert.match(flat[0], /1 dag over frist/);
    assert.ok(flat.some((x) => /venter på godkjenning/.test(x)));
    assert.ok(flat.some((x) => /1 tiltak er ikke koblet til noe spor/.test(x)));
    assert.ok(flat.some((x) => /1 årsak venter på vurdering/.test(x)));
    assert.equal(flat.some((x) => /Vurder å sette saken til/.test(x)), false, 'ikke alle tiltak er ferdige');
  });

  await t.test('forfalt tiltak åpnes i eksisterende tiltaksmodal fra «Krever handling»', async () => {
    const main = page.locator('#saker');
    await main.locator('.sak-todo-item').first().getByRole('button', { name: 'Åpne tiltak' }).click();
    await page.waitForFunction(() => document.getElementById('modal').classList.contains('open'));
    try { assert.equal(await page.evaluate(() => [...document.querySelectorAll('#modal input')].some((i) => /datokontroll ved mottak på Frysa/.test(i.value))), true); }
    finally { await page.evaluate(() => closeModal()); }
  });

  await t.test('årsaksbilde: spor A og B med vurderingsstatus, hvem og grunnlag', async () => {
    const main = page.locator('#saker');
    const a = main.locator('.sak-spor', { hasText: 'Spor A' }).first();
    assert.equal(await a.locator('.sak-arsak').count(), 2);
    assert.match(await a.textContent(), /Bekreftet/);
    assert.match(await a.textContent(), /Hypotese/);
    assert.match(await a.textContent(), /Vurdert av Tony Danielsen/);
    const b = main.locator('.sak-spor', { hasText: 'Spor B' }).first();
    assert.match(await b.textContent(), /Støttet/);
    await shot(page, '12-ribbefett-arsaker');
  });

  await t.test('tiltak grupperes per spor; uten spor for seg; arkivert fullført regnes som gjort', async () => {
    const main = page.locator('#saker');
    const grp = (navn) => main.locator('.sak-group', { has: page.locator('.sak-group-title', { hasText: navn }) });
    assert.equal(await grp('Spor A').locator('.sak-tiltak').count(), 4); // 1,2,3 og 6
    assert.equal(await grp('Spor B').locator('.sak-tiltak').count(), 3); // 4,5 og 6
    assert.equal(await grp('Ikke koblet til spor').locator('.sak-tiltak').count(), 1);
    assert.match(await grp('Ikke koblet til spor').textContent(), /tapskategori/);
    assert.match(await grp('Spor A').locator('.sak-tiltak', { hasText: 'utgått vare sendt til Sarpsborg' }).textContent(), /Fullført/);
    assert.equal(await main.locator('.sak-tiltak.is-overdue').count(), 1);
    await shot(page, '13-ribbefett-tiltak');
  });

  await t.test('aktivitet: sak- og tiltakshendelser, sortert nyest først', async () => {
    const main = page.locator('#saker');
    await main.getByRole('button', { name: /Vis flere/ }).click();
    await main.getByText('Saken ble opprettet').waitFor();
    const n = await main.locator('.sak-event').count();
    assert.ok(n >= 10, 'forventet mange hendelser, fant ' + n);
    assert.equal(await main.getByText(/Historikken er avkortet/).count(), 0);
    await shot(page, '14-ribbefett-aktivitet');
  });

  await t.test('avkortet historikk varsles tydelig', async () => {
    const { backend } = app;
    const sakId = seed.sakId;
    const batch = {};
    for (let i = 0; i < 310; i++) batch['-Oold' + String(i).padStart(4, '0')] = { type: 'sak_endret', entityId: sakId, felt: 'tittel', actorUid: fx.TONY, createdAt: new Date(Date.parse(fx.NOW_ISO) - 86400000 * 3 - i * 1000).toISOString() };
    await backend.db.ref('/sakEvents/' + sakId).update(batch);
    await page.getByRole('button', { name: 'Oppdater', exact: true }).click();
    await page.getByText(/Historikken er avkortet/).waitFor();
    const før = await page.locator('.sak-event').count();
    await page.getByRole('button', { name: /Vis flere/ }).click();
    assert.ok(await page.locator('.sak-event').count() > før);
  });
});
