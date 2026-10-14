'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../functions/sak-core');
const {FakeRtdb}=require('./helpers/fake-rtdb.cjs');
const mk=()=>{const db=new FakeRtdb({authorizedUsers:{admin:true,user:true},sakAdmins:{admin:true}});return {db,deps:{db,now:()=>new Date('2026-10-14T08:00:00Z'),sleep:async()=>{},log:{error:()=>{}}}};};
test('only explicitly server-authorized admins can delete; deleted cases are hidden, with history preserved',async()=>{
 const e=mk();
 const s=await core.createSak(e.deps,'admin',{tittel:'TEST sak',spor:[{sporsmal:'Hvorfor skjedde det?'}]});
 await assert.rejects(core.deleteSak(e.deps,'user',{sakId:s.sakId,bekreftKode:s.kode}),x=>x.code==='permission-denied');
 await assert.rejects(core.deleteSak(e.deps,'admin',{sakId:s.sakId,bekreftKode:'SAK-9999'}),x=>x.code==='invalid-argument');
 const res=await core.deleteSak(e.deps,'admin',{sakId:s.sakId,bekreftKode:s.kode});
 assert.equal(res.slettet,true);
 assert.equal((await core.getSaker(e.deps,'admin',{})).saker.length,0);
 assert.ok(e.db.at('/saker/'+s.sakId).slettetAt);
 assert.ok(e.db.at('/sakSpor/'+s.sakId));
 assert.ok(e.db.at('/sakEvents/'+s.sakId));
 await assert.rejects(core.getSak(e.deps,'admin',{sakId:s.sakId}),x=>x.code==='not-found');
});
test('cases with linked measures cannot be deleted, even when measures are completed',async()=>{
 const e=mk();const s=await core.createSak(e.deps,'admin',{tittel:'Ribbefett'});
 await e.db.ref('/tiltak/test1').set({sakId:s.sakId,status:'Fullført'});
 await assert.rejects(core.deleteSak(e.deps,'admin',{sakId:s.sakId,bekreftKode:s.kode}),x=>x.code==='failed-precondition');
 assert.equal(e.db.at('/saker/'+s.sakId).slettetAt,undefined);
 assert.ok(e.db.at('/tiltak/test1'));
});
