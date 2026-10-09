'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../functions/sak-core');
const { FakeRtdb } = require('./helpers/fake-rtdb.cjs');
function setup(){
  const db = new FakeRtdb({authorizedUsers:{tony:true}});
  const deps={db,now:()=>new Date('2026-10-09T12:00:00Z'),sleep:async()=>{},log:{error:()=>{}}};
  return {db,deps};
}
test('opprett ekstra spor C etter eksisterende A og B – serverhendelse og ett update',async()=>{
  const {db,deps}=setup();
  const sak=await core.createSak(deps,'tony',{tittel:'Ribbefett 2025',spor:[{sporsmal:'Hvorfor restlager?'},{sporsmal:'Hvorfor kassasjon?'}]});
  const before=db.updateCalls.length;
  const r=await core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'Hvordan unngår vi gjentakelse?'});
  assert.equal(r.kode,'C');
  assert.equal(db.at('/sakSpor/'+sak.sakId+'/'+r.sporId).sporsmal,'Hvordan unngår vi gjentakelse?');
  assert.equal(db.updateCalls.length,before+1);
  const events=Object.values(db.at('/sakEvents/'+sak.sakId)||{});
  assert.ok(events.some(x=>x.type==='spor_opprettet'&&x.actorUid==='tony'));
});
test('stengte saker kan ikke få nye spor',async()=>{
  const {deps}=setup();
  const sak=await core.createSak(deps,'tony',{tittel:'Testsak'});
  await core.updateSak(deps,'tony',{sakId:sak.sakId,status:'Lukket'});
  await assert.rejects(core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'Nytt spørsmål?'}),e=>e.code==='failed-precondition');
});
test('mangler tilgang / ugyldig innhold avvises',async()=>{
  const {deps}=setup();
  await assert.rejects(core.createSpor(deps,null,{sakId:'x',sporsmal:'Spørsmål?'}),e=>e.code==='unauthenticated');
  const sak=await core.createSak(deps,'tony',{tittel:'Testsak'});
  await assert.rejects(core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'x'}),e=>e.code==='invalid-argument');
  await assert.rejects(core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'Spørsmål?',actorUid:'fake'}),e=>e.code==='invalid-argument');
});
test('maks åtte spor, kodeoversikt A–H',async()=>{
 const {deps}=setup();
 const sak=await core.createSak(deps,'tony',{tittel:'Testsak'});
 for(let i=0;i<8;i++){
  const x=await core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'Spørsmål nummer '+i});
  assert.equal(x.kode,String.fromCharCode(65+i));
 }
 await assert.rejects(core.createSpor(deps,'tony',{sakId:sak.sakId,sporsmal:'Ett til spørsmål'}),e=>e.code==='failed-precondition');
});
