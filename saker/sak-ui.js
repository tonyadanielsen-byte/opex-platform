/*
 * sak-ui.js — felles UI-hjelpere for Saker: sikker DOM-bygging, linjeikoner, norsk formatering.
 *
 * Sikkerhet: brukertekst (tittel, problemstilling, årsaker, grunnlag ...) settes ALDRI via innerHTML. `h()` lager tekstnoder.
 * innerHTML brukes kun for de faste, innebygde ikon-SVG-ene under (konstanter, ingen brukerdata).
 */
(function (root) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* Linjeikoner (24×24, strek). Faste konstanter. */
  var ICONS = {
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    'badge-check': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7M12 17h.01"/>',
    alert: '<path d="M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    message: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  };

  function icon(name, size) {
    var span = document.createElement('span');
    span.className = 'sak-ico';
    span.setAttribute('aria-hidden', 'true');
    var px = size || 18;
    span.innerHTML = '<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + (ICONS[name] || ICONS.circle) + '</svg>';
    return span;
  }

  /** Lager et element. props: class, on:{evt:fn}, data:{k:v}, attrs:{...}, øvrige nøkler settes som attributt/egenskap. children: tekst/noder/lister. */
  function h(tag, props, children) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'data') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === undefined || children === null || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(el, c); }); return; }
    if (typeof children === 'string' || typeof children === 'number') { el.appendChild(document.createTextNode(String(children))); return; }
    el.appendChild(children);
  }

  var uid = 0;
  function nextId(prefix) { uid += 1; return (prefix || 'sak') + '-' + uid; }

  /* --------------------------------------------------------------- formatering (nb-NO, Europe/Oslo) */

  var datoFormat = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  var datoAarFormat = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  var tidFormat = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });

  /** 'ÅÅÅÅ-MM-DD' → «9. okt.» (med år hvis det ikke er samme år som `idag`). */
  function fmtDato(dato, idag) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dato || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var samme = idag && String(idag).slice(0, 4) === m[1];
    return (samme ? datoFormat : datoAarFormat).format(d);
  }

  function fmtTid(iso) {
    var ms = Date.parse(iso);
    return isNaN(ms) ? '' : tidFormat.format(new Date(ms));
  }

  function initialer(navn) {
    var deler = String(navn || '').trim().split(/\s+/).filter(Boolean);
    if (!deler.length) return '?';
    return (deler[0][0] + (deler.length > 1 ? deler[deler.length - 1][0] : '')).toUpperCase();
  }

  /* --------------------------------------------------------------- små byggeklosser */

  function chip(meta, label, extra) {
    return h('span', { class: 'sak-chip sak-tone-' + meta.tone + (extra ? ' ' + extra : '') }, [icon(meta.icon, 14), h('span', null, label || meta.label)]);
  }

  function avatar(navn) { return h('span', { class: 'sak-avatar', 'aria-hidden': 'true' }, initialer(navn)); }

  function button(label, opts) {
    var o = opts || {};
    var kids = [];
    if (o.icon) kids.push(icon(o.icon, o.iconSize || 16));
    if (label) kids.push(h('span', { class: 'sak-btn-label' }, label));
    return h('button', {
      type: o.type || 'button',
      class: 'sak-btn' + (o.variant ? ' sak-btn-' + o.variant : '') + (o.small ? ' sak-btn-sm' : '') + (o.class ? ' ' + o.class : ''),
      title: o.title, 'aria-label': o.ariaLabel, disabled: o.disabled, on: o.on, data: o.data,
    }, kids);
  }

  root.OpExSakUi = Object.freeze({
    icon: icon, h: h, append: append, nextId: nextId, fmtDato: fmtDato, fmtTid: fmtTid, initialer: initialer,
    chip: chip, avatar: avatar, button: button, ICONS: Object.keys(ICONS),
  });
}(typeof self !== 'undefined' ? self : this));
