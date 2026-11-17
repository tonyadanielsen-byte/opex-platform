/*
 * kpi-enheter.js — liste over KPI-appene (én per avdeling). Brukes av OpEx Hub (knapper øverst),
 * KPI-appen (navn, område for tiltak) og serveren (gyldige avdelinger, standard registratorer, lenker i varsler).
 *
 * Ny avdeling (f.eks. Ferdigmat): sett aktiv: true, og lag kpi/<id>/index.html (kopi av kpi/renhold/index.html med ny id).
 * Data ligger i /kpi/<id>/… i databasen. functions/kpi-enheter.js må være en eksakt kopi av denne filen (test sjekker det).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpExKpiEnheter = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TONY = 'TJKI3zlDKSR7jvFXksVFgEgjS432';
  var KENNETH = 'gibm3aDi1KWlNyl7P3jTktQoGsM2';

  var ENHETER = {
    renhold: {
      id: 'renhold', navn: 'KPI Renhold', avdeling: 'Renhold', tiltakOmrade: 'Renhold', sti: 'kpi/renhold/',
      aktiv: true, registratorer: [TONY, KENNETH],
    },
    ferdigmat: {
      id: 'ferdigmat', navn: 'KPI Ferdigmat', avdeling: 'Ferdigmat', tiltakOmrade: 'Ferdigmat', sti: 'kpi/ferdigmat/',
      aktiv: false, registratorer: [TONY],
    },
  };

  function hent(id) { return Object.prototype.hasOwnProperty.call(ENHETER, id) ? ENHETER[id] : null; }
  function aktive() { return Object.keys(ENHETER).map(function (k) { return ENHETER[k]; }).filter(function (e) { return e.aktiv; }); }
  function alle() { return Object.keys(ENHETER).map(function (k) { return ENHETER[k]; }); }

  return Object.freeze({ ENHETER: ENHETER, hent: hent, aktive: aktive, alle: alle });
}));
