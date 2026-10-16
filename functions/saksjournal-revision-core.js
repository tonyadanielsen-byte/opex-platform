'use strict';
// Journal revision write path, testable with an injected database.
class RevisionError extends Error { constructor(code,message){super(message);this.code=code;} }
const {eventKey}=require('./events-core');
async function reviseJournal({db,sakId,entryId,uid,tekst,begrunnelse,now=new Date().toISOString()}) {
  const journalRef=db.ref('/sakJournal/'+sakId);
  const old=(await journalRef.child(entryId).get()).val();
  if(!old)throw new RevisionError('not-found','Journalposten finnes ikke.');
  if(old.fjernet||old.erstattetAv)throw new RevisionError('failed-precondition','Journalposten er allerede erstattet.');
  const newId=journalRef.push().key;
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
    throw new RevisionError('aborted','Journalposten ble korrigert av noen andre. Oppdater og prøv igjen.');

  // The journal is already consistent if event recording fails. The deterministic
  // event key keeps chronological ordering alongside other case events.
  const eventId=eventKey(Date.parse(now),newId,'journal-korrigert');
  try{
    await db.ref('/sakEvents/'+sakId+'/'+eventId).set({
      type:'journal_korrigert',entityId:newId,actorUid:uid,createdAt:now,erstatter:entryId
    });
  }catch(error){
    // Never roll back a committed journal revision to compensate for an event failure.
    throw new RevisionError('internal','Korrigeringen er lagret, men aktivitetsloggen kunne ikke oppdateres. Kontakt ansvarlig før du prøver igjen.');
  }
  return {id:newId,erstatter:entryId,post:revised};
}
module.exports={reviseJournal,RevisionError};
