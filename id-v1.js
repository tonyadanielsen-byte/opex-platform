(() => {
'use strict';
const PREFIX=Object.freeze({HMS:'HMS',Kvalitet:'KVAL',KF:'KF',GPP:'GPP',LOR:'LOR',Annet:'ANNET'});let ready=false;const initial=new Set();
const clean=v=>String(v??'').trim(), prefixFor=c=>PREFIX[clean(c)]||'ANNET', formatId=(p,n)=>`${p}-${String(n).padStart(4,'0')}`;

/*
 * ID is metadata only. It must NEVER be able to block creating/editing a tiltak.
 * The registry transaction used previously required separate database permissions
 * and could fail immediately after a new tiltak was written. We now allocate the
 * ID from the existing /tiltak data only and treat all ID work as best-effort.
 */
async function assignId(key,task){
  if(!key||clean(task?.systemId))return '';
  try{
    const prefix=prefixFor(task?.kategori);
    const snap=await firebase.database().ref('/tiltak').once('value');
    let max=0;
    snap.forEach(c=>{
      const v=c.val()||{};
      if(c.key===key)return;
      if(clean(v.systemIdPrefix)===prefix){
        max=Math.max(max,Number(v.systemIdNumber)||0);
        return;
      }
      const m=clean(v.systemId).match(new RegExp(`^${prefix}-(\\d+)$`));
      if(m)max=Math.max(max,Number(m[1])||0);
    });
    const number=max+1;
    const id=formatId(prefix,number);
    const createdAt=new Date().toISOString();
    await firebase.database().ref(`/tiltak/${key}`).update({systemId:id,systemIdPrefix:prefix,systemIdNumber:number,systemIdCreatedAt:createdAt});
    return id;
  }catch(e){
    console.warn('[OpEx ID] ID-tildeling hoppet over. Tiltaket er fortsatt lagret.',e);
    return '';
  }
}

function watch(){
  const r=firebase.database().ref('/tiltak');
  r.once('value').then(s=>{
    s.forEach(c=>initial.add(c.key));
    ready=true;
    r.on('child_added',c=>{
      if(!ready||initial.has(c.key)||clean(c.val()?.systemId))return;
      /* Fire-and-forget: ID metadata may never interrupt the normal save flow. */
      setTimeout(()=>assignId(c.key,c.val()||{}),0);
    });
  }).catch(e=>console.warn('[OpEx ID] Oppstart hoppet over',e));
}
function styles(){if(document.getElementById('opex-id-style'))return;const s=document.createElement('style');s.id='opex-id-style';s.textContent='.opex-system-id{display:inline-flex;width:max-content;padding:3px 8px;border-radius:999px;background:rgba(67,74,116,.09);border:1px solid rgba(67,74,116,.14);font-size:10px;font-weight:850;letter-spacing:.45px;color:#515b79;margin:0 0 5px}.opex-modal-id{padding:0 20px 10px;background:var(--soft);font-size:11px;font-weight:850;letter-spacing:.5px;color:#66708d}';document.head.appendChild(s);}
async function getId(key){try{return clean((await firebase.database().ref(`/tiltak/${key}/systemId`).once('value')).val());}catch{return'';}}
async function decorate(){for(const el of document.querySelectorAll('[onclick*="openModal("]')){if(el.dataset.opexId==='1')continue;const m=String(el.getAttribute('onclick')||'').match(/openModal\(['\"]([^'\"]+)/);if(!m)continue;const id=await getId(m[1]);if(!id)continue;el.dataset.opexId='1';const target=el.querySelector('h3,.task-main b');if(target&&!el.querySelector('.opex-system-id'))target.insertAdjacentHTML('beforebegin',`<span class="opex-system-id">${id}</span>`);}}
function modalHook(){if(typeof window.openModal!=='function'||window.openModal.__opexId)return false;const original=window.openModal;const wrapped=function(key,...rest){document.getElementById('opexModalSystemId')?.remove();const out=original.call(this,key,...rest);if(key)setTimeout(async()=>{const id=await getId(key);if(!id)return;const head=document.querySelector('#modal .modalhead');if(head&&!document.getElementById('opexModalSystemId')){const n=document.createElement('div');n.id='opexModalSystemId';n.className='opex-modal-id';n.textContent=`ID · ${id}`;head.insertAdjacentElement('afterend',n);}},30);return out;};wrapped.__opexId=true;window.openModal=wrapped;return true;}
function excelHook(){if(typeof window.excelRows!=='function'||window.excelRows.__opexId)return false;const o=window.excelRows,w=function(list){return o(list).map((row,i)=>({ID:clean(list?.[i]?.systemId),...row}));};w.__opexId=true;window.excelRows=w;return true;}
function boot(){if(!window.firebase?.database)return setTimeout(boot,200);styles();watch();new MutationObserver(()=>decorate()).observe(document.body,{childList:true,subtree:true});decorate();let n=0,t=setInterval(()=>{n++;const a=modalHook(),b=excelHook();if((a&&b)||n>60)clearInterval(t);},200);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
