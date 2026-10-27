'use strict';
// Read-only derived case basis. Preserve every V1 source and do not infer facts from prose.
const {createHash}=require('node:crypto');
const {buildSaksgrunnlag,stable}=require('./saksgrunnlag-core');

function classify(source) {
  const d=source.data||{};
  if (d.fjernet===true) return 'avkreftet_eller_fjernet';
  if (d.erstattetAv) return 'erstattet';
  if (source.type==='arsak') {
    const s=String(d.status||'').toLowerCase();
    if (['avkreftet','forkastet','avvist'].includes(s)) return 'avkreftet_eller_fjernet';
    if (['hypotese','mulig','under_vurdering'].includes(s)) return 'hypotese';
  }
  return 'gjeldende';
}
function sourceTime(s) {
  const d=s.data||{};
  for (const field of ['createdAt','opprettetAt','vurdertAt']) {
    const v=d[field];
    if(typeof v==='string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v))) return v;
  }
  if(typeof d.gjelderDato==='string' && /^\d{4}-\d\d-\d\d$/.test(d.gjelderDato)) return d.gjelderDato;
  return null;
}
function deriveV2(v1) {
  const references=new Set(v1.sources.map(s=>s.id));
  const sources=v1.sources.map(s=>{
    const status=classify(s);
    const d=s.data||{};
    const linked=[];
    if(s.type==='journal') {
      for(const [key,val] of [['erstatter',d.erstatter],['erstattetAv',d.erstattetAv]]) {
        if(typeof val==='string' && references.has('J:'+val))linked.push({relasjon:key,kildeId:'J:'+val});
      }
    }
    if(s.type==='arsak' && typeof d.sporId==='string' && references.has('SP:'+d.sporId))
      linked.push({relasjon:'spor',kildeId:'SP:'+d.sporId});
    return {id:s.id,type:s.type,status,tidspunkt:sourceTime(s),koblinger:linked};
  });
  const chronological=sources.filter(s=>s.tidspunkt).sort((a,b)=>a.tidspunkt.localeCompare(b.tidspunkt)||a.id.localeCompare(b.id)).map(s=>s.id);
  const utenTidspunkt=sources.filter(s=>!s.tidspunkt).map(s=>s.id);
  const counts={gjeldende:0,erstattet:0,avkreftet_eller_fjernet:0,hypotese:0};
  for(const s of sources) counts[s.status]++;
  const projection={schemaVersion:2,sakId:v1.sakId,grunnlagHash:v1.grunnlagHash,sourceCount:v1.sourceCount,memberCount:v1.memberCount,sources,chronological,utenTidspunkt,counts};
  return {...projection,projectionHash:createHash('sha256').update(stable(projection)).digest('hex')};
}
async function buildSaksgrunnlagV2(db,sakId) {
  const basis=await buildSaksgrunnlag(db,sakId);
  return {basis,oversikt:deriveV2(basis)};
}
module.exports={classify,sourceTime,deriveV2,buildSaksgrunnlagV2};
