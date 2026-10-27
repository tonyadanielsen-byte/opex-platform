'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildSaksgrunnlag}=require('../functions/saksgrunnlag-core');
test('indexed RTDB query only fetches measures linked to requested case',async()=>{
 const seen=[];
 const data={'/saker/s1':{sakId:'s1',tittel:'Sak'},'/sakSpor/s1':{},'/sakArsaker/s1':{},'/sakEvents/s1':{},'/sakJournal/s1':{},'/tiltakEvents/t1':{},'/taskComments/t1':{}};
 const db={ref(path){
   if(path==='/tiltak')return {
     orderByChild(field){assert.equal(field,'sakId');return {equalTo(id){assert.equal(id,'s1');return {get:async()=>{seen.push('scoped');return {val:()=>({t1:{sakId:'s1',tittel:'Test'}})};}};}};}
   };
   return {get:async()=>({val:()=>data[path]||null})};
 }};
 const result=await buildSaksgrunnlag(db,'s1');
 assert.deepEqual(seen,['scoped']);
 assert.equal(result.memberCount,1);
 assert.ok(result.sources.some(s=>s.id==='T:t1'));
});
