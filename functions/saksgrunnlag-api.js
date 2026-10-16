'use strict';
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {getApps, initializeApp} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {buildSaksgrunnlag,validId} = require('./saksgrunnlag-core');
if (!getApps().length) initializeApp();
const OPTIONS={region:'europe-west1',memory:'256MiB',timeoutSeconds:60,maxInstances:2};
const TYPES=new Set(['observasjon','undersokelse','beslutning','dokumentasjon','effektmaling']);
async function auth(request) {
  const uid=request.auth && request.auth.uid;
  if (!uid || (await getDatabase().ref('/authorizedUsers/'+uid).get()).val()!==true)
    throw new HttpsError('permission-denied','Ikke godkjent bruker.');
  return uid;
}
async function activeSak(db,sakId,writable=false) {
  if (!validId(sakId)) throw new HttpsError('invalid-argument','Ugyldig sak.');
  const s=(await db.ref('/saker/'+sakId).get()).val();
  if (!s || s.deletedAt || s.slettetAt || s.slettet===true)
    throw new HttpsError('not-found','Saken finnes ikke.');
  if (writable && s.status === 'Lukket') throw new HttpsError('failed-precondition','Saken er lukket. Åpne den på nytt (endre status) før du endrer innholdet.');
}
exports.getSaksgrunnlagV1=onCall(OPTIONS,async request=>{
  await auth(request);
  const keys=Object.keys(request.data||{});
  if(keys.some(k=>k!=='sakId')) throw new HttpsError('invalid-argument','Ukjent felt.');
  const db=getDatabase();
  await activeSak(db,request.data?.sakId);
  // Raw source bundle is limited to approved authenticated leaders, never sent to an external model.
  return await buildSaksgrunnlag(db,request.data.sakId);
});
exports.getSakJournalV1=onCall(OPTIONS,async request=>{
  await auth(request);
  const {sakId}=request.data||{};
  const db=getDatabase();await activeSak(db,sakId);
  const raw=(await db.ref('/sakJournal/'+sakId).get()).val()||{};
  return {poster:Object.entries(raw).map(([id,v])=>({id,...v})).sort((a,b)=>(a.opprettetAt||'').localeCompare(b.opprettetAt||''))};
});
exports.createSakJournalEntryV1=onCall(OPTIONS,async request=>{
  const uid=await auth(request);
  const data=request.data||{};
  if(Object.keys(data).some(k=>!['sakId','type','tekst','gjelderDato'].includes(k)))
    throw new HttpsError('invalid-argument','Ukjent felt.');
  const {sakId,type,tekst,gjelderDato}=data;
  const db=getDatabase();await activeSak(db,sakId,true);
  if(!TYPES.has(type))throw new HttpsError('invalid-argument','Ugyldig type.');
  if(typeof tekst!=='string'||!tekst.trim()||tekst.trim().length>3000)
    throw new HttpsError('invalid-argument','Tekst må være mellom 1 og 3000 tegn.');
  if(gjelderDato!==undefined && (typeof gjelderDato!=='string'|| !/^\d{4}-\d{2}-\d{2}$/.test(gjelderDato)||Number.isNaN(Date.parse(gjelderDato+'T12:00:00Z'))))
    throw new HttpsError('invalid-argument','Ugyldig dato.');
  const id=db.ref('/sakJournal/'+sakId).push().key, now=new Date().toISOString();
  const post={type,tekst:tekst.trim(),opprettetAv:uid,opprettetAt:now,fjernet:false};
  if(gjelderDato)post.gjelderDato=gjelderDato;
  const eventId=db.ref('/sakEvents/'+sakId).push().key;
  await db.ref().update({
    ['/sakJournal/'+sakId+'/'+id]:post,
    ['/sakEvents/'+sakId+'/'+eventId]:{type:'journal_opprettet',entityId:id,actorUid:uid,createdAt:now}
  });
  return {id,post};
});

exports.reviseSakJournalEntryV1=onCall(OPTIONS,async request=>{
  const uid=await auth(request), data=request.data||{};
  if(Object.keys(data).some(k=>!['sakId','entryId','tekst','begrunnelse'].includes(k)))
    throw new HttpsError('invalid-argument','Ukjent felt.');
  const {sakId,entryId,tekst,begrunnelse}=data, db=getDatabase();
  await activeSak(db,sakId,true);
  if(!validId(entryId))throw new HttpsError('invalid-argument','Ugyldig journalpost.');
  if(typeof tekst!=='string'||!tekst.trim()||tekst.trim().length>3000)
    throw new HttpsError('invalid-argument','Korrigert tekst må være mellom 1 og 3000 tegn.');
  if(typeof begrunnelse!=='string'||!begrunnelse.trim()||begrunnelse.trim().length>500)
    throw new HttpsError('invalid-argument','Oppgi en kort begrunnelse for korrigeringen (maks 500 tegn).');
  const journalRef=db.ref('/sakJournal/'+sakId);
  const old=(await journalRef.child(entryId).get()).val();
  if(!old)throw new HttpsError('not-found','Journalposten finnes ikke.');
  if(old.fjernet||old.erstattetAv)throw new HttpsError('failed-precondition','Journalposten er allerede erstattet.');
  const now=new Date().toISOString(), newId=journalRef.push().key;
  const revised={type:old.type,tekst:tekst.trim(),opprettetAv:uid,opprettetAt:now,fjernet:false,erstatter:entryId,begrunnelse:begrunnelse.trim()};
  if(old.gjelderDato)revised.gjelderDato=old.gjelderDato;

  // Old and new journal versions must commit together: never leave a dangling replacement.
  // RTDB calls the updater once with a cold local cache (often null). Returning null
  // permits the SDK to fetch server state and retry instead of aborting with undefined.
  const tx=await journalRef.transaction(current=>{
    if(current===null)return null;
    if(typeof current!=='object'||Array.isArray(current))return;
    const original=current[entryId];
    if(!original||original.fjernet||original.erstattetAv||current[newId])return;
    return {
      ...current,
      [entryId]:{...original,fjernet:true,erstattetAv:newId,korrigertAt:now,korrigertAv:uid},
      [newId]:revised
    };
  },undefined,false);
  const committed=tx.snapshot?.val();
  if(!tx.committed||!committed?.[newId]||committed?.[entryId]?.erstattetAv!==newId)
    throw new HttpsError('aborted','Journalposten ble korrigert av noen andre. Oppdater og prøv igjen.');

  // The journal is already consistent if event recording fails. The deterministic
  // event key enables a safe retry without adding duplicate history events.
  const eventId='journal_korrigert_'+newId;
  try{
    await db.ref('/sakEvents/'+sakId+'/'+eventId).set({
      type:'journal_korrigert',entityId:newId,actorUid:uid,createdAt:now,erstatter:entryId
    });
  }catch(error){
    // Never roll back a committed journal revision to compensate for an event failure.
    throw new HttpsError('internal','Korrigeringen er lagret, men aktivitetsloggen kunne ikke oppdateres. Kontakt ansvarlig før du prøver igjen.');
  }
  return {id:newId,erstatter:entryId,post:revised};
});
