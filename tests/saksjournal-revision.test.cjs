'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {buildSaksgrunnlag}=require('../functions/saksgrunnlag-core');
const file=path.join(__dirname,'..','functions','saksgrunnlag-api.js');
test('journal revision callable delegates to atomic revision core and validates permissions',()=>{
  const src=fs.readFileSync(file,'utf8');
  const core=fs.readFileSync(path.join(__dirname,'..','functions','saksjournal-revision-core.js'),'utf8');
  assert.match(src,/exports\\.reviseSakJournalEntryV1\\s*=\\s*onCall/);
  assert.match(src,/await auth\\(request\\)/);
  assert.match(src,/activeSak\\(db,sakId,true\\)/);
  assert.match(src,/!begrunnelse\\.trim\\(\\)/);
  assert.match(src,/reviseJournal\\(/);
  assert.match(core,/journalRef\\.transaction\\(/);
  assert.match(core,/journal_korrigert/);
});
test('AI evidence includes active journal revision and original evidence with stable source IDs',async()=>{
 const data={
 '/saker/s1':{sakId:'s1',tittel:'Sak',status:'Åpen'},
 '/tiltak':{},
 '/sakJournal/s1':{
   j1:{type:'observasjon',tekst:'Gammel formulering',fjernet:true,erstattetAv:'j2',opprettetAv:'u1'},
   j2:{type:'observasjon',tekst:'Korrigert formulering',erstatter:'j1',begrunnelse:'Presisering',opprettetAv:'u2',fjernet:false}
 }
 };
 const db={ref:p=>({get:async()=>({val:()=>data[p]||null})})};
 const bundle=await buildSaksgrunnlag(db,'s1');
 assert.equal(bundle.sources.find(x=>x.id==='J:j1').data.erstattetAv,'j2');
 assert.equal(bundle.sources.find(x=>x.id==='J:j2').data.begrunnelse,'Presisering');
});
