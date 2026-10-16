'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FakeRtdb}=require('./helpers/fake-rtdb.cjs');
const {reviseJournal}=require('../functions/saksjournal-revision-core');

function db(cold=true){
 return new FakeRtdb({sakJournal:{s1:{j1:{type:'observasjon',tekst:'Opprinnelig',opprettetAv:'u1',opprettetAt:'2026-10-01T08:00:00Z',fjernet:false}}}}, {coldTransactions:cold});
}
const args=d=>({db:d,sakId:'s1',entryId:'j1',uid:'u2',tekst:'Rettet',begrunnelse:'Presisering',now:'2026-10-16T07:00:00Z'});

test('cold cache: corrected revision commits original and replacement atomically',async()=>{
 const d=db();
 const r=await reviseJournal(args(d));
 assert.equal(d.at('/sakJournal/s1/j1').erstattetAv,r.id);
 assert.equal(d.at('/sakJournal/s1/'+r.id).tekst,'Rettet');
 assert.equal(d.at('/sakJournal/s1/j1').tekst,'Opprinnelig');
 assert.equal(Object.values(d.at('/sakJournal/s1')).filter(v=>!v.fjernet&&!v.erstattetAv).length,1);
 const events=d.at('/sakEvents/s1');
 assert.equal(Object.keys(events).length,1);
 const key=Object.keys(events)[0];
 assert.match(key,/^\d{13}-/);
 assert.equal(events[key].type,'journal_korrigert');
});
test('ten competing revisions produce one winner and one active revision',async()=>{
 const d=db();
 const results=await Promise.allSettled(Array.from({length:10},()=>reviseJournal(args(d))));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,9);
 const journal=d.at('/sakJournal/s1');
 assert.equal(Object.values(journal).filter(v=>!v.fjernet&&!v.erstattetAv).length,1);
});
test('a subsequent correction to the replaced version is rejected',async()=>{
 const d=db();await reviseJournal(args(d));
 await assert.rejects(reviseJournal(args(d)),e=>e.code==='failed-precondition');
});
test('event write failure never creates a dangling journal version',async()=>{
 const d=db();
 const original=d.ref.bind(d);
 d.ref=(path='/')=>{
   const ref=original(path);
   if(path.startsWith('/sakEvents/'))ref.set=async()=>{throw new Error('simulert feil');};
   return ref;
 };
 await assert.rejects(reviseJournal(args(d)),e=>e.code==='internal');
 const journal=d.at('/sakJournal/s1');
 assert.equal(Object.values(journal).filter(v=>!v.fjernet&&!v.erstattetAv).length,1);
 assert.equal(Object.keys(journal).length,2);
});
