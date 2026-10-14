'use strict';
// Read-only, deterministic source bundle. No AI/model calls and no production writes.
const { createHash } = require('node:crypto');
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
function validId(value) { return typeof value === 'string' && SAFE_ID.test(value); }
function entries(value) { return Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort(([a],[b]) => a.localeCompare(b)); }
function pick(obj, fields) { const result = {}; for (const f of fields) if (obj && obj[f] !== undefined && obj[f] !== null) result[f] = obj[f]; return result; }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value === undefined ? null : value);
}
async function buildSaksgrunnlag(db, sakId) {
  if (!validId(sakId)) throw new Error('Ugyldig sak-ID');
  const read = async path => (await db.ref(path).get()).val() || {};
  const sak = await read('/saker/' + sakId);
  if (!sak || !sak.sakId || sak.deletedAt || sak.slettetAt || sak.slettet === true) throw new Error('Saken finnes ikke');
  const [tiltak, spor, arsaker, hendelser, journal, legacyComments, newComments, tiltakEvents] = await Promise.all([
    read('/tiltak'), read('/sakSpor/'+sakId), read('/sakArsaker/'+sakId), read('/sakEvents/'+sakId),
    read('/sakJournal/'+sakId), Promise.resolve({}), Promise.resolve({}), Promise.resolve({}),
  ]);
  const sources = [];
  function add(id, type, data) { sources.push({ id, type, data }); }
  add('S:'+sakId, 'sak', pick(sak, ['sakId','kode','tittel','problemstilling','status','omrader','opprettetAt','eierUid']));
  for (const [id, obj] of entries(spor)) add('SP:'+id,'spor',pick(obj,['kode','sporsmal','rekkefolge']));
  for (const [id, obj] of entries(arsaker)) add('A:'+id,'arsak',pick(obj,['tekst','status','grunnlag','vurdertAt','vurdertAv','fjernet','erstatter','sporId']));
  for (const [id, obj] of entries(hendelser)) add('SE:'+id,'sakshendelse',pick(obj,['type','createdAt','actorUid','entityId','felt','foer','etter']));
  for (const [id, obj] of entries(journal)) add('J:'+id,'journal',pick(obj,['type','tekst','gjelderDato','opprettetAt','opprettetAv','fjernet','erstatter','koblinger']));
  let memberCount=0;
  for (const [id, task] of entries(tiltak)) {
    if (!task || task.sakId !== sakId) continue;
    memberCount++;
    add('T:'+id,'tiltak',pick(task,['tittel','beskrivelse','nestesteg','status','frist','eier','prioritet','omrade','miljo','livssyklus','source','sourceRoundId','sourceFinding','arkivert']));
    // Fetch all relevant events and both comment stores for each linked measure; never truncate.
    const [ev, comments] = await Promise.all([read('/tiltakEvents/'+id),read('/taskComments/'+id)]);
    for (const [eid,e] of entries(ev)) add('TE:'+id+':'+eid,'tiltakshendelse',pick(e,['type','felt','foer','etter','createdAt','actorUid']));
    for (const [cid,c] of entries(comments)) add('K:'+id+':'+cid,'kommentar',pick(c,['text','authorUid','createdAt']));
    for (const [cid,c] of entries(task.kommentarer)) add('KL:'+id+':'+cid,'eldre_kommentar',typeof c==='string'?{text:c}:pick(c,['text','tekst','author','authorUid','createdAt','dato']));
  }
  const material = {schemaVersion:1,sakId,memberCount,sources};
  return {...material,grunnlagHash:createHash('sha256').update(stable(material)).digest('hex'),sourceCount:sources.length};
}
module.exports={buildSaksgrunnlag,stable,validId};
