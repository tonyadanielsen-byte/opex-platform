'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'opex-rules-local-test';
let env;
const leader = 'leader-a', colleague = 'leader-b', outsider = 'outsider';

describe('RTDB access against real Firebase Emulator', () => {
  before(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      database: { host: '127.0.0.1', port: 9000, rules: require('node:fs').readFileSync('database.rules.json', 'utf8') },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.database().ref('authorizedUsers').set({ [leader]: true, [colleague]: true });
    });
  });
  after(async () => { if (env) await env.cleanup(); });

  it('rejects all unauthenticated and unapproved database reads/writes', async () => {
    const anonymous = env.unauthenticatedContext().database();
    const unauthorized = env.authenticatedContext(outsider).database();
    for (const db of [anonymous, unauthorized]) {
      await assertFails(db.ref('tiltak').get());
      await assertFails(db.ref('tiltak/example').set({ tittel: 'Not allowed' }));
      await assertFails(db.ref('lor').get());
      await assertFails(db.ref('lor/example').set({ x: true }));
    }
  });
  it('lets both approved leaders collaborate on measures and LOR', async () => {
    const a = env.authenticatedContext(leader).database();
    const b = env.authenticatedContext(colleague).database();
    await assertSucceeds(a.ref('tiltak/example').set({ tittel: 'Test' }));
    await assertSucceeds(b.ref('tiltak/example/tittel').set('Updated by other leader'));
    await assertSucceeds(a.ref('tiltak/example').get());
    await assertSucceeds(b.ref('tiltak/example').get());
    await assertSucceeds(a.ref('lor/example').set({ status: 'planlagt' }));
    await assertSucceeds(b.ref('lor/example/status').set('gjennomfort'));
  });
  it('blocks direct client writes to case, events, counters and user permissions', async () => {
    const db = env.authenticatedContext(leader).database();
    for (const key of ['saker/new', 'sakEvents/new/event', 'sakSpor/new/track', 'sakAdmins/new', 'counters/sak', 'authorizedUsers/outsider']) {
      await assertFails(db.ref(key).set(true));
    }
    await assertFails(db.ref('saker').get());
  });
  it('restricts device push tokens to the owner', async () => {
    const a = env.authenticatedContext(leader).database();
    const b = env.authenticatedContext(colleague).database();
    await assertSucceeds(a.ref('pushTokens/' + leader + '/device').set({ token: 'test' }));
    await assertSucceeds(a.ref('pushTokens/' + leader).get());
    await assertFails(b.ref('pushTokens/' + leader).get());
    await assertFails(b.ref('pushTokens/' + leader + '/device').set({ token: 'stolen' }));
  });
});
