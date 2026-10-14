'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildSaksgrunnlag,stable,validId}=require('../functions/saksgrunnlag-core');
const data={
 '/saker/s1':{sakId:'s1',kode:'SAK-0001',tittel:'Eksempel',status:'Åpen'},
 '/tiltak':{t2:{sakId:'s1',tittel:'Andre',status:'Aktiv',kommentarer:{c0:{tekst:'Eldre beskjed'}}},t1:{sakId:'s1',tittel:'Første',status:'Fullført'},t3:{sakId:'s2',tittel:'Urelatert'}},
 '/sakSpor/s1':{a:{kode:'A',sporsmal:'Hvorfor?'}},
 '/sakArsaker/s1':{b:{tekst:'Mulig årsak',status:'hypotese'}},
 '/sakEvents/s1':{e1:{type:'sak_opprettet',createdAt:'2026-10-10T10:00:00Z'}},
 '/sakJournal/s1':{j1:{type:'beslutning',tekst:'Kontroll innføres',opprettetAt:'2026-10-11T10:00:00Z'}},
 '/tiltakEvents/t1':{ev1:{type:'endret',felt:'status',etter:'Fullført'}},
 '/taskComments/t1':{cc1:{text:'Rutine testet',authorUid:'u1'}},
};
const db={ref:p=>({get:async()=>({val:()=>data[p]||null})})};
test('source bundle has canonical stable hash and documented sources',async()=>{
 const a=await buildSaksgrunnlag(db,'s1'),b=await buildSaksgrunnlag(db,'s1');
 assert.deepEqual(a,b);
 assert.equal(a.memberCount,2);
 assert.equal(a.sourceCount,a.sources.length);
 for(const id of ['S:s1','T:t1','T:t2','SE:e1','J:j1','K:t1:cc1','KL:t2:c0','TE:t1:ev1','A:b','SP:a'])
 assert.ok(a.sources.some(s=>s.id===id),id);
 assert.ok(!a.sources.some(s=>s.data.tittel==='Urelatert'));
 assert.match(a.grunnlagHash,/^[a-f0-9]{64}$/);
});
test('source bundle hash changes when journal changes',async()=>{
 const a=await buildSaksgrunnlag(db,'s1');
 data['/sakJournal/s1'].j2={type:'observasjon',tekst:'Nytt funn'};
 const b=await buildSaksgrunnlag(db,'s1');
 assert.notEqual(a.grunnlagHash,b.grunnlagHash);
 delete data['/sakJournal/s1'].j2;
});
test('invalid and nonexistent IDs rejected',async()=>{
 for(const id of ['s1/secret','../s1','','bad.key']) await assert.rejects(buildSaksgrunnlag(db,id));
 await assert.rejects(buildSaksgrunnlag(db,'s404'));
 assert.equal(validId('-Npd_123'),true);
});
test('canonical serializer ignores object key insertion order',()=>assert.equal(stable({a:1,b:{x:2,y:3}}),stable({b:{y:3,x:2},a:1})));
