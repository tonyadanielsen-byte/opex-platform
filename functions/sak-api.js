'use strict';

/*
 * Saker MVP-0 fase 1c: callable-binding. All logikk ligger i sak-core.js (testet mot simulert database).
 *
 * Tilgang (pilot): innlogget bruker i /authorizedUsers/{uid} === true. Ingen hardkodede uid-er.
 * Brukeridentitet hentes fra request.auth.uid (aldri fra klientens data).
 * Ingen regelendring: alle sak-noder leses/skrives kun her (admin SDK).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const core = require('./sak-core');

if (!getApps().length) initializeApp();

const OPTIONS = { region: 'europe-west1', memory: '256MiB', timeoutSeconds: 30, maxInstances: 2 };

function makeDeps() {
  return {
    // Lat: databasen berøres først når en operasjon trenger den, så uinnloggede forespørsler avvises uten databasetilgang.
    get db() { return getDatabase(); },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console,
  };
}

function callable(name, operation) {
  return onCall(OPTIONS, async (request) => {
    try {
      return await operation(makeDeps(), request.auth && request.auth.uid, request.data);
    } catch (error) {
      if (error instanceof core.SakError) throw new HttpsError(error.code, error.message);
      // Aldri logg forespørselsdata (kan inneholde fritekst); bare hvem og hva som feilet.
      console.error(`${name} feilet`, { uid: request.auth && request.auth.uid, error: String((error && error.message) || error) });
      throw new HttpsError('internal', 'Uventet feil. Prøv igjen.');
    }
  });
}

exports.createSakV1 = callable('createSakV1', core.createSak);
exports.getSakerV1 = callable('getSakerV1', core.getSaker);
exports.getSakV1 = callable('getSakV1', core.getSak);
exports.updateSakV1 = callable('updateSakV1', core.updateSak);
exports.setTiltakSakV1 = callable('setTiltakSakV1', core.setTiltakSak);
exports.removeTiltakSakV1 = callable('removeTiltakSakV1', core.removeTiltakSak);
exports.createArsakV1 = callable('createArsakV1', core.createArsak);
exports.updateArsakV1 = callable('updateArsakV1', core.updateArsak);
