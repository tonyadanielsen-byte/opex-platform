/*
 * kpi-registrer.js — registrering av månedens verdier.
 *
 * Én fargekodet seksjon per område, ett kort per KPI med stort tallfelt, sammenligning (forrige måned, i fjor, mål)
 * og forhåndsvisning av status hittil i år mens du skriver. Enter går til neste felt. Lagrelinjen ligger fast nederst
 * og viser hvor mange som er fylt ut og endret. Avhenger av kjernen i kpi-app.js (window.OpExKpiKjerne).
 */
(function (root) {
  'use strict';

  var K = function () { return root.OpExKpiKjerne; };
  var utkast = { nokkel: '', verdier: {} };
  var OMRADE_FARGER = ['#eb6834', '#2a78d6', '#1baf7a', '#6250d6', '#e87ba4', '#eda100'];

  function omradeFarge(omrader, omrade) { var i = omrader.indexOf(omrade); return OMRADE_FARGER[(i < 0 ? 0 : i) % OMRADE_FARGER.length]; }

  function tilTekst(v, def) {
    var L = K().L;
    return L.erTall(v) ? L.fmtTall(v, def.enhet === 'Score' ? 2 : def.enhet === '%' ? 1 : 0).replace(/ /g, ' ') : '';
  }

  function bygg(d) {
    var k = K(), h = k.h, L = k.L, U = k.U, state = k.state();
    var n = state.maaned, mm = L.mndKey(n);
    var kpier = L.aktiveKpier(d.config);
    var naa = (d.verdier && d.verdier[mm]) || {};
    var forrige = n > 1 ? (d.verdier && d.verdier[L.mndKey(n - 1)]) || {} : {};
    var fjor = (d.fjorVerdier && d.fjorVerdier[mm]) || {};
    var nokkel = d.aar + '-' + mm;
    if (utkast.nokkel !== nokkel) utkast = { nokkel: nokkel, verdier: {} };
    var reg = d.registrert && d.registrert[mm];
    var omrader = [];
    kpier.forEach(function (x) { if (omrader.indexOf(x.omrade) < 0) omrader.push(x.omrade); });

    var inputs = {}, oppdaterere = [];
    var feilBoks = h('div', { class: 'sak-alert sak-tone-danger', role: 'alert', hidden: true });
    var fremdriftTekst = h('span', { class: 'kpi-regf-tekst' });
    var fremdriftFyll = h('span', { class: 'kpi-regf-fyll' });
    var endretTekst = h('span', { class: 'kpi-regf-endret' });
    var lagreBtn = U.button(state.lagrer ? 'Lagrer …' : 'Lagre ' + L.mndNavn(n).toLowerCase(), { variant: 'primary', type: 'submit', disabled: state.lagrer, icon: 'check' });

    function verdiFor(def) {
      var tekst = Object.prototype.hasOwnProperty.call(utkast.verdier, def.id) ? utkast.verdier[def.id] : tilTekst(naa[def.id], def);
      return { tekst: tekst, tall: L.parseTall(tekst) };
    }

    /** Verdiene slik de blir hvis man lagrer nå (for forhåndsvisning av status). */
    function verdierMedUtkast() {
      var kopi = {};
      Object.keys(d.verdier || {}).forEach(function (m) { kopi[m] = Object.assign({}, d.verdier[m]); });
      kopi[mm] = Object.assign({}, kopi[mm] || {});
      kpier.forEach(function (def) {
        var v = verdiFor(def).tall;
        if (typeof v === 'number' && !isNaN(v)) kopi[mm][def.id] = v; else delete kopi[mm][def.id];
      });
      return kopi;
    }

    function oppdaterAlt() {
      var utfylt = 0, endret = 0;
      kpier.forEach(function (def) {
        var v = verdiFor(def);
        if (typeof v.tall === 'number' && !isNaN(v.tall)) utfylt++;
        var gammel = L.erTall(naa[def.id]) ? naa[def.id] : null;
        var ny = typeof v.tall === 'number' && !isNaN(v.tall) ? v.tall : null;
        if (Object.prototype.hasOwnProperty.call(utkast.verdier, def.id) && ny !== gammel) endret++;
      });
      fremdriftTekst.textContent = utfylt + ' av ' + kpier.length + ' utfylt';
      fremdriftFyll.style.width = Math.round(utfylt / Math.max(kpier.length, 1) * 100) + '%';
      endretTekst.textContent = endret ? endret + (endret === 1 ? ' endring' : ' endringer') + ' ikke lagret' : 'Ingen ulagrede endringer';
      endretTekst.classList.toggle('is-endret', endret > 0);
      var kopi = verdierMedUtkast();
      oppdaterere.forEach(function (fn) { fn(kopi); });
    }

    var seksjoner = omrader.map(function (omrade) {
      var farge = omradeFarge(omrader, omrade);
      var kort = kpier.filter(function (x) { return x.omrade === omrade; }).map(function (def) {
        var start = verdiFor(def).tekst;
        var inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: start, id: 'kpi-inp-' + def.id, 'aria-describedby': 'kpi-hj-' + def.id, class: 'kpi-regk-input' });
        inputs[def.id] = inp;
        var maalMnd = L.erTall(def.maal) ? (def.maaltype === 'HIA' ? def.maal / 12 : def.maal) : null;
        var statusEl = h('span', { class: 'kpi-regk-status' });
        var deltaEl = h('span', { class: 'kpi-regk-delta' });
        var kortEl = h('div', { class: 'kpi-regk' }, [
          h('div', { class: 'kpi-regk-topp' }, [
            h('label', { for: inp.id, class: 'kpi-regk-navn' }, [h('span', null, def.navn), h('span', { class: 'kpi-enhet-merke' }, def.enhet)]),
            statusEl,
          ]),
          h('div', { class: 'kpi-regk-felt' }, [
            h('div', { class: 'kpi-regk-inputwrap' }, [inp, def.enhet === '%' ? h('span', { class: 'kpi-regk-suffiks' }, '%') : def.enhet === 'Kr' ? h('span', { class: 'kpi-regk-suffiks' }, 'kr') : null]),
            deltaEl,
          ]),
          h('div', { class: 'kpi-regk-sammenlign', id: 'kpi-hj-' + def.id }, [
            n > 1 ? h('span', null, [h('small', null, L.mndNavn(n - 1)), h('b', null, k.fmt(forrige[def.id], def))]) : null,
            h('span', null, [h('small', null, 'I fjor'), h('b', null, k.fmt(fjor[def.id], def))]),
            maalMnd !== null ? h('span', null, [h('small', null, def.maaltype === 'HIA' ? 'Mål/mnd' : 'Mål'), h('b', null, k.fmt(maalMnd, def, true))]) : null,
          ]),
        ]);
        inp.addEventListener('input', function () { utkast.verdier[def.id] = inp.value; inp.removeAttribute('aria-invalid'); oppdaterAlt(); });
        inp.addEventListener('focus', function () { inp.select(); });
        oppdaterere.push(function (kopi) {
          var v = verdiFor(def).tall;
          var gyldig = typeof v === 'number' && !isNaN(v);
          var gammel = L.erTall(naa[def.id]) ? naa[def.id] : null;
          kortEl.classList.toggle('is-tom', !gyldig);
          kortEl.classList.toggle('is-endret', Object.prototype.hasOwnProperty.call(utkast.verdier, def.id) && (gyldig ? v : null) !== gammel);
          kortEl.classList.toggle('is-ugyldig', typeof v === 'number' && isNaN(v));
          // Status hittil i år hvis verdien lagres
          var r = L.vurderKpi(def, d.config, kopi, d.fjorVerdier, n);
          var tone = k.TONE[r.status];
          statusEl.className = 'kpi-regk-status kpi-merke-' + tone;
          statusEl.textContent = '';
          statusEl.appendChild(U.icon(k.STATUS_IKON[r.status], 13));
          statusEl.appendChild(h('span', null, gyldig || L.erTall(r.faktisk) ? r.status + ' (HIÅ ' + k.fmt(r.faktisk, def) + ')' : 'Ingen data'));
          // Endring fra forrige måned, farget etter om den er bra eller dårlig
          deltaEl.textContent = '';
          deltaEl.className = 'kpi-regk-delta';
          if (gyldig && L.erTall(forrige[def.id])) {
            var diff = v - forrige[def.id];
            var bra = def.retning === 'Ned' ? diff < 0 : diff > 0;
            deltaEl.classList.add(diff === 0 ? 'is-lik' : bra ? 'is-bra' : 'is-darlig');
            deltaEl.textContent = (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '● ') + (diff === 0 ? 'som forrige måned' : (diff > 0 ? '+' : '−') + k.fmt(Math.abs(diff), def, true) + ' fra ' + L.mndNavn(n - 1).toLowerCase());
          }
        });
        return kortEl;
      });
      var antall = kpier.filter(function (x) { return x.omrade === omrade; }).length;
      return h('section', { class: 'kpi-regs', style: '--omr:' + farge }, [
        h('header', { class: 'kpi-regs-hode' }, [h('h2', null, omrade), h('span', { class: 'kpi-regs-antall' }, antall + (antall === 1 ? ' KPI' : ' KPI-er'))]),
        h('div', { class: 'kpi-regs-kort' }, kort),
      ]);
    });

    var mndValg = h('div', { class: 'kpi-reg-mnd', role: 'group', 'aria-label': 'Velg måned' }, L.MAANEDER.map(function (m, i) {
      var key = L.mndKey(i + 1);
      var ant = Object.keys((d.verdier && d.verdier[key]) || {}).filter(function (id) { return d.config.kpier[id] && d.config.kpier[id].aktiv !== false; }).length;
      var tilstand = ant >= kpier.length ? 'full' : ant ? 'delvis' : 'tom';
      return h('button', { type: 'button', class: 'kpi-reg-mndknapp is-' + tilstand + (i + 1 === n ? ' is-valgt' : ''), 'aria-pressed': i + 1 === n ? 'true' : 'false', title: m + ': ' + ant + ' av ' + kpier.length + ' registrert', on: { click: function () { k.settMaaned(i + 1); } } }, m.slice(0, 3));
    }));

    var form = h('form', { class: 'kpi-reg-skjema', novalidate: true }, [
      h('section', { class: 'kpi-reg-topp' }, [
        h('div', { class: 'kpi-reg-tittel' }, [
          h('h2', null, 'Verdier for ' + L.mndNavn(n).toLowerCase() + ' ' + d.aar),
          h('div', { class: 'kpi-reg-sist' }, reg ? [U.icon('check', 14), h('span', null, 'Sist lagret av ' + k.navnFraUid(reg.av) + ' · ' + k.datoTid(reg.at))] : [U.icon('clock', 14), h('span', null, 'Ikke registrert ennå')]),
        ]),
        mndValg,
        h('p', { class: 'kpi-reg-hint' }, 'Skriv månedens tall (ikke hittil i år). Prosent skrives som 94,8. Enter går til neste felt. La feltet stå tomt hvis tallet ikke finnes ennå.'),
      ]),
    ].concat(seksjoner).concat([
      feilBoks,
      h('div', { class: 'kpi-reg-lagrelinje' }, [
        h('div', { class: 'kpi-regf' }, [fremdriftTekst, h('span', { class: 'kpi-regf-bar', 'aria-hidden': 'true' }, fremdriftFyll), endretTekst]),
        h('span', { class: 'kpi-spacer' }),
        U.button('Forkast', { variant: 'ghost', on: { click: function () { utkast = { nokkel: '', verdier: {} }; k.render({ tvinges: true }); } } }),
        lagreBtn,
      ]),
    ]));

    // Enter: neste felt (siste felt: lagre)
    var rekkefolge = kpier.map(function (x) { return inputs[x.id]; });
    rekkefolge.forEach(function (inp, i) {
      inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i < rekkefolge.length - 1) rekkefolge[i + 1].focus(); else lagreBtn.focus();
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.lagrer) return;
      var verdier = {}, feil = [];
      kpier.forEach(function (def) {
        var v = L.parseTall(inputs[def.id].value);
        if (typeof v === 'number' && isNaN(v)) { feil.push(def.navn); inputs[def.id].setAttribute('aria-invalid', 'true'); return; }
        if (def.enhet === '%' && v !== null && (v < 0 || v > 100)) { feil.push(def.navn + ' (0–100)'); inputs[def.id].setAttribute('aria-invalid', 'true'); return; }
        verdier[def.id] = v;
      });
      if (feil.length) {
        feilBoks.hidden = false; feilBoks.textContent = 'Sjekk tallene for: ' + feil.join(', ') + '.';
        var forste = form.querySelector('[aria-invalid="true"]'); if (forste) forste.focus();
        return;
      }
      state.lagrer = true; k.render({ tvinges: true });
      k.call('saveKpiMaanedV1', { aar: d.aar, maaned: n, verdier: verdier }).then(function (res) {
        utkast = { nokkel: '', verdier: {} };
        k.host().toast(res.endret ? res.endret + ' verdier lagret for ' + L.mndNavn(n).toLowerCase() + ' ✓' : 'Ingen endringer å lagre');
        return k.last(d.aar);
      }).then(function () { state.lagrer = false; k.gaaTil('oversikt'); }, function (err) {
        state.lagrer = false; k.render({ tvinges: true });
        k.host().toast(err.message || 'Kunne ikke lagre', true);
      });
    });

    oppdaterAlt();
    return [form];
  }

  root.OpExKpiRegistrer = Object.freeze({ bygg: bygg, harUtkast: function () { return Object.keys(utkast.verdier).length > 0; } });
}(typeof self !== 'undefined' ? self : this));
