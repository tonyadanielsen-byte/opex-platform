/*
 * sak-list.js — oversikten over saker: kort sortert etter hva som trenger oppmerksomhet.
 * Ren visning: bygger DOM fra view-modellen. Ingen datahenting og ingen skriving her.
 */
(function (root) {
  'use strict';

  var U = root.OpExSakUi, h = U.h;

  var NIVAA_TEKST = { kritisk: 'Krever handling', advarsel: 'Bør følges opp', rolig: '' };
  var NIVAA_IKON = { kritisk: 'alert', advarsel: 'info' };

  function stat(label, value, tone) {
    return h('div', { class: 'sak-stat' + (tone ? ' sak-stat-' + tone : '') }, [h('dd', null, String(value)), h('dt', null, label)]);
  }

  function kort(k, handlers) {
    var s = k.summary;
    var tittelBtn = h('button', { type: 'button', class: 'sak-card-link', on: { click: function () { handlers.apne(k.sakId); } } }, [
      h('span', { class: 'sak-visually-hidden' }, k.kode + ': '), k.tittel,
    ]);
    var topp = h('div', { class: 'sak-card-top' }, [
      h('span', { class: 'sak-kode' }, k.kode),
      U.chip(k.statusMeta, k.status),
    ]);
    var flagg = k.nivaa !== 'rolig'
      ? h('p', { class: 'sak-flag sak-tone-' + (k.nivaa === 'kritisk' ? 'danger' : 'warn') }, [U.icon(NIVAA_IKON[k.nivaa], 16), h('span', null, [h('b', null, NIVAA_TEKST[k.nivaa] + ': '), k.nivaaArsak])])
      : null;

    var fremdrift;
    if (s.totalt === 0) {
      fremdrift = h('p', { class: 'sak-progress-text sak-muted' }, 'Ingen tiltak koblet ennå');
    } else {
      fremdrift = h('div', { class: 'sak-progress' }, [
        h('p', { class: 'sak-progress-text' }, [h('b', null, s.gjort + ' av ' + (s.gjort + s.gjenstar)), ' fullført', k.prosent !== null ? h('span', { class: 'sak-muted' }, ' · ' + k.prosent + ' %') : null]),
        h('div', { class: 'sak-bar', role: 'img', 'aria-label': k.prosent === null ? 'Ingen fremdrift å vise' : 'Fremdrift ' + k.prosent + ' prosent' }, h('span', { style: 'width:' + (k.prosent || 0) + '%' })),
      ]);
    }

    var footer = h('div', { class: 'sak-card-foot' }, [
      h('span', { class: 'sak-foot-item' }, [U.icon('user', 14), k.eierNavn || 'Ingen eier']),
      k.nesteFristTekst ? h('span', { class: 'sak-foot-item' }, [U.icon('calendar', 14), 'Neste frist: ' + k.nesteFristTekst]) : null,
      h('span', { class: 'sak-foot-item' }, [U.icon('activity', 14), k.aktivitetLastet ? (k.sisteAktivitetTekst ? 'Aktivitet ' + k.sisteAktivitetTekst : 'Ingen aktivitet') : 'Henter aktivitet …']),
    ]);

    return h('article', { class: 'sak-card sak-nivaa-' + k.nivaa + (k.lukket ? ' is-closed' : ''), data: { sakId: k.sakId } }, [
      topp,
      h('h3', { class: 'sak-card-title' }, tittelBtn),
      flagg,
      fremdrift,
      h('dl', { class: 'sak-stats' }, [stat('Tiltak', s.totalt), stat('Fullført', s.gjort, 'ok'), stat('Gjenstår', s.gjenstar), stat('Forfalt', s.forfalt, s.forfalt ? 'danger' : null)]),
      footer,
    ]);
  }

  function skeleton() {
    return h('div', { class: 'sak-grid', 'aria-hidden': 'true' }, [1, 2, 3].map(function () { return h('div', { class: 'sak-card sak-skeleton' }, [h('span'), h('span'), h('span')]); }));
  }

  /**
   * ctx: { modell (byggListeModell), laster, feil (SakApiError|null), utdatert (string|null), handlers:{apne,ny,pruv,oppdater} }
   */
  function byggListe(ctx) {
    var m = ctx.modell;
    var root0 = h('div', { class: 'sak-page' });

    root0.appendChild(h('header', { class: 'sak-pagehead' }, [
      h('div', null, [
        h('h1', null, 'Saker'),
        h('p', { class: 'sak-muted' }, m && m.totalt ? (m.kreverOppmerksomhet ? m.kreverOppmerksomhet + (m.kreverOppmerksomhet === 1 ? ' sak' : ' saker') + ' trenger oppmerksomhet' : 'Alt ser rolig ut') : 'Følg opp et problem på tvers av flere tiltak'),
      ]),
      h('div', { class: 'sak-actions' }, [
        U.button('', { icon: 'refresh', variant: 'ghost', ariaLabel: 'Oppdater', title: 'Oppdater', on: { click: ctx.handlers.oppdater }, disabled: ctx.laster }),
        U.button('Ny sak', { icon: 'plus', variant: 'primary', on: { click: ctx.handlers.ny } }),
      ]),
    ]));

    if (ctx.utdatert) root0.appendChild(h('div', { class: 'sak-alert sak-tone-warn', role: 'status' }, [U.icon('info', 16), h('span', null, ctx.utdatert)]));

    if (ctx.feil && !m) {
      root0.appendChild(h('div', { class: 'sak-alert sak-tone-danger', role: 'alert' }, [
        U.icon('alert', 18), h('div', null, [h('b', null, 'Kunne ikke hente saker'), h('p', null, ctx.feil.message)]),
        U.button('Prøv igjen', { small: true, on: { click: ctx.handlers.pruv } }),
      ]));
      return root0;
    }
    if (!m) { root0.appendChild(skeleton()); return root0; }
    if (ctx.feil) root0.appendChild(h('div', { class: 'sak-alert sak-tone-warn', role: 'status' }, [U.icon('info', 16), h('span', null, 'Kunne ikke oppdatere: ' + ctx.feil.message)]));

    if (!m.totalt) {
      root0.appendChild(h('div', { class: 'sak-empty' }, [
        U.icon('layers', 40),
        h('h2', null, 'Ingen saker ennå'),
        h('p', null, 'En sak samler tiltak rundt ett problem, for eksempel et avvik som krever flere tiltak. Opprett en sak og koble eksisterende tiltak til den.'),
        U.button('Opprett første sak', { icon: 'plus', variant: 'primary', on: { click: ctx.handlers.ny } }),
      ]));
      return root0;
    }

    if (m.aktive.length) {
      root0.appendChild(h('div', { class: 'sak-grid' }, m.aktive.map(function (k) { return kort(k, ctx.handlers); })));
    } else {
      root0.appendChild(h('p', { class: 'sak-muted sak-pad' }, 'Ingen åpne saker.'));
    }

    if (m.lukkede.length) {
      var det = h('details', { class: 'sak-closed-group', open: !!ctx.visLukkede }, [
        h('summary', null, [U.icon('lock', 16), 'Løste og lukkede saker (' + m.lukkede.length + ')']),
        h('div', { class: 'sak-grid' }, m.lukkede.map(function (k) { return kort(k, ctx.handlers); })),
      ]);
      det.addEventListener('toggle', function () { if (ctx.handlers.lukkedeToggle) ctx.handlers.lukkedeToggle(det.open); });
      root0.appendChild(det);
    }
    return root0;
  }

  root.OpExSakList = Object.freeze({ byggListe: byggListe });
}(typeof self !== 'undefined' ? self : this));
