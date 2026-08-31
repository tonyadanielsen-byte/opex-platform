(() => {
'use strict';
const DEFAULT_AREAS=['Ferdigmat','Renhold','Rekvisita'];
const clean=v=>String(v??'').trim().replace(/\s+/g,' ');
const key=v=>clean(v).toLocaleLowerCase('nb-NO');
const $=id=>document.getElementById(id);
let areas=[...DEFAULT_AREAS];

function style(){if($('opex-quick-create-style'))return;const s=document.createElement('style');s.id='opex-quick-create-style';s.textContent=`
.opex-field-error{border-color:#c73513!important;box-shadow:0 0 0 3px rgba(199,53,19,.13)!important}.opex-inline-error{display:none;margin:0 20px 12px;padding:10px 12px;border-radius:9px;background:#fff0eb;border:1px solid #efc3b7;color:#9e3217;font-size:12px;font-weight:750}.opex-inline-error.show{display:block}.opex-next-hint{display:block;margin-top:5px;color:#777;font-size:11px;font-weight:500}.opex-missing-next{display:inline-flex;margin-left:6px;padding:2px 7px;border-radius:999px;background:#fff0d2;color:#8a5d05;font-size:10px;font-weight:850}.opex-area-help{font-size:11px;color:#777;margin-top:5px}`;document.head.appendChild(s);}

async function loadAreas(){
  try{
    const [cfg,tasks]=await Promise.all([firebase.database().ref('/config/areas').once('value'),firebase.database().ref('/tiltak').once('value')]);
    const map=new Map(DEFAULT_AREAS.map(a=>[key(a),a]));
    cfg.forEach(c=>{const v=typeof c.val()==='string'?c.val():c.val()?.name;if(clean(v))map.set(key(v),clean(v));});
    tasks.forEach(c=>{const v=clean(c.val()?.omrade);if(v)map.set(key(v),v);});
    areas=[...map.values()].sort((a,b)=>a.localeCompare(b,'nb'));
  }catch(e){console.warn('[OpEx QuickCreate] Kunne ikke laste områder',e);}
}
async function rememberArea(name){name=clean(name);if(!name)return;const existing=areas.find(a=>key(a)===key(name));if(existing)return;areas.push(name);areas.sort((a,b)=>a.localeCompare(b,'nb'));try{await firebase.database().ref('/config/areas').push({name,createdAt:new Date().toISOString(),createdBy:firebase.auth().currentUser?.uid||''});}catch(e){console.warn('[OpEx QuickCreate] Område lagres via eksisterende tiltak, config kunne ikke skrives',e);}}

function areaField(){
  const old=$('omrade'); if(!old||old.dataset.dynamicArea==='1')return;
  const input=document.createElement('input');
  input.id='omrade';input.name=old.name||'omrade';input.placeholder='Velg eller skriv område';input.autocomplete='off';input.dataset.dynamicArea='1';input.setAttribute('list','opexAreaList');
  const dl=document.createElement('datalist');dl.id='opexAreaList';
  const refresh=()=>{dl.innerHTML='';areas.forEach(a=>{const o=document.createElement('option');o.value=a;dl.appendChild(o);});};refresh();
  const current=clean(old.value);if(current)input.value=current;
  old.replaceWith(input);input.insertAdjacentElement('afterend',dl);
  const help=document.createElement('div');help.className='opex-area-help';help.textContent='Velg fra listen eller skriv et nytt område. Nye områder huskes automatisk.';dl.insertAdjacentElement('afterend',help);
  input.addEventListener('focus',refresh);input.addEventListener('change',()=>rememberArea(input.value));
}

function inlineError(message,field){
  let box=$('opexModalInlineError');if(!box){box=document.createElement('div');box.id='opexModalInlineError';box.className='opex-inline-error';const body=document.querySelector('#modal .modalbody');body?.insertAdjacentElement('beforebegin',box);}
  document.querySelectorAll('#modal .opex-field-error').forEach(x=>x.classList.remove('opex-field-error'));
  if(!message){box?.classList.remove('show');return;}
  box.textContent=message;box.classList.add('show');if(field){field.classList.add('opex-field-error');field.scrollIntoView({block:'center',behavior:'smooth'});field.focus();}
}

function makeNextOptional(){
  const n=$('nestesteg');if(!n)return;
  n.required=false;n.removeAttribute('required');
  const label=n.closest('.full,.formgrid>div,div')?.querySelector('label');if(label&&!label.dataset.quickHint){label.dataset.quickHint='1';const h=document.createElement('span');h.className='opex-next-hint';h.textContent='Anbefalt ved opprettelse – kan fylles ut senere.';label.appendChild(h);}
}

function saveHook(){
  if(typeof window.saveTask!=='function'||window.saveTask.__quickCreate)return false;
  const original=window.saveTask;
  const wrapped=async function(...args){
    inlineError('');
    const isNew=!window.editKey;
    if(isNew){
      makeNextOptional();
      const required=[['tittel','Tittel'],['kategori','Kategori'],['omrade','Område'],['frist','Frist'],['eier','Eier']];
      for(const [id,label] of required){const f=$(id);if(f&&!clean(f.value)){inlineError(`${label} må fylles ut før tiltaket kan lagres.`,f);return;}}
      const area=clean($('omrade')?.value);if(area)await rememberArea(area);
    }
    try{return await original.apply(this,args);}catch(e){console.error('[OpEx QuickCreate] Lagre-feil',e);inlineError('Tiltaket kunne ikke lagres. Prøv igjen eller kontroller feltene over.');}
  };
  wrapped.__quickCreate=true;window.saveTask=wrapped;return true;
}

function modalHook(){
  if(typeof window.openModal!=='function'||window.openModal.__quickCreate)return false;
  const original=window.openModal;
  const wrapped=function(key,...rest){const out=original.call(this,key,...rest);setTimeout(()=>{inlineError('');areaField();if(!key)makeNextOptional();},0);return out;};wrapped.__quickCreate=true;window.openModal=wrapped;return true;
}

function missingNextBadge(){
  document.querySelectorAll('[onclick*="openModal("]').forEach(el=>{if(el.querySelector('.opex-missing-next'))return;const txt=el.textContent||'';if(!/Neste steg/i.test(txt))return;});
}

function boot(){if(!window.firebase?.database)return setTimeout(boot,150);style();loadAreas().then(areaField);let n=0;const t=setInterval(()=>{n++;const a=modalHook(),b=saveHook();if((a&&b)||n>80)clearInterval(t);},150);new MutationObserver(()=>{areaField();missingNextBadge();}).observe(document.body,{childList:true,subtree:true});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
