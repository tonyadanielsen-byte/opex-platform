/*
 * kpi-charts.js — små, avhengighetsfrie SVG-grafer for KPI Renhold.
 *
 * Følger én fast stil: tynne merker (stolper ≤ 24 px, 4 px avrundet topp, 2 px linjer, punkter med ring),
 * hårfine rutenett, mållinje som tynn heltrukket linje, tekst i teksttokens (aldri i seriefargen),
 * forklaring for ≥ 2 serier og verdier ved hover (verktøytips over hele månedsbåndet).
 * Grafene tegnes når containeren har fått bredde (ResizeObserver), og tegnes på nytt ved endret størrelse.
 *
 * Ingen brukertekst via innerHTML: all tekst settes med textContent.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var MND_KORT = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  var MND_LANG = ['Januar', 'Februar', 'Mars', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Desember'];

  function s(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function erTall(v) { return typeof v === 'number' && isFinite(v); }

  /** «Pene» akseverdier: 0, 5, 10 … */
  function niceTicks(min, max, antall, heltall) {
    if (max === min) { max = min + 1; }
    var span = max - min, raw = span / Math.max(1, antall);
    if (heltall) raw = Math.max(raw, 1);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steg = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).filter(function (x) { return x >= raw; })[0] || 10 * mag;
    var lo = Math.floor(min / steg) * steg, hi = Math.ceil(max / steg) * steg;
    var t = [];
    for (var v = lo; v <= hi + steg / 2; v += steg) t.push(Math.round(v * 1e6) / 1e6);
    return t;
  }

  /** Tegner når elementet er i DOM og har bredde; tegner på nytt ved ny bredde. */
  function naarSynlig(wrap, tegn) {
    var sist = 0;
    function kjør() {
      var w = Math.floor(wrap.clientWidth);
      if (!w || w === sist) return;
      sist = w;
      tegn(w);
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(kjør).observe(wrap);
    requestAnimationFrame(kjør);
  }

  /* ------------------------------------------------------------------ sparkline */

  /**
   * Liten trend (12 måneder). opts: { verdier[12], valgt (1–12), type:'stolpe'|'linje', maal (tall|null), tone, hoyde, label }
   * Statisk (ingen hover) — sparklines i tabeller og fliser; verdien står alltid ved siden av.
   */
  function sparkline(opts) {
    var W = opts.bredde || 120, H = opts.hoyde || 32, P = 3;
    var v = opts.verdier;
    var alle = v.filter(erTall);
    if (erTall(opts.maal)) alle.push(opts.maal);
    var linje = opts.type === 'linje';
    var maks = alle.length ? Math.max.apply(null, alle) : 1, min = linje && alle.length ? Math.min.apply(null, alle) : 0;
    if (linje) { var pad = (maks - min) * 0.2 || Math.abs(maks) * 0.05 || 0.5; maks += pad; min -= pad; }
    if (maks <= min) maks = min + 1;
    var y = function (x) { return H - P - (x - min) / (maks - min) * (H - 2 * P); };
    var bw = (W - 2 * P) / 12;
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'kc-spark', role: 'img', 'aria-label': opts.label || 'Trend per måned', focusable: 'false' });
    if (erTall(opts.maal)) s('line', { x1: P, x2: W - P, y1: y(opts.maal), y2: y(opts.maal), class: 'kc-spark-maal' }, svg);
    if (!linje) {
      v.forEach(function (x, i) {
        if (!erTall(x)) return;
        var top = y(Math.max(x, 0)), h = Math.max(y(0) - top, 1.5);
        s('rect', { x: P + bw * i + bw * 0.2, y: y(0) - h, width: Math.max(bw * 0.6, 2), height: h, rx: 1.5, class: 'kc-spark-bar' + (i === opts.valgt - 1 ? ' is-valgt kc-tone-' + (opts.tone || 'accent') : '') }, svg);
      });
    } else {
      var pts = [];
      v.forEach(function (x, i) { if (erTall(x)) pts.push([P + bw * i + bw / 2, y(x), i]); });
      if (pts.length > 1) s('polyline', { points: pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '), class: 'kc-spark-line' }, svg);
      var sel = pts.filter(function (p) { return p[2] === opts.valgt - 1; })[0] || pts[pts.length - 1];
      if (sel) s('circle', { cx: sel[0], cy: sel[1], r: 3, class: 'kc-spark-dot kc-tone-' + (opts.tone || 'accent') }, svg);
    }
    return svg;
  }

  /* ------------------------------------------------------------------ statusring */

  /** Ring delt i statusandeler. deler: [{antall, tone}], senter: {tall, tekst} */
  function statusring(deler, senter, storrelse) {
    var S = storrelse || 132, R = S / 2 - 9, C = 2 * Math.PI * R;
    var total = deler.reduce(function (a, d) { return a + d.antall; }, 0) || 1;
    var svg = s('svg', { viewBox: '0 0 ' + S + ' ' + S, width: S, height: S, class: 'kc-ring', role: 'img', focusable: 'false', 'aria-hidden': 'true' });
    s('circle', { cx: S / 2, cy: S / 2, r: R, class: 'kc-ring-spor' }, svg);
    var start = 0, gap = deler.filter(function (d) { return d.antall; }).length > 1 ? 3 : 0;
    deler.forEach(function (d) {
      if (!d.antall) return;
      var len = d.antall / total * C;
      s('circle', {
        cx: S / 2, cy: S / 2, r: R, class: 'kc-ring-del kc-stroke-' + d.tone,
        'stroke-dasharray': Math.max(len - gap, 0.5) + ' ' + (C - Math.max(len - gap, 0.5)),
        'stroke-dashoffset': -start, transform: 'rotate(-90 ' + S / 2 + ' ' + S / 2 + ')',
      }, svg);
      start += len;
    });
    var wrap = el('div', 'kc-ring-wrap');
    wrap.appendChild(svg);
    var mid = el('div', 'kc-ring-senter');
    mid.appendChild(el('b', null, senter.tall));
    mid.appendChild(el('span', null, senter.tekst));
    wrap.appendChild(mid);
    return wrap;
  }

  /* ------------------------------------------------------------------ hovedgraf */

  /**
   * Månedsgraf med akser, mållinje, forklaring og verktøytips.
   * opts: {
   *   type: 'stolpe' | 'linje',
   *   serier: [{ navn, verdier[12], farge (1–8) }],
   *   fjor: { navn, verdier[12] } (valgfri, tegnes som dempet referanse — kun ved én serie),
   *   maal: [{ navn, verdi }] (valgfri, tynne linjer),
   *   valgt: måned 1–12 (uthevet), fmt: (tall) -> tekst, hoyde, tittel (for skjermleser)
   * }
   */
  function maanedsgraf(opts) {
    var wrap = el('div', 'kc-graf');
    var plot = el('div', 'kc-plot');
    var tip = el('div', 'kc-tip');
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    plot.appendChild(tip);
    wrap.appendChild(plot);

    var fmt = opts.fmt || function (x) { return String(x); };
    var serier = opts.serier;
    var visFjor = opts.fjor && serier.length === 1 && opts.fjor.verdier.some(erTall);

    if (serier.length > 1 || visFjor || (opts.maal && opts.maal.length)) {
      var leg = el('div', 'kc-legend');
      serier.forEach(function (sr) {
        var it = el('span', 'kc-leg');
        var sw = el('i', 'kc-sw kc-fill-' + sr.farge + (opts.type === 'linje' ? ' is-linje' : ''));
        it.appendChild(sw); it.appendChild(el('span', null, sr.navn)); leg.appendChild(it);
      });
      if (visFjor) { var f = el('span', 'kc-leg'); f.appendChild(el('i', 'kc-sw kc-sw-fjor' + (opts.type === 'linje' ? ' is-linje' : ''))); f.appendChild(el('span', null, opts.fjor.navn)); leg.appendChild(f); }
      (opts.maal || []).forEach(function (m) { var it = el('span', 'kc-leg'); it.appendChild(el('i', 'kc-sw kc-sw-maal')); it.appendChild(el('span', null, m.navn)); leg.appendChild(it); });
      wrap.appendChild(leg);
    }

    // Tabellvisning for skjermleser
    var tabell = el('table', 'sak-visually-hidden');
    var cap = el('caption', null, opts.tittel || 'Verdier per måned'); tabell.appendChild(cap);
    var thr = el('tr'); thr.appendChild(el('th', null, 'Måned'));
    serier.forEach(function (sr) { thr.appendChild(el('th', null, sr.navn)); });
    tabell.appendChild(thr);
    MND_LANG.forEach(function (m, i) {
      if (!serier.some(function (sr) { return erTall(sr.verdier[i]); })) return;
      var tr = el('tr'); tr.appendChild(el('th', null, m));
      serier.forEach(function (sr) { tr.appendChild(el('td', null, erTall(sr.verdier[i]) ? fmt(sr.verdier[i]) : '–')); });
      tabell.appendChild(tr);
    });
    wrap.appendChild(tabell);

    naarSynlig(plot, function (W) { tegn(W); });

    function tegn(W) {
      Array.prototype.slice.call(plot.querySelectorAll('svg')).forEach(function (x) { x.remove(); });
      var H = opts.hoyde || 200, L = 44, R = 8, T = 10, B = 24;
      var alle = [];
      serier.forEach(function (sr) { sr.verdier.forEach(function (x) { if (erTall(x)) alle.push(x); }); });
      if (visFjor) opts.fjor.verdier.forEach(function (x) { if (erTall(x)) alle.push(x); });
      (opts.maal || []).forEach(function (m) { if (erTall(m.verdi)) alle.push(m.verdi); });
      if (!alle.length) alle = [0, 1];
      var lo = Math.min.apply(null, alle), hi = Math.max.apply(null, alle);
      if (opts.type === 'stolpe') { lo = Math.min(0, lo); hi = hi + (hi - lo) * 0.08; }
      else { var pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 0.5; lo -= pad; hi += pad; }
      var ticks = niceTicks(lo, hi, 4, opts.heltall);
      lo = ticks[0]; hi = ticks[ticks.length - 1];
      var iw = W - L - R, ih = H - T - B;
      var y = function (v) { return T + ih - (v - lo) / (hi - lo) * ih; };
      var band = iw / 12;
      var cx = function (i) { return L + band * i + band / 2; };

      var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'kc-svg', 'aria-hidden': 'true', focusable: 'false' });
      ticks.forEach(function (t) {
        s('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 && lo < 0 ? 'kc-base' : 'kc-grid' }, svg);
        var tx = s('text', { x: L - 8, y: y(t) + 4, class: 'kc-tick', 'text-anchor': 'end' }, svg);
        tx.textContent = fmt(t, true);
      });
      MND_KORT.forEach(function (m, i) {
        var tx = s('text', { x: cx(i), y: H - 6, class: 'kc-tick' + (i === opts.valgt - 1 ? ' is-valgt' : ''), 'text-anchor': 'middle' }, svg);
        tx.textContent = W < 420 ? m.charAt(0).toUpperCase() : m;
      });
      s('line', { x1: L, x2: W - R, y1: y(Math.max(lo, 0)), y2: y(Math.max(lo, 0)), class: 'kc-base' }, svg);
      if (opts.valgt) s('rect', { x: L + band * (opts.valgt - 1), y: T, width: band, height: ih, class: 'kc-valgt-band' }, svg);

      var hoverBand = s('rect', { x: 0, y: T, width: band, height: ih, class: 'kc-hover-band', visibility: 'hidden' }, svg);
      var lag = s('g', null, svg);

      if (opts.type === 'stolpe') {
        var grupper = serier.length + (visFjor ? 1 : 0);
        var bredde = Math.min(24, (band * 0.72 - 2 * (grupper - 1)) / grupper);
        var total = bredde * grupper + 2 * (grupper - 1);
        var tegnStolpe = function (v, i, j, cls) {
          if (!erTall(v)) return;
          var x0 = cx(i) - total / 2 + j * (bredde + 2);
          var top = y(Math.max(v, 0)), bunn = y(Math.min(v, 0) < 0 ? v : 0);
          var base = y(Math.max(lo, 0));
          if (v >= 0) {
            var h = Math.max(base - top, v > 0 ? 2 : 0);
            if (h <= 0) { s('rect', { x: x0, y: base - 1, width: bredde, height: 1, class: cls + ' is-null' }, lag); return; }
            var r = Math.min(4, bredde / 2, h);
            s('path', { d: 'M' + x0 + ',' + base + 'V' + (base - h + r) + 'Q' + x0 + ',' + (base - h) + ' ' + (x0 + r) + ',' + (base - h) + 'H' + (x0 + bredde - r) + 'Q' + (x0 + bredde) + ',' + (base - h) + ' ' + (x0 + bredde) + ',' + (base - h + r) + 'V' + base + 'Z', class: cls }, lag);
          } else {
            s('rect', { x: x0, y: base, width: bredde, height: bunn - base, class: cls }, lag);
          }
        };
        for (var i = 0; i < 12; i++) {
          var j = 0;
          if (visFjor) tegnStolpe(opts.fjor.verdier[i], i, j++, 'kc-bar kc-bar-fjor');
          serier.forEach(function (sr) { tegnStolpe(sr.verdier[i], i, j++, 'kc-bar kc-fill-' + sr.farge + (opts.valgt && i > opts.valgt - 1 ? ' is-etter' : '')); });
        }
      } else {
        var linje = function (vals, cls) {
          var seg = [], segs = [];
          vals.forEach(function (v, i) { if (erTall(v)) seg.push([cx(i), y(v)]); else if (seg.length) { segs.push(seg); seg = []; } });
          if (seg.length) segs.push(seg);
          segs.forEach(function (sg) {
            if (sg.length > 1) s('polyline', { points: sg.map(function (p) { return p.join(','); }).join(' '), class: cls }, lag);
          });
        };
        if (visFjor) linje(opts.fjor.verdier, 'kc-line kc-line-fjor');
        serier.forEach(function (sr) {
          linje(sr.verdier, 'kc-line kc-stroke-' + sr.farge);
          sr.verdier.forEach(function (v, i) {
            if (!erTall(v)) return;
            var stor = i === opts.valgt - 1 || serier.length === 1;
            s('circle', { cx: cx(i), cy: y(v), r: stor ? 4 : 3, class: 'kc-dot kc-fill-' + sr.farge + (i === opts.valgt - 1 ? ' is-valgt' : '') }, lag);
          });
        });
      }
      (opts.maal || []).forEach(function (m) {
        if (!erTall(m.verdi)) return;
        s('line', { x1: L, x2: W - R, y1: y(m.verdi), y2: y(m.verdi), class: 'kc-maal' }, svg);
        if (opts.maal.length === 1) {
          var tx = s('text', { x: W - R, y: y(m.verdi) - 5, class: 'kc-maal-tekst', 'text-anchor': 'end' }, svg);
          tx.textContent = 'Mål ' + fmt(m.verdi);
        }
      });

      // Hover: hele månedsbåndet er treffflate
      var treff = s('rect', { x: L, y: T, width: iw, height: ih, class: 'kc-treff' }, svg);
      function vis(e) {
        var r = svg.getBoundingClientRect();
        var mx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        var i = Math.max(0, Math.min(11, Math.floor((mx - L) / band)));
        hoverBand.setAttribute('x', L + band * i);
        hoverBand.setAttribute('visibility', 'visible');
        tip.textContent = '';
        tip.appendChild(el('b', null, MND_LANG[i]));
        serier.forEach(function (sr) {
          var rad = el('div', 'kc-tip-rad');
          rad.appendChild(el('i', 'kc-sw kc-fill-' + sr.farge));
          rad.appendChild(el('span', null, sr.navn));
          rad.appendChild(el('b', null, erTall(sr.verdier[i]) ? fmt(sr.verdier[i]) : '–'));
          tip.appendChild(rad);
        });
        if (visFjor) {
          var fr = el('div', 'kc-tip-rad'); fr.appendChild(el('i', 'kc-sw kc-sw-fjor')); fr.appendChild(el('span', null, opts.fjor.navn));
          fr.appendChild(el('b', null, erTall(opts.fjor.verdier[i]) ? fmt(opts.fjor.verdier[i]) : '–')); tip.appendChild(fr);
        }
        (opts.maal || []).forEach(function (m) {
          var mr = el('div', 'kc-tip-rad'); mr.appendChild(el('i', 'kc-sw kc-sw-maal')); mr.appendChild(el('span', null, m.navn));
          mr.appendChild(el('b', null, erTall(m.verdi) ? fmt(m.verdi) : '–')); tip.appendChild(mr);
        });
        tip.hidden = false;
        var tw = tip.offsetWidth, x = cx(i) + 12;
        if (x + tw > W) x = cx(i) - tw - 12;
        tip.style.left = Math.max(0, x) + 'px';
        tip.style.top = T + 'px';
      }
      function skjul() { tip.hidden = true; hoverBand.setAttribute('visibility', 'hidden'); }
      treff.addEventListener('mousemove', vis);
      treff.addEventListener('touchstart', vis, { passive: true });
      treff.addEventListener('mouseleave', skjul);
      plot.insertBefore(svg, tip);
    }
    return wrap;
  }

  root.OpExKpiCharts = Object.freeze({ sparkline: sparkline, statusring: statusring, maanedsgraf: maanedsgraf, niceTicks: niceTicks });
}(typeof self !== 'undefined' ? self : this));
