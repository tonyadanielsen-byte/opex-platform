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
async function activeSak(db,sakId) {
  if (!validId(sakId)) throw new HttpsError('invalid-argument','Ugyldig sak.');
  const s=(await db.ref('/saker/'+sakId).get()).val();
  if (!s || s.deletedAt || s.slettetAt || s.slettet===true)
    throw new HttpsError('not-found','Saken finnes ikke.');
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
  const db=getDatabase();await activeSak(db,sakId);
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
  await activeSak(db,sakId);
  if(!validId(entryId))throw new HttpsError('invalid-argument','Ugyldig journalpost.');
  if(typeof tekst!=='string'||!tekst.trim()||tekst.trim().length>3000)
    throw new HttpsError('invalid-argument','Korrigert tekst må være mellom 1 og 3000 tegn.');
  if(typeof begrunnelse!=='string'||!begrunnelse.trim()||begrunnelse.trim().length>500)
    throw new HttpsError('invalid-argument','Oppgi en kort begrunnelse for korrigeringen (maks 500 tegn).');
  const oldRef=db.ref('/sakJournal/'+sakId+'/'+entryId);
  const old=(await oldRef.get()).val();
  if(!old)throw new HttpsError('not-found','Journalposten finnes ikke.');
  if(old.fjernet||old.erstattetAv)throw new HttpsError('failed-precondition','Journalposten er allerede erstattet.');
  const now=new Date().toISOString(), newRef=db.ref('/sakJournal/'+sakId).push(), eventId=db.ref('/sakEvents/'+sakId).push().key;
  const revised={type:old.type,tekst:tekst.trim(),opprettetAv:uid,opprettetAt:now,fjernet:false,erstatter:entryId,begrunnelse:begrunnelse.trim()};
  if(old.gjelderDato)revised.gjelderDato=old.gjelderDato;
  // Transactional claim on old post prevents two parallel revisions from branching.
  const claimed=await oldRef.transaction(current=>{
    if(!current||current.fjernet||current.erstattetAv)return;
    return {...current,fjernet:true,erstattetAv:newRef.key,korrigertAt:now,korrigertAv:uid};
  },undefined,false);
  if(!claimed.committed)throw new HttpsError('aborted','Journalposten ble korrigert av noen andre. Oppdater og prøv igjen.');
  try{
    await db.ref().update({
      ['/sakJournal/'+sakId+'/'+newRef.key]:revised,
      ['/sakEvents/'+sakId+'/'+eventId]:{type:'journal_korrigert',entityId:newRef.key,actorUid:uid,createdAt:now,erstatter:entryId}
    });
  }catch(error){
    // Never overwrite concurrent work: only roll back our own claim.
    await oldRef.transaction(current=>current&&current.erstattetAv===newRef.key?{
      ...current,fjernet:false,erstattetAv:null,korrigertAt:null,korrigertAv:null
    }:undefined,undefined,false);
    throw new HttpsError('internal','Korrigeringen kunne ikke lagres. Prøv igjen.');
  }
  return {id:newRef.key,erstatter:entryId,post:revised};
});
