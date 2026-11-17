'use strict';

/*
 * KPI Renhold: callable-binding. All logikk ligger i renhold-kpi-core.js (testet mot simulert database).
 * Brukeridentitet hentes fra request.auth.uid (aldri fra klientens data). /renholdKpi leses/skrives kun her.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const core = require('./renhold-kpi-core');

if (!getApps().length) initializeApp();

const OPTIONS = { region: 'europe-west1', memory: '256MiB', timeoutSeconds: 30, maxInstances: 2 };

function makeDeps() {
  return {
    get db() { return getDatabase(); },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newKey: (path) => getDatabase().ref(path).push().key,
    log: console,
  };
}

function callable(name, operation) {
  return onCall(OPTIONS, async (request) => {
    try {
      return await operation(makeDeps(), request.auth && request.auth.uid, request.data);
    } catch (error) {
      if (error instanceof core.KpiError) throw new HttpsError(error.code, error.message);
      console.error(`${name} feilet`, { uid: request.auth && request.auth.uid, error: String((error && error.message) || error) });
      throw new HttpsError('internal', 'Uventet feil. Prøv igjen.');
    }
  });
}

exports.getRenholdKpiV1 = callable('getRenholdKpiV1', core.getRenholdKpi);
exports.saveRenholdKpiMaanedV1 = callable('saveRenholdKpiMaanedV1', core.saveRenholdKpiMaaned);
exports.saveRenholdKpiConfigV1 = callable('saveRenholdKpiConfigV1', core.saveRenholdKpiConfig);
exports.importRenholdKpiV1 = callable('importRenholdKpiV1', core.importRenholdKpi);
exports.createRenholdKpiTiltakV1 = callable('createRenholdKpiTiltakV1', core.createRenholdKpiTiltak);
