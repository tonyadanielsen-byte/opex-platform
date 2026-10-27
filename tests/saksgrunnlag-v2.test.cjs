'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {deriveV2,buildSaksgrunnlagV2}=require('../functions/saksgrunnlag-v2-core');
const sources=[
{id:'J:j2',type:'journal',data:{type:'observasjon',tekst:'Ny',erstatter:'j1',opprettetAt:'2026-10-02T09:00:00Z'}},
{id:'J:j1',type:'journal',data:{type:'observasjon',tekst:'Gammel',erstattetAv:'j2',opprettetAt:'2026-10-01T09:00:00Z'}},
{id:'A:a1',type:'arsak',data:{status:'hypotese',sporId:'s1'}},
{id:'SP:s1',type:'spor',data:{sporsmal:'Hva skjedde?'}},
{id:'A:a2',type:'arsak',data:{status:'avkreftet'}},
{id:'J:j3',type:'journal',data:{fjernet:true}},
{id:'SE:e1',type:'sakshendelse',data:{createdAt:'2026-10-02T09:00:00Z'}}
];
const v1={schemaVersion:1,sakId:'s1',grunnlagHash:'hash1',sourceCount:sources.length,memberCount:0,sources};
test('V2 keeps V1 unchanged and classifies revisions and hypotheses',()=>{
 const orig=structuredClone(v1);
 const v2=deriveV2(v1);
 assert.deepEqual(v1,orig);
 assert.deepEqual(v2.counts,{gjeldende:3,erstattet:1,avkreftet_eller_fjernet:2,hypotese:1});
 assert.deepEqual(v2.sources.find(s=>s.id==='J:j2').koblinger,[{relasjon:'erstatter',kildeId:'J:j1'}]);
 assert.deepEqual(v2.sources.find(s=>s.id==='A:a1').koblinger,[{relasjon:'spor',kildeId:'SP:s1'}]);
 assert.deepEqual(v2.chronological,['J:j1','J:j2','SE:e1']);
 assert.deepEqual(v2.utenTidspunkt,['A:a1','SP:s1','A:a2','J:j3']);
});
test('V2 deterministic and no invented links to missing source',()=>{
 const a=deriveV2(v1),b=deriveV2(structuredClone(v1));
 assert.deepEqual(a,b);
 assert.match(a.projectionHash,/^[a-f0-9]{64}$/);
 assert.equal(a.sources.find(s=>s.id==='J:j1').koblinger[0].kildeId,'J:j2');
 const missing=structuredClone(v1);
 missing.sources[0].data.erstatter='missing';
 assert.deepEqual(deriveV2(missing).sources[0].koblinger,[]);
});
test('V2 retains source provenance and excludes unrelated case data',async()=>{
 const data={'/saker/s1':{sakId:'s1',tittel:'Sak'},'/tiltak':{t1:{sakId:'s1',tittel:'Knyttet'},t2:{sakId:'s2',tittel:'Annen sak'}},'/sakJournal/s1':{j1:{type:'observasjon',tekst:'Funn'}}};
 const db={ref:p=>({get:async()=>({val:()=>data[p]||null})})};
 const result=await buildSaksgrunnlagV2(db,'s1');
 assert.equal(result.basis.memberCount,1);
 assert.equal(result.oversikt.memberCount,1);
 assert.equal(result.oversikt.grunnlagHash,result.basis.grunnlagHash);
 assert.ok(result.basis.sources.some(s=>s.id==='J:j1'&&s.data.tekst==='Funn'));
 assert.ok(!result.basis.sources.some(s=>s.id==='T:t2'));
});
