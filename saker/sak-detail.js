/*
 * sak-detail.js — sakssiden: Ledelsesbilde, Krever handling, Årsaksbilde, Tiltak, Aktivitet.
 * Ren visning av view-modellen (byggSakModell). Brukertekst settes alltid som tekstnoder.
 */
(function (root) {
  'use strict';

  var U = root.OpExSakUi, h = U.h;
  var AKTIVITET_SIDE = 15;

  function section(id, tittel, ikon, innhold, opts) {
    var o = opts || {};
    var hid = U.nextId('sak-h');
    return h('section', { class: 'sak-section', id: 'sak-sec-' + id, 'aria-labelledby': hid }, [
      h('div', { class: 'sak-section-head' }, [h('h2', { id: hid }, [U.icon(ikon, 18), tittel]), o.actions || null]),
      o.note ? h('p', { class: 'sak-note' }, o.note) : null,
      innhold,
    ]);
  }

  function kpi(label, value, tone, sub) {
    return h('div', { class: 'sak-kpi' + (tone ? ' sak-kpi-' + tone : '') }, [h('dd', null, String(value)), h('dt', null, label), sub ? h('small', null, sub) : null]);
  }

  /* ------------------------------------------------------------------ 1. ledelsesbilde */

  function ledelsesbilde(m) {
    var s = m.summary;
    var fremdrift = s.totalt === 0
      ? h('p', { class: 'sak-muted' }, 'Ingen tiltak er koblet til saken, så det finnes ingen fremdrift å vise.')
      : h('div', { class: 'sak-progress sak-progress-lg' }, [
        h('p', { class: 'sak-progress-text' }, [h('b', null, s.gjort + ' av ' + (s.gjort + s.gjenstar)), ' tiltak fullført', m.prosent !== null ? h('span', { class: 'sak-muted' }, ' · ' + m.prosent + ' %') : null]),
        h('div', { class: 'sak-bar', role: 'img', 'aria-label': m.prosent === null ? 'Ingen fremdrift' : 'Fremdrift ' + m.prosent + ' prosent' }, h('span', { style: 'width:' + (m.prosent || 0) + '%' })),
      ]);
    var ekstra = [];
    if (s.stanset) ekstra.push(s.stanset + ' stanset');
    if (s.avsluttet) ekstra.push(s.avsluttet + ' avsluttet');
    return h('div', { class: 'sak-lead' }, [
      m.sak.problemstilling ? h('p', { class: 'sak-problem' }, m.sak.problemstilling) : h('p', { class: 'sak-muted' }, 'Ingen problemstilling er skrevet. Legg den til under «Rediger».'),
      h('div', { class: 'sak-meta' }, [
        h('span', { class: 'sak-meta-item' }, [U.avatar(m.sak.eierNavn), h('span', null, [h('small', null, 'Eier'), m.sak.eierNavn || 'Ingen eier'])]),
        m.sak.omrader && m.sak.omrader.length ? h('span', { class: 'sak-meta-item' }, [U.icon('layers', 16), h('span', null, [h('small', null, 'Områder'), m.sak.omrader.join(', ')])]) : null,
        m.sak.opprettetDato ? h('span', { class: 'sak-meta-item' }, [U.icon('calendar', 16), h('span', null, [h('small', null, 'Opprettet'), U.fmtDato(m.sak.opprettetDato, m.idag)])]) : null,
      ]),
      fremdrift,
      h('dl', { class: 'sak-kpis' }, [
        kpi('Tiltak', s.totalt, null, ekstra.join(' · ')),
        kpi('Fullført', s.gjort, 'ok'),
        kpi('Gjenstår', s.gjenstar),
        kpi('Forfalt', s.forfalt, s.forfalt ? 'danger' : null),
        kpi('Neste frist', m.nesteFristTekst || '–', null),
        kpi('Siste aktivitet', m.sisteAktivitetTekst || '–', null),
      ]),
    ]);
  }

  /* ------------------------------------------------------------------ 2. krever handling */

  function kreverHandling(m, H) {
    if (m.sak.lukket) return h('p', { class: 'sak-empty-inline' }, [U.icon('lock', 16), 'Saken er lukket og låst. Åpne den igjen ved å endre status hvis den skal følges opp videre.']);
    if (!m.kreverHandling.length) return h('p', { class: 'sak-empty-inline sak-tone-ok' }, [U.icon('check', 16), 'Ingenting krever handling akkurat nå.']);
    return h('ul', { class: 'sak-todo' }, m.kreverHandling.map(function (k) {
      var kn = null;
      var hd = k.handling;
      if (hd) {
        var on = null;
        if (hd.type === 'apneTiltak') on = function () { H.apneTiltak(hd.tiltakId); };
        else if (hd.type === 'kobleTiltak') on = function () { H.kobleTiltak(); };
        else if (hd.type === 'nyArsak') on = function () { var sp = m.spor.filter(function (x) { return x.sporId === hd.sporId; })[0]; if (sp) H.nyArsak(sp); };
        else if (hd.type === 'sporForTiltak') on = function () { var r = m.alleTiltak.filter(function (x) { return x.id === hd.tiltakId; })[0]; if (r) H.endreSpor(r); };
        else if (hd.type === 'status') on = function () { H.endreStatus(k.id === 'alle-ferdig' ? 'Løst' : undefined); };
        if (on) kn = U.button(hd.label, { small: true, variant: 'secondary', on: { click: on } });
      }
      return h('li', { class: 'sak-todo-item sak-nivaa-' + k.nivaa }, [
        h('span', { class: 'sak-todo-ico sak-tone-' + (k.nivaa === 'kritisk' ? 'danger' : k.nivaa === 'advarsel' ? 'warn' : 'info') }, U.icon(k.ikon, 18)),
        h('div', { class: 'sak-todo-text' }, [h('b', null, k.tekst), k.detalj ? h('small', null, k.detalj) : null]),
        kn,
      ]);
    }));
  }

  /* ------------------------------------------------------------------ 3. årsaksbilde */

  function arsakKort(m, sp, a, H, ui) {
    var meta = a.meta;
    var grunnlag = a.grunnlag ? h('details', { class: 'sak-grunnlag' }, [h('summary', null, 'Grunnlag'), h('p', null, a.grunnlag)]) : (a.status === 'hypotese' ? null : h('p', { class: 'sak-muted sak-small' }, 'Uten registrert grunnlag'));
    var vurdert = a.vurdertAvNavn ? 'Vurdert av ' + a.vurdertAvNavn + (a.vurdertDato ? ' · ' + U.fmtDato(a.vurdertDato, m.idag) : '') : '';
    var laast = m.sak.lukket;
    return h('li', { class: 'sak-arsak sak-arsak-' + a.status + (a.fjernet ? ' is-removed' : '') }, [
      h('div', { class: 'sak-arsak-top' }, [U.chip(meta, meta.label), a.fjernet ? h('span', { class: 'sak-chip sak-tone-muted' }, 'Fjernet') : null]),
      h('p', { class: 'sak-arsak-tekst' }, a.tekst),
      grunnlag,
      vurdert ? h('p', { class: 'sak-attrib' }, [U.icon('user', 13), vurdert, h('span', { class: 'sak-evidence' }, 'Menneskelig vurdering')]) : null,
      !a.fjernet && !laast ? h('div', { class: 'sak-row-actions' }, [
        U.button('Vurder', { icon: 'badge-check', small: true, variant: 'ghost', on: { click: function () { H.vurder(sp, a); } } }),
        U.button('Fjern', { icon: 'x', small: true, variant: 'ghost', on: { click: function () { H.fjernArsak(a); } } }),
      ]) : null,
    ]);
  }

  function arsaksbilde(m, H, ui) {
    if (!m.spor.length) {
      return h('div', null, [h('p', { class: 'sak-empty-inline' }, [U.icon('flag', 16), 'Saken har ingen spor ennå. Legg til et spørsmål for å starte.']), !m.sak.lukket ? U.button('Legg til spor', { icon: 'plus', variant: 'secondary', on: { click: H.nySpor } }) : null]);
    }
    return h('div', { class: 'sak-spor-list' }, [m.spor.map(function (sp) {
      var visFjernet = !!ui.visFjernet[sp.sporId];
      var liste = sp.arsaker.concat(visFjernet ? sp.fjernede : []);
      return h('div', { class: 'sak-spor' }, [
        h('div', { class: 'sak-spor-head' }, [
          h('span', { class: 'sak-spor-badge', 'aria-hidden': 'true' }, sp.kode),
          h('div', null, [h('h3', null, 'Spor ' + sp.kode), h('p', null, sp.sporsmal)]),
        ]),
        liste.length ? h('ul', { class: 'sak-arsaker' }, liste.map(function (a) { return arsakKort(m, sp, a, H, ui); }))
          : h('p', { class: 'sak-empty-inline' }, [U.icon('help', 16), 'Ingen årsaker registrert for dette sporet ennå.']),
        h('div', { class: 'sak-spor-foot' }, [
          !m.sak.lukket ? U.button('Registrer årsak', { icon: 'plus', small: true, variant: 'secondary', on: { click: function () { H.nyArsak(sp); } } }) : null,
          sp.fjernede.length ? U.button(visFjernet ? 'Skjul fjernede (' + sp.fjernede.length + ')' : 'Vis fjernede (' + sp.fjernede.length + ')', { small: true, variant: 'ghost', on: { click: function () { ui.visFjernet[sp.sporId] = !visFjernet; H.tegnPaaNytt(); } } }) : null,
        ]),
      ]);
    }), !m.sak.lukket && m.spor.length < 8 ? U.button('Legg til spor', { icon: 'plus', variant: 'secondary', on: { click: H.nySpor } }) : null]);
  }

  /* ------------------------------------------------------------------ 4. tiltak */

  function tiltakRad(m, r, H, andreSporTekst) {
    var laast = m.sak.lukket;
    var sporChips = r.sporIds.map(function (id) { var sp = m.spor.filter(function (x) { return x.sporId === id; })[0]; return sp ? h('span', { class: 'sak-spor-pill' }, sp.kode) : null; });
    return h('li', { class: 'sak-tiltak sak-tiltak-' + r.klasse + (r.forfalt ? ' is-overdue' : '') }, [
      h('div', { class: 'sak-tiltak-main' }, [
        h('button', { type: 'button', class: 'sak-tiltak-title', on: { click: function () { H.apneTiltak(r.id); } }, 'aria-label': 'Åpne tiltak: ' + r.tittel }, r.tittel),
        h('div', { class: 'sak-tiltak-meta' }, [
          r.systemId ? h('span', { class: 'sak-kode' }, r.systemId) : null,
          r.eier ? h('span', null, [U.icon('user', 13), r.eier]) : null,
          h('span', { class: r.forfalt ? 'sak-due' : '' }, [U.icon('calendar', 13), r.frist ? U.fmtDato(r.frist, m.idag) + ' · ' + r.fristTekst : 'Ingen frist']),
          sporChips.length ? h('span', { class: 'sak-spor-pills', title: 'Spor' }, sporChips) : null,
          andreSporTekst ? h('span', { class: 'sak-muted' }, andreSporTekst) : null,
          r.arkivertIkkeFerdig ? h('span', { class: 'sak-chip sak-tone-warn' }, [U.icon('info', 14), h('span', null, 'Arkivert uten å være ferdig')]) : null,
        ]),
      ]),
      h('div', { class: 'sak-tiltak-side' }, [
        U.chip(r.statusMeta, r.statusMeta.label),
        !laast ? h('div', { class: 'sak-row-actions' }, [
          m.spor.length ? U.button('', { icon: 'flag', small: true, variant: 'ghost', ariaLabel: 'Endre spor for ' + r.tittel, title: 'Endre spor', on: { click: function () { H.endreSpor(r); } } }) : null,
          U.button('', { icon: 'x', small: true, variant: 'ghost', ariaLabel: 'Frakoble ' + r.tittel, title: 'Frakoble fra saken', on: { click: function () { H.frakoble(r); } } }),
        ]) : null,
      ]),
    ]);
  }

  function tiltakGruppe(tittel, ikon, rader, m, H, undertekst) {
    return h('div', { class: 'sak-group' }, [
      h('h3', { class: 'sak-group-title' }, [U.icon(ikon, 16), tittel, h('span', { class: 'sak-count' }, String(rader.length))]),
      undertekst ? h('p', { class: 'sak-hint' }, undertekst) : null,
      h('ul', { class: 'sak-tiltak-list' }, rader.map(function (r) {
        var andre = m.spor.length && r.sporIds.length > 1 ? 'også i ' + r.sporIds.map(function (id) { var sp = m.spor.filter(function (x) { return x.sporId === id; })[0]; return sp ? 'spor ' + sp.kode : ''; }).filter(Boolean).join(', ') : '';
        return tiltakRad(m, r, H, andre);
      })),
    ]);
  }

  function tiltakSeksjon(m, H) {
    var s = m.summary;
    if (s.totalt === 0 && s.ekskludert === 0 && !m.ikkeKoblet.length) {
      return h('div', { class: 'sak-empty-inline sak-empty-big' }, [
        U.icon('link', 28),
        h('p', null, 'Ingen tiltak er koblet til denne saken.'),
        !m.sak.lukket ? U.button('Koble tiltak', { icon: 'link', variant: 'primary', on: { click: H.kobleTiltak } }) : null,
      ]);
    }
    var deler = [];
    m.spor.forEach(function (sp) {
      deler.push(sp.tiltak.length ? tiltakGruppe('Spor ' + sp.kode + ' · ' + sp.sporsmal, 'flag', sp.tiltak, m, H) : h('div', { class: 'sak-group' }, [
        h('h3', { class: 'sak-group-title' }, [U.icon('flag', 16), 'Spor ' + sp.kode + ' · ' + sp.sporsmal, h('span', { class: 'sak-count' }, '0')]),
        h('p', { class: 'sak-empty-inline' }, 'Ingen tiltak er koblet til dette sporet.'),
      ]));
    });
    if (m.ikkeKoblet.length) deler.push(tiltakGruppe(m.spor.length ? 'Ikke koblet til spor' : 'Tiltak', 'list', m.ikkeKoblet, m, H, m.spor.length ? 'Tiltak i saken som ikke svarer på noe bestemt spor ennå.' : null));
    var sep = m.separate.stanset.concat(m.separate.avsluttet);
    if (sep.length) {
      deler.push(h('details', { class: 'sak-group sak-group-closed' }, [
        h('summary', null, [U.icon('pause', 16), 'Stansede og avsluttede (' + sep.length + ')']),
        h('p', { class: 'sak-hint' }, 'Regnes ikke med i fremdriften.'),
        h('ul', { class: 'sak-tiltak-list' }, sep.map(function (r) { return tiltakRad(m, r, H, ''); })),
      ]));
    }
    return h('div', { class: 'sak-groups' }, deler);
  }

  /* ------------------------------------------------------------------ 5. aktivitet */

  function aktivitet(m, ui, H) {
    var wrap = h('div', { class: 'sak-activity' });
    if (m.aktivitetTom) {
      wrap.appendChild(h('p', { class: 'sak-empty-inline' }, [U.icon('activity', 16), 'Ingen aktivitet er registrert for denne saken ennå.']));
    } else {
      var vis = m.aktivitet.slice(0, ui.aktivitetAntall);
      var grupper = [], sist = null;
      vis.forEach(function (a) {
        if (!sist || sist.dato !== a.dato) { sist = { dato: a.dato, rader: [] }; grupper.push(sist); }
        sist.rader.push(a);
      });
      wrap.appendChild(h('ol', { class: 'sak-timeline' }, grupper.map(function (g) {
        return h('li', { class: 'sak-day' }, [
          h('h3', null, g.dato === m.idag ? 'I dag' : U.fmtDato(g.dato, m.idag)),
          h('ul', null, g.rader.map(function (a) {
            return h('li', { class: 'sak-event sak-event-' + a.kilde }, [
              h('span', { class: 'sak-event-ico' }, U.icon(a.ikon, 15)),
              h('div', null, [h('span', { class: 'sak-event-text' }, a.tekst), h('small', null, [a.aktor ? a.aktor + ' · ' : '', U.fmtTid(a.createdAt)].join('')), a.detaljer ? h('details', { class: 'sak-grunnlag' }, [h('summary', null, 'Vis ' + a.detaljer.length + ' enkelthendelser'), h('ul', null, a.detaljer.map(function (e) { return h('li', null, e.tekst); }))]) : null]),
            ]);
          })),
        ]);
      })));
      if (m.aktivitet.length > vis.length) {
        wrap.appendChild(U.button('Vis flere (' + (m.aktivitet.length - vis.length) + ' til)', { variant: 'ghost', small: true, on: { click: function () { ui.aktivitetAntall += AKTIVITET_SIDE; H.tegnPaaNytt(); } } }));
      }
    }
    if (m.aktivitetAvkortet) {
      wrap.appendChild(h('p', { class: 'sak-alert sak-tone-info sak-trunc', role: 'note' }, [U.icon('info', 16), h('span', null, 'Historikken er avkortet: bare de nyeste hendelsene vises. Eldre hendelser er lagret, men ikke med her.')]));
    }
    return wrap;
  }

  /* ------------------------------------------------------------------ side */

  /**
   * ctx: { modell (byggSakModell), laster, feil, utdatert, ui:{visFjernet,aktivitetAntall}, handlers }
   */
  function byggDetalj(ctx) {
    var m = ctx.modell, H = ctx.handlers;
    var page = h('div', { class: 'sak-page sak-detail' });
    page.appendChild(h('div', { class: 'sak-crumbs', role: 'navigation', 'aria-label': 'Brødsmule' }, [
      U.button('Alle saker', { icon: 'chevron-left', variant: 'ghost', small: true, on: { click: H.tilbake } }),
    ]));

    if (!m) {
      if (ctx.feil) {
        page.appendChild(h('div', { class: 'sak-alert sak-tone-danger', role: 'alert' }, [
          U.icon('alert', 18), h('div', null, [h('b', null, ctx.feil.code === 'not-found' ? 'Fant ikke saken' : 'Kunne ikke hente saken'), h('p', null, ctx.feil.message)]),
          ctx.feil.code === 'not-found' ? null : U.button('Prøv igjen', { small: true, on: { click: H.oppdater } }),
        ]));
      } else {
        page.appendChild(h('div', { class: 'sak-card sak-skeleton sak-skeleton-lg', 'aria-hidden': 'true' }, [h('span'), h('span'), h('span')]));
        page.appendChild(h('p', { class: 'sak-visually-hidden', role: 'status' }, 'Henter saken'));
      }
      return page;
    }

    var lukket = m.sak.lukket;
    page.appendChild(h('header', { class: 'sak-detail-head' }, [
      h('div', { class: 'sak-detail-title' }, [
        h('div', { class: 'sak-card-top' }, [h('span', { class: 'sak-kode' }, m.sak.kode), U.chip(m.sak.statusMeta, m.sak.status)]),
        h('h1', null, m.sak.tittel),
      ]),
      h('div', { class: 'sak-actions' }, [
        U.button('Endre status', { icon: 'flag', variant: 'secondary', on: { click: function () { H.endreStatus(); } } }),
        !lukket ? U.button('Rediger', { icon: 'pencil', variant: 'ghost', on: { click: H.rediger } }) : null,
        !lukket ? U.button('Koble tiltak', { icon: 'link', variant: 'primary', on: { click: H.kobleTiltak } }) : null,
        U.button('', { icon: 'refresh', variant: 'ghost', ariaLabel: 'Oppdater', title: 'Oppdater', disabled: ctx.laster, on: { click: H.oppdater } }),
      ]),
    ]));
    if (ctx.utdatert) page.appendChild(h('div', { class: 'sak-alert sak-tone-warn', role: 'status' }, [U.icon('info', 16), h('span', null, ctx.utdatert)]));
    if (ctx.feil) page.appendChild(h('div', { class: 'sak-alert sak-tone-warn', role: 'status' }, [U.icon('info', 16), h('span', null, 'Kunne ikke oppdatere: ' + ctx.feil.message)]));

    page.appendChild(section('ledelse', 'Ledelsesbilde', 'layers', ledelsesbilde(m), { note: 'Tallene beregnes fra tiltakene hver gang siden vises. De lagres aldri.' }));
    page.appendChild(section('handling', 'Krever handling', 'alert', kreverHandling(m, H), m.kreverHandling.length && !lukket ? { actions: h('span', { class: 'sak-count' }, String(m.kreverHandling.length)) } : null));
    page.appendChild(section('arsaker', 'Årsaksbilde', 'help', arsaksbilde(m, H, ctx.ui), { note: 'Årsaker er menneskelige vurderinger. Hver vurdering viser hvem som gjorde den, og hvilket grunnlag som ligger bak.' }));
    page.appendChild(section('tiltak', 'Tiltak', 'list', tiltakSeksjon(m, H), { actions: !lukket && m.summary.totalt ? U.button('Koble tiltak', { icon: 'plus', small: true, variant: 'ghost', on: { click: H.kobleTiltak } }) : null }));
    page.appendChild(section('aktivitet', 'Aktivitet', 'activity', aktivitet(m, ctx.ui, H)));
    return page;
  }

  root.OpExSakDetail = Object.freeze({ byggDetalj: byggDetalj });
}(typeof self !== 'undefined' ? self : this));
