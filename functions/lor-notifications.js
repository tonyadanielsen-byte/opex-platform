'use strict';

const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const PLAN_2026 = require('./lor-plan-2026');

if (!getApps().length) initializeApp();

const LOR_URL = 'https://tonyadanielsen-byte.github.io/lor-platform/';
const KNOWN_UIDS = Object.freeze({
  tony:'TJKI3zlDKSR7jvFXksVFgEgjS432',
  kenneth:'gibm3aDi1KWlNyl7P3jTktQoGsM2',
  erling:'lJ7bn7HkbcZnhDoxfaBYQKEFL083',
});

const clean = value => String(value ?? '').trim();
const first = value => clean(value).toLowerCase().split(/\s+/)[0] || '';
const changed = (a,b,key) => clean(a?.[key]) !== clean(b?.[key]);
const actorUid = event => clean(event?.authId || event?.auth?.uid) || null;

function collectTokens(root, uid) {
  const devices = root?.[uid];
  if (!devices || typeof devices !== 'object') return [];
  return [...new Set(Object.values(devices).map(device => clean(device?.token)).filter(Boolean))].slice(0,500);
}

async function loadUsers() {
  const snap = await getDatabase().ref('/lor/users').get();
  return snap.val() || {};
}

function uidForName(name, users = {}) {
  const key = first(name);
  if (!key) return null;
  if (KNOWN_UIDS[key]) return KNOWN_UIDS[key];
  for (const [uid, profile] of Object.entries(users)) {
    const profileName = clean(profile?.name);
    if (profileName && (profileName.toLowerCase() === clean(name).toLowerCase() || first(profileName) === key)) return uid;
  }
  return null;
}

function recipientUids(plan, users) {
  const names = [plan?.leaderName || plan?.ownerName, plan?.coLeaderName].filter(Boolean);
  return [...new Set(names.map(name => uidForName(name, users)).filter(Boolean))];
}

async function recordInbox(uid, message) {
  const ref = getDatabase().ref(`/lor/notificationInbox/${uid}`).push();
  await ref.set({
    title:clean(message.title) || 'OpEx · LOR',
    body:clean(message.body) || 'Du har et nytt LOR-varsel.',
    link:clean(message.link) || LOR_URL,
    eventType:clean(message.eventType) || 'lor-event',
    planId:clean(message.planId),
    week:Number(message.week) || null,
    createdAt:Date.now(),
    seenAt:null,
  });
}

async function sendToUid(uid, message, excludeUid = null) {
  if (!uid || (excludeUid && uid === excludeUid)) return { skipped: excludeUid === uid ? 'self-action' : 'no-uid' };
  await recordInbox(uid, message);

  const tokenSnap = await getDatabase().ref('/lor/pushTokens').get();
  const tokens = collectTokens(tokenSnap.val(), uid);
  if (!tokens.length) return { skipped:'no-token', uid };

  const title = clean(message.title) || 'OpEx · LOR';
  const body = clean(message.body) || 'Du har et nytt LOR-varsel.';
  const link = clean(message.link) || LOR_URL;
  const tag = clean(message.tag) || 'lor-notification';
  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification:{ title, body },
    data:{
      title, body, link, tag,
      eventType:clean(message.eventType) || 'lor-event',
      planId:clean(message.planId),
      week:String(Number(message.week) || ''),
    },
    webpush:{
      headers:{ Urgency:message.urgency || 'high', TTL:String(message.ttl || 86400) },
      notification:{
        title, body,
        icon:`${LOR_URL}icons/lor-icon-192.png?v=3.7.6`,
        badge:`${LOR_URL}icons/lor-icon-192.png?v=3.7.6`,
        tag,
        renotify:false,
        data:{ link, planId:clean(message.planId), eventType:clean(message.eventType) },
      },
      fcmOptions:{ link },
    },
  });

  const invalid = [];
  response.responses.forEach((result,index) => {
    const code = result?.error?.code || '';
    if (!result.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) invalid.push(tokens[index]);
  });
  if (invalid.length) {
    const devicesSnap = await getDatabase().ref(`/lor/pushTokens/${uid}`).get();
    const updates = {};
    devicesSnap.forEach(child => { if (invalid.includes(clean(child.val()?.token))) updates[child.key] = null; });
    if (Object.keys(updates).length) await getDatabase().ref(`/lor/pushTokens/${uid}`).update(updates);
  }
  return response;
}

function seedById(id) { return PLAN_2026.find(plan => plan.id === id || plan.sourceSeedId === id) || null; }

function effectiveBefore(before, after) {
  if (before && Object.keys(before).length) return before;
  const source = clean(after?.sourceSeedId);
  return source ? seedById(source) || {} : {};
}

function planBody(plan) {
  const bits = [`Uke ${Number(plan?.week) || '?'}`, clean(plan?.theme || plan?.themeName), clean(plan?.department)].filter(Boolean);
  return bits.join(' · ');
}

exports.notifyLorPlanChangeV1 = onValueWritten({
  ref:'/lor/plans/{planId}',
  instance:'opex-nortura-default-rtdb',
  region:'europe-west1',
  memory:'256MiB',
  timeoutSeconds:60,
  maxInstances:2,
}, async event => {
  if (!event.data.after.exists()) return;
  const after = event.data.after.val() || {};
  const beforeRaw = event.data.before.exists() ? event.data.before.val() || {} : {};
  const before = effectiveBefore(beforeRaw, after);
  const planId = event.params.planId;
  const actor = actorUid(event);
  const users = await loadUsers();
  const oldLeaderUid = uidForName(before.leaderName || before.ownerName, users);
  const newLeaderUid = uidForName(after.leaderName || after.ownerName, users);
  const oldCoUid = uidForName(before.coLeaderName, users);
  const newCoUid = uidForName(after.coLeaderName, users);
  const body = planBody(after);

  if (oldLeaderUid !== newLeaderUid) {
    if (newLeaderUid) await sendToUid(newLeaderUid, {
      title:'LOR-runde tildelt deg', body, eventType:'lor-assigned', planId, week:after.week,
      tag:`lor-assigned-${planId}-${Date.now()}`,
    }, actor);
    if (oldLeaderUid) await sendToUid(oldLeaderUid, {
      title:'LOR-runde er flyttet fra deg', body, eventType:'lor-reassigned-away', planId, week:after.week,
      tag:`lor-away-${planId}-${Date.now()}`,
    }, actor);
  }

  if (oldCoUid !== newCoUid && newCoUid) {
    await sendToUid(newCoUid, {
      title:'Du er invitert med på en LOR-runde', body, eventType:'lor-coleader-added', planId, week:after.week,
      tag:`lor-coleader-${planId}-${Date.now()}`,
    }, actor);
  }

  const scheduleChanged = ['week','plannedDate','theme','themeName','department'].some(key => changed(before,after,key));
  if (scheduleChanged && oldLeaderUid === newLeaderUid) {
    for (const uid of recipientUids(after, users)) {
      await sendToUid(uid, {
        title:'LOR-planen er oppdatert', body, eventType:'lor-plan-updated', planId, week:after.week,
        tag:`lor-plan-${planId}-${Date.now()}`,
      }, actor);
    }
  }
});

function osloIsoWeek(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).reduce((acc,p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; },{});
  const d = new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate()+4-day);
  const year = d.getUTCFullYear();
  const firstDay = new Date(Date.UTC(year,0,1));
  const week = Math.ceil((((d-firstDay)/86400000)+1)/7);
  return { year, week };
}

async function loadEffectivePlans(year) {
  const seeds = Number(year) === 2026 ? PLAN_2026.map(plan => ({...plan})) : [];
  const liveSnap = await getDatabase().ref('/lor/plans').get();
  const live = [];
  liveSnap.forEach(child => {
    const value = child.val() || {};
    if (Number(value.year || 2026) !== Number(year)) return;
    live.push({ id:child.key, ...value, year:Number(value.year || year), week:Number(value.week), theme:value.theme || value.themeName || '' });
  });
  const overrides = new Map(live.filter(plan => plan.sourceSeedId).map(plan => [plan.sourceSeedId,plan]));
  const rows = seeds.map(seed => overrides.has(seed.id) ? {...seed,...overrides.get(seed.id)} : seed);
  live.filter(plan => !plan.sourceSeedId || !seeds.some(seed => seed.id === plan.sourceSeedId)).forEach(plan => rows.push(plan));
  return rows.filter(plan => !plan.archived && plan.theme && Number.isFinite(Number(plan.week)));
}

function sameFirst(a,b) { return first(a) && first(a) === first(b); }

function completed(plan, rounds) {
  return rounds.some(round =>
    round.planId === plan.id ||
    (plan.sourceSeedId && round.planId === plan.sourceSeedId) ||
    (Number(round.planWeek) === Number(plan.week) &&
      (!plan.theme || clean(round.theme) === clean(plan.theme)) &&
      (!plan.leaderName || sameFirst(round.leaderName,plan.leaderName)))
  );
}

async function loadRounds() {
  const snap = await getDatabase().ref('/lor/rounds').get();
  const rounds = [];
  snap.forEach(child => rounds.push({ id:child.key, ...(child.val() || {}) }));
  return rounds;
}

async function sendLogged(uid, logKey, message) {
  const ref = getDatabase().ref(`/lor/notificationLog/${logKey}/${uid}`);
  if ((await ref.get()).exists()) return;
  await sendToUid(uid,message);
  await ref.set({ sentAt:Date.now(), eventType:message.eventType || '' });
}

async function notifyPlansForWeek(year, week, kind) {
  const [plans,rounds,users] = await Promise.all([loadEffectivePlans(year),loadRounds(),loadUsers()]);
  const relevant = plans.filter(plan => Number(plan.week) === Number(week) && !completed(plan,rounds));
  for (const plan of relevant) {
    const recipients = recipientUids(plan,users);
    if (!recipients.length) continue;
    const body = `${planBody(plan)} · ansvarlig ${clean(plan.leaderName || plan.ownerName) || 'ikke fordelt'}`;
    for (const uid of recipients) {
      const config = kind === 'friday' ? {
        title:'⏰ LOR gjenstår denne uken', eventType:'lor-week-reminder', tag:`lor-friday-${year}-${week}-${plan.id}`,
      } : kind === 'overdue' ? {
        title:'⚠️ LOR-runden ble ikke gjennomført', eventType:'lor-overdue', tag:`lor-overdue-${year}-${week}-${plan.id}`,
      } : {
        title:'LOR denne uken', eventType:'lor-week-start', tag:`lor-week-${year}-${week}-${plan.id}`,
      };
      await sendLogged(uid,`${config.eventType}-${year}-W${week}-${plan.id}`,{
        ...config, body, planId:plan.id, week, ttl:86400,
      });
    }
  }
}

exports.notifyLorWeekStartV1 = onSchedule({
  schedule:'0 7 * * 1',
  timeZone:'Europe/Oslo',
  region:'europe-west1',
  memory:'256MiB',
  timeoutSeconds:120,
  maxInstances:1,
  retryCount:1,
}, async () => {
  const current = osloIsoWeek();
  await notifyPlansForWeek(current.year,current.week,'start');
  const previousDate = new Date(Date.now()-7*86400000);
  const previous = osloIsoWeek(previousDate);
  await notifyPlansForWeek(previous.year,previous.week,'overdue');
});

exports.notifyLorFridayReminderV1 = onSchedule({
  schedule:'0 10 * * 5',
  timeZone:'Europe/Oslo',
  region:'europe-west1',
  memory:'256MiB',
  timeoutSeconds:120,
  maxInstances:1,
  retryCount:1,
}, async () => {
  const current = osloIsoWeek();
  await notifyPlansForWeek(current.year,current.week,'friday');
});
