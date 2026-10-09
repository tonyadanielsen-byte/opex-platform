/*
 * sak-forms.js — dialoger og skjemaer for Saker. Egen, enkel dialog-infrastruktur (fokusfelle, Esc, bunnark på mobil).
 * Alle endringer går via OpExSakStore (callables). Dialogen lukkes og suksess meldes FØRST etter at serveren har bekreftet.
 * Feil vises inne i dialogen med serverens (norske) melding, og dialogen blir stående slik at brukeren ikke mister input.
 */
(function (root) {
  'use strict';

  var U = root.OpExSakUi, S = root.OpExSakStore, VM = root.OpExSakVm;
  var h = U.h;
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

  /* ------------------------------------------------------------------ dialog */

  /**
   * opts: { title, subtitle, submitLabel, submitVariant, cancelLabel, wide, body: HTMLElement, onSubmit: async () => void, hideSubmit }
   * onSubmit kaster ved feil (vises i dialogen). Returnerer { close, setError }.
   */
  function openDialog(opts) {
    var previous = document.activeElement;
    var titleId = U.nextId('sak-dlg-t');
    var errBox = h('div', { class: 'sak-alert sak-tone-danger', role: 'alert', hidden: true });
    var busy = false;
    var submitBtn = opts.hideSubmit ? null : U.button(opts.submitLabel || 'Lagre', { variant: opts.submitVariant || 'primary', type: 'submit' });
    var cancelBtn = U.button(opts.cancelLabel || 'Avbryt', { variant: 'ghost', on: { click: function () { if (!busy) close(); } } });
    var closeBtn = U.button('', { icon: 'x', variant: 'ghost', ariaLabel: 'Lukk', title: 'Lukk', class: 'sak-dlg-close', on: { click: function () { if (!busy) close(); } } });

    var form = h('form', { class: 'sak-dlg-form', novalidate: true }, [
      h('div', { class: 'sak-dlg-body' }, [opts.body, errBox]),
      h('div', { class: 'sak-dlg-foot' }, [cancelBtn, submitBtn]),
    ]);
    var dialog = h('div', { class: 'sak-dialog' + (opts.wide ? ' sak-dialog-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h('div', { class: 'sak-dlg-head' }, [h('div', null, [h('h2', { id: titleId }, opts.title), opts.subtitle ? h('p', { class: 'sak-muted' }, opts.subtitle) : null]), closeBtn]),
      form,
    ]);
    var overlay = h('div', { class: 'sak-overlay sak-scope' }, dialog);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !busy) close(); });

    function setError(msg) {
      errBox.hidden = !msg;
      errBox.textContent = '';
      if (msg) { errBox.appendChild(U.icon('alert', 16)); errBox.appendChild(h('span', null, msg)); errBox.scrollIntoView && errBox.scrollIntoView({ block: 'nearest' }); }
    }
    function setBusy(b) {
      busy = b;
      dialog.classList.toggle('is-busy', b);
      dialog.setAttribute('aria-busy', b ? 'true' : 'false');
      Array.prototype.forEach.call(form.querySelectorAll('input,select,textarea,button'), function (el) { if (el !== cancelBtn) el.disabled = b || el.dataset.permDisabled === '1'; });
      cancelBtn.disabled = b; closeBtn.disabled = b;
      if (submitBtn) { var l = submitBtn.querySelector('.sak-btn-label'); if (l) l.textContent = b ? 'Lagrer …' : (opts.submitLabel || 'Lagre'); }
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      document.body.classList.remove('sak-noscroll');
      if (previous && previous.focus && document.contains(previous)) previous.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { if (!busy) { e.preventDefault(); e.stopPropagation(); close(); } return; }
      if (e.key !== 'Tab') return;
      var els = Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), function (x) { return x.offsetParent !== null; });
      if (!els.length) return;
      var first = els[0], last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy || !opts.onSubmit) return;
      setError('');
      setBusy(true);
      try {
        var res = await opts.onSubmit();
        if (res === false) { setBusy(false); return; } // validering i skjemaet: dialogen blir stående
        setBusy(false);
        close();
      } catch (err) {
        setBusy(false);
        setError((err && err.message) || 'Operasjonen feilet. Prøv igjen.');
      }
    });

    document.body.appendChild(overlay);
    document.body.classList.add('sak-noscroll');
    document.addEventListener('keydown', onKey, true);
    var autofocus = dialog.querySelector('[data-autofocus]') || dialog.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,select');
    (autofocus || dialog).focus();
    return { close: close, setError: setError, dialog: dialog };
  }

  /* ------------------------------------------------------------------ feltbygging */

  function field(label, control, hint, opts) {
    var id = U.nextId('sak-f');
    control.id = id;
    var o = opts || {};
    return h('div', { class: 'sak-field' }, [
      h('label', { for: id }, [label, o.required ? h('span', { class: 'sak-req', 'aria-hidden': 'true' }, ' *') : o.optional ? h('span', { class: 'sak-opt' }, ' (valgfri)') : null]),
      control,
      hint ? h('p', { class: 'sak-hint' }, hint) : null,
    ]);
  }

  function input(value, props) { return h('input', Object.assign({ type: 'text', value: value || '', autocomplete: 'off' }, props || {})); }
  function textarea(value, props) { var t = h('textarea', Object.assign({ rows: 3 }, props || {})); t.value = value || ''; return t; }
  function select(options, value) {
    var s = h('select', null, options.map(function (o) { var op = h('option', { value: o.value }, o.label); if (o.value === value) op.selected = true; return op; }));
    return s;
  }

  function users() { var h0 = root.OpExHost; return (h0 && h0.getUsers ? h0.getUsers() : []) || []; }
  function ownerOptions(currentUid) {
    var list = users().slice();
    if (currentUid && !list.some(function (u) { return u.uid === currentUid; })) list.push({ uid: currentUid, name: 'Ukjent bruker' });
    return list.map(function (u) { return { value: u.uid, label: u.name }; });
  }

  function parseOmrader(text) {
    return String(text || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function toastOk(msg) { var hh = root.OpExHost; if (hh && hh.toast) hh.toast(msg, false); }

  /* ------------------------------------------------------------------ ny sak */

  function nySak(opts) {
    var me = root.OpExHost.getUser();
    var tittel = input('', { maxlength: '120', 'data-autofocus': '1', placeholder: 'F.eks. Restlager ribbefett' });
    var problem = textarea('', { maxlength: '1500', placeholder: 'Hva er problemet, og hvorfor følger vi det opp som én sak?' });
    var eier = select(ownerOptions(me.uid), me.uid);
    var omrader = input('', { placeholder: 'F.eks. Ferdigmat, Frysa' });
    var sporWrap = h('div', { class: 'sak-spor-rows' });
    var rows = [];
    function addRow(value) {
      var inp = input(value || '', { maxlength: '200', placeholder: 'Spørsmålet dette sporet skal svare på' });
      var idx = rows.length;
      var kode = String.fromCharCode(65 + idx);
      var label = h('span', { class: 'sak-spor-kode', 'aria-hidden': 'true' }, kode);
      var wrap = h('div', { class: 'sak-spor-row' }, [label, inp]);
      inp.setAttribute('aria-label', 'Spørsmål for spor ' + kode);
      rows.push({ inp: inp, wrap: wrap });
      sporWrap.appendChild(wrap);
      return inp;
    }
    addRow('');
    var addBtn = U.button('Legg til spor', { icon: 'plus', variant: 'ghost', small: true, on: { click: function () { if (rows.length < 8) { addRow('').focus(); if (rows.length >= 8) addBtn.disabled = true; } } } });

    var body = h('div', { class: 'sak-form' }, [
      field('Tittel', tittel, null, { required: true }),
      field('Problemstilling', problem, 'Kort og konkret. Dette er det alle ser øverst i saken.', { optional: true }),
      field('Eier', eier, 'Den som har ansvaret for å følge opp saken.'),
      field('Områder', omrader, 'Skill med komma.', { optional: true }),
      h('fieldset', { class: 'sak-fieldset' }, [
        h('legend', null, 'Spor'),
        h('p', { class: 'sak-hint' }, 'Spor er spørsmålene saken skal besvare (f.eks. «Hvorfor ble det restlager?»). Tiltak og årsaker knyttes til spor. Spor settes når saken opprettes, og kan ikke endres senere.'),
        sporWrap, addBtn,
      ]),
    ]);

    return openDialog({
      title: 'Ny sak', subtitle: 'Saken får automatisk et SAK-nummer.', submitLabel: 'Opprett sak', body: body, wide: true,
      onSubmit: async function () {
        var t = tittel.value.trim();
        if (t.length < 3) { throw new Error('Tittel må ha minst 3 tegn.'); }
        var spor = rows.map(function (r) { return r.inp.value.trim(); }).filter(Boolean).map(function (s) { return { sporsmal: s }; });
        // Tomme rader hoppes over; serveren gir kodene A, B, C ... i rekkefølge.
        var r = await S.createSak({ tittel: t, problemstilling: problem.value.trim(), eierUid: eier.value, omrader: parseOmrader(omrader.value), spor: spor });
        toastOk('Sak ' + (r.kode || '') + ' opprettet');
        if (opts && opts.onDone) opts.onDone(r);
      },
    });
  }

  /* ------------------------------------------------------------------ rediger sak / status */

  function endreSak(sak, opts) {
    var tittel = input(sak.tittel, { maxlength: '120', 'data-autofocus': '1' });
    var problem = textarea(sak.problemstilling || '', { maxlength: '1500', rows: 4 });
    var eier = select(ownerOptions(sak.eierUid), sak.eierUid);
    var omrader = input((sak.omrader || []).join(', '));
    var body = h('div', { class: 'sak-form' }, [
      field('Tittel', tittel, null, { required: true }),
      field('Problemstilling', problem, null, { optional: true }),
      field('Eier', eier),
      field('Områder', omrader, 'Skill med komma.', { optional: true }),
    ]);
    return openDialog({
      title: 'Rediger sak ' + sak.kode, submitLabel: 'Lagre', body: body, wide: true,
      onSubmit: async function () {
        var t = tittel.value.trim();
        if (t.length < 3) throw new Error('Tittel må ha minst 3 tegn.');
        var data = { sakId: sak.sakId };
        if (t !== sak.tittel) data.tittel = t;
        if (problem.value.trim() !== (sak.problemstilling || '')) data.problemstilling = problem.value.trim();
        if (eier.value !== sak.eierUid) data.eierUid = eier.value;
        var nyeOmr = parseOmrader(omrader.value);
        if (nyeOmr.slice().sort().join('|') !== (sak.omrader || []).slice().sort().join('|')) data.omrader = nyeOmr;
        if (Object.keys(data).length === 1) throw new Error('Du har ikke endret noe.');
        await S.updateSak(data);
        toastOk('Saken er oppdatert');
      },
    });
  }

  function endreStatus(sak, anbefalt) {
    var valgt = sak.status;
    var name = U.nextId('sak-status');
    var radios = VM.SAK_STATUSER.map(function (st) {
      var meta = VM.SAK_STATUS_META[st];
      var r = h('input', { type: 'radio', name: name, value: st, checked: st === sak.status });
      r.addEventListener('change', function () { valgt = st; });
      return h('label', { class: 'sak-radio' + (anbefalt === st ? ' is-suggested' : '') }, [
        r, U.icon(meta.icon, 18),
        h('span', { class: 'sak-radio-text' }, [h('b', null, st), anbefalt === st ? h('span', { class: 'sak-suggest' }, ' Foreslått') : null, h('small', null, meta.beskrivelse)]),
      ]);
    });
    var body = h('div', { class: 'sak-form' }, [
      h('p', { class: 'sak-muted' }, 'Status settes alltid manuelt. Systemet foreslår bare, det endrer aldri status selv.'),
      h('div', { class: 'sak-radios', role: 'radiogroup', 'aria-label': 'Status' }, radios),
    ]);
    return openDialog({
      title: 'Endre status', subtitle: sak.kode + ' · ' + sak.tittel, submitLabel: 'Sett status', body: body,
      onSubmit: async function () {
        if (valgt === sak.status) throw new Error('Saken har allerede denne statusen.');
        await S.updateSak({ sakId: sak.sakId, status: valgt });
        toastOk('Status er satt til «' + valgt + '»');
      },
    });
  }

  /* ------------------------------------------------------------------ koble tiltak */

  /**
   * detail: getSakV1-resultat (for spor). tasks: appens tiltak. saker: alle saker (for å vise «i SAK-xxx»).
   */
  function kobleTiltak(model, detail, tasks, saker) {
    var valgte = {};
    var sokFelt = input('', { type: 'search', placeholder: 'Søk i tittel, ID eller eier', 'aria-label': 'Søk i tiltak', 'data-autofocus': '1' });
    var liste = h('div', { class: 'sak-pick-list', role: 'group', 'aria-label': 'Tiltak som kan kobles' });
    var teller = h('p', { class: 'sak-hint', 'aria-live': 'polite' });
    var sporBoxes = {};
    var sporGruppe = h('fieldset', { class: 'sak-fieldset' });
    var spor = (model.spor || []);

    if (spor.length) {
      sporGruppe.appendChild(h('legend', null, 'Koble til spor'));
      sporGruppe.appendChild(h('p', { class: 'sak-hint' }, 'Gjelder alle valgte tiltak. Du kan velge flere spor, eller ingen og koble til spor senere.'));
      spor.forEach(function (sp) {
        var cb = h('input', { type: 'checkbox', value: sp.sporId });
        sporBoxes[sp.sporId] = cb;
        sporGruppe.appendChild(h('label', { class: 'sak-check' }, [cb, h('span', null, [h('b', null, 'Spor ' + sp.kode), ' · ' + sp.sporsmal])]));
      });
    } else {
      sporGruppe.appendChild(h('p', { class: 'sak-hint' }, 'Saken har ingen spor. Tiltakene kobles til saken uten spor.'));
    }

    function tegn() {
      var k = VM.kobleKandidater(tasks, saker, sokFelt.value);
      liste.textContent = '';
      if (!k.ledige.length && !k.andreSaker.length) {
        liste.appendChild(h('p', { class: 'sak-empty-inline' }, sokFelt.value ? 'Ingen tiltak passer søket.' : 'Det finnes ingen tiltak å koble.'));
      }
      k.ledige.forEach(function (r) {
        var cb = h('input', { type: 'checkbox', value: r.id, checked: !!valgte[r.id] });
        cb.addEventListener('change', function () { if (cb.checked) valgte[r.id] = true; else delete valgte[r.id]; oppdaterTeller(); });
        liste.appendChild(h('label', { class: 'sak-pick' }, [cb, h('span', { class: 'sak-pick-text' }, [
          h('b', null, r.tittel),
          h('small', null, [r.systemId, r.eier, r.status, r.frist ? 'frist ' + U.fmtDato(r.frist, model.idag) : ''].filter(Boolean).join(' · ')),
        ])]));
      });
      if (k.andreSaker.length) {
        liste.appendChild(h('p', { class: 'sak-pick-sep' }, 'Allerede koblet til en sak (frakoble først for å flytte)'));
        k.andreSaker.forEach(function (r) {
          liste.appendChild(h('div', { class: 'sak-pick is-disabled' }, [U.icon('lock', 16), h('span', { class: 'sak-pick-text' }, [h('b', null, r.tittel), h('small', null, 'Koblet til ' + r.sakKode)])]));
        });
      }
    }
    function oppdaterTeller() { var n = Object.keys(valgte).length; teller.textContent = n ? n + (n === 1 ? ' tiltak valgt' : ' tiltak valgt') : 'Ingen tiltak valgt'; }
    sokFelt.addEventListener('input', tegn);
    tegn(); oppdaterTeller();

    var body = h('div', { class: 'sak-form' }, [field('Finn tiltak', sokFelt), liste, teller, sporGruppe]);

    return openDialog({
      title: 'Koble tiltak', subtitle: model.sak.kode + ' · ' + model.sak.tittel, submitLabel: 'Koble valgte', body: body, wide: true,
      onSubmit: async function () {
        var ids = Object.keys(valgte);
        if (!ids.length) throw new Error('Velg minst ett tiltak.');
        var sporIds = Object.keys(sporBoxes).filter(function (id) { return sporBoxes[id].checked; });
        var ok = 0, feil = [];
        for (var i = 0; i < ids.length; i++) {
          try { await S.setTiltakSak({ sakId: model.sak.sakId, tiltakId: ids[i], sporIds: sporIds }, { refresh: false }); ok++; }
          catch (e) { feil.push({ id: ids[i], msg: (e && e.message) || 'Feilet' }); }
        }
        if (ok) await S.refreshSak(model.sak.sakId);
        if (feil.length) {
          // Delvis feil: de som lyktes er bekreftet av serveren og fjernes fra utvalget; resten blir stående.
          var ids2 = ids.filter(function (id) { return feil.some(function (f) { return f.id === id; }); });
          valgte = {}; ids2.forEach(function (id) { valgte[id] = true; });
          tasks = (root.OpExHost.getTasks && root.OpExHost.getTasks()) || tasks;
          tegn(); oppdaterTeller();
          var titler = feil.map(function (f) { var t = (tasks || []).filter(function (x) { return x.fbKey === f.id; })[0]; return '«' + ((t && t.tittel) || f.id) + '»: ' + f.msg; });
          throw new Error((ok ? ok + ' av ' + ids.length + ' tiltak ble koblet. ' : 'Ingen tiltak ble koblet. ') + 'Feilet: ' + titler.join(' · '));
        }
        toastOk(ok === 1 ? 'Tiltaket er koblet til saken' : ok + ' tiltak er koblet til saken');
      },
    });
  }

  /* ------------------------------------------------------------------ endre spor for koblet tiltak / frakoble */

  function endreSporForTiltak(model, rad) {
    var boxes = {};
    var wrap = h('div', { class: 'sak-form' }, [h('p', { class: 'sak-muted' }, rad.tittel)]);
    var fs = h('fieldset', { class: 'sak-fieldset' }, [h('legend', null, 'Spor')]);
    model.spor.forEach(function (sp) {
      var cb = h('input', { type: 'checkbox', value: sp.sporId, checked: rad.sporIds.indexOf(sp.sporId) !== -1 });
      boxes[sp.sporId] = cb;
      fs.appendChild(h('label', { class: 'sak-check' }, [cb, h('span', null, [h('b', null, 'Spor ' + sp.kode), ' · ' + sp.sporsmal])]));
    });
    if (!model.spor.length) fs.appendChild(h('p', { class: 'sak-hint' }, 'Saken har ingen spor.'));
    wrap.appendChild(fs);
    return openDialog({
      title: 'Endre spor', subtitle: model.sak.kode, submitLabel: 'Lagre spor', body: wrap,
      onSubmit: async function () {
        var ids = Object.keys(boxes).filter(function (id) { return boxes[id].checked; });
        await S.setTiltakSak({ sakId: model.sak.sakId, tiltakId: rad.id, sporIds: ids });
        toastOk('Sporene er oppdatert');
      },
    });
  }

  function frakobleTiltak(model, rad) {
    var body = h('div', { class: 'sak-form' }, [
      h('p', null, ['Tiltaket ', h('b', null, rad.tittel), ' blir fjernet fra ' + model.sak.kode + '.']),
      h('p', { class: 'sak-muted' }, 'Selve tiltaket slettes ikke og endres ikke. Koblingen til sporene fjernes, og frakoblingen loggføres.'),
    ]);
    return openDialog({
      title: 'Frakoble tiltak?', subtitle: model.sak.kode + ' · ' + model.sak.tittel, submitLabel: 'Frakoble', submitVariant: 'danger', body: body,
      onSubmit: async function () {
        await S.removeTiltakSak({ sakId: model.sak.sakId, tiltakId: rad.id });
        toastOk('Tiltaket er frakoblet');
      },
    });
  }

  /* ------------------------------------------------------------------ årsaker */

  function statusRadios(valgtStatus, onChange) {
    var name = U.nextId('sak-as');
    return h('div', { class: 'sak-radios', role: 'radiogroup', 'aria-label': 'Vurderingsstatus' }, VM.ARSAK_STATUSER.map(function (st) {
      var meta = VM.ARSAK_STATUS_META[st];
      var r = h('input', { type: 'radio', name: name, value: st, checked: st === valgtStatus });
      r.addEventListener('change', function () { onChange(st); });
      return h('label', { class: 'sak-radio' }, [r, U.icon(meta.icon, 18), h('span', { class: 'sak-radio-text' }, [h('b', null, meta.label), h('small', null, meta.beskrivelse)])]);
    }));
  }

  function nyArsak(model, sp) {
    var status = 'hypotese';
    var tekst = textarea('', { maxlength: '600', rows: 3, 'data-autofocus': '1', placeholder: 'Hva tror eller vet du er årsaken?' });
    var grunnlag = textarea('', { maxlength: '1500', rows: 3, placeholder: 'Hva støtter dette? Dokument, måling, observasjon, samtale ...' });
    var body = h('div', { class: 'sak-form' }, [
      field('Årsak', tekst, null, { required: true }),
      h('div', { class: 'sak-field' }, [h('span', { class: 'sak-label' }, 'Vurdering'), statusRadios(status, function (s) { status = s; })]),
      field('Grunnlag', grunnlag, 'Påkrevd for «Støttet» og «Bekreftet». Ditt navn og tidspunkt lagres som vurderingen.', { optional: true }),
    ]);
    return openDialog({
      title: 'Registrer årsak', subtitle: 'Spor ' + sp.kode + ' · ' + sp.sporsmal, submitLabel: 'Registrer', body: body, wide: true,
      onSubmit: async function () {
        if (tekst.value.trim().length < 3) throw new Error('Beskriv årsaken (minst 3 tegn).');
        if ((status === 'støttet' || status === 'bekreftet') && grunnlag.value.trim().length < 3) throw new Error('«' + VM.ARSAK_STATUS_META[status].label + '» krever et grunnlag.');
        var data = { sakId: model.sak.sakId, sporId: sp.sporId, tekst: tekst.value.trim(), status: status };
        if (grunnlag.value.trim()) data.grunnlag = grunnlag.value.trim();
        await S.createArsak(data);
        toastOk('Årsaken er registrert');
      },
    });
  }

  function vurderArsak(model, sp, a) {
    var status = a.status;
    var grunnlag = textarea(a.grunnlag || '', { maxlength: '1500', rows: 3 });
    var body = h('div', { class: 'sak-form' }, [
      h('p', { class: 'sak-quote' }, a.tekst),
      h('div', { class: 'sak-field' }, [h('span', { class: 'sak-label' }, 'Vurdering'), statusRadios(status, function (s) { status = s; })]),
      field('Grunnlag', grunnlag, 'Påkrevd for «Støttet» og «Bekreftet». Du blir registrert som den som vurderte.', { optional: true }),
    ]);
    return openDialog({
      title: 'Vurder årsak', subtitle: 'Spor ' + sp.kode, submitLabel: 'Lagre vurdering', body: body, wide: true,
      onSubmit: async function () {
        var g = grunnlag.value.trim();
        if (status === a.status && g === (a.grunnlag || '')) throw new Error('Du har ikke endret noe.');
        if ((status === 'støttet' || status === 'bekreftet') && g.length < 3) throw new Error('«' + VM.ARSAK_STATUS_META[status].label + '» krever et grunnlag.');
        var data = { sakId: model.sak.sakId, arsakId: a.arsakId, status: status };
        if (g !== (a.grunnlag || '')) data.grunnlag = g;
        await S.updateArsak(data);
        toastOk('Vurderingen er lagret');
      },
    });
  }

  function fjernArsak(model, a) {
    var body = h('div', { class: 'sak-form' }, [
      h('p', { class: 'sak-quote' }, a.tekst),
      h('p', { class: 'sak-muted' }, 'Årsaken skjules fra årsaksbildet, men historikken beholdes. Den kan ikke angres her.'),
    ]);
    return openDialog({
      title: 'Fjerne årsak?', submitLabel: 'Fjern', submitVariant: 'danger', body: body,
      onSubmit: async function () {
        await S.updateArsak({ sakId: model.sak.sakId, arsakId: a.arsakId, fjern: true });
        toastOk('Årsaken er fjernet');
      },
    });
  }

  root.OpExSakForms = Object.freeze({
    openDialog: openDialog, nySak: nySak, endreSak: endreSak, endreStatus: endreStatus, kobleTiltak: kobleTiltak,
    endreSporForTiltak: endreSporForTiltak, frakobleTiltak: frakobleTiltak, nyArsak: nyArsak, vurderArsak: vurderArsak, fjernArsak: fjernArsak,
  });
}(typeof self !== 'undefined' ? self : this));
