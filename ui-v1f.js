(() => {
  'use strict';

  const TRASH_CONFIRM_KEY = 'opex_confirm_trash';
  const bypassTrashButtons = new WeakSet();
  const USER_NAMES = Object.freeze({
    'TJKI3zlDKSR7jvFXksVFgEgjS432': 'Tony Danielsen',
    'gibm3aDi1KWlNyl7P3jTktQoGsM2': 'Kenneth Nordbakk',
    'lJ7bn7HkbcZnhDoxfaBYQKEFL083': 'Erling Magnussen',
  });
  let activeTaskId = null;
  let stopCommentListener = null;

  function installEnhancementStyles() {
    if (document.getElementById('opexUserPreferenceStyles')) return;
    const style = document.createElement('style');
    style.id = 'opexUserPreferenceStyles';
    style.textContent = `
      .opex-menu-preference{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 14px;border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08);color:#e8ebf7;cursor:default}
      .opex-menu-pref-copy{display:flex;align-items:center;gap:9px;min-width:0;font-size:13px;line-height:1.25}.opex-menu-pref-icon{flex:0 0 auto}.opex-menu-switch{position:relative;display:inline-flex;flex:0 0 auto;margin:0!important;cursor:pointer}.opex-menu-switch input{position:absolute;opacity:0;pointer-events:none}.opex-menu-switch span{display:block;width:38px;height:22px;border-radius:999px;background:#65708b;position:relative;transition:.18s ease;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}.opex-menu-switch span:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:.18s ease}.opex-menu-switch input:checked+span{background:linear-gradient(135deg,#765df2,#4e87f2)}.opex-menu-switch input:checked+span:after{transform:translateX(16px)}.opex-confirm-card p{margin-bottom:19px!important}
      .opex-comments{grid-column:1/-1;margin-top:4px;padding-top:12px;border-top:1px solid rgba(73,78,105,.13)}
      .opex-comments-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.opex-comments-head strong{font-size:13px;color:#29324e}.opex-comments-head span{font-size:11px;color:#7a839d}
      .opex-comment-compose{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.opex-comment-compose textarea{min-height:52px!important;max-height:120px;resize:vertical}.opex-comment-compose button{min-height:38px;white-space:nowrap}
      .opex-comment-list{display:grid;gap:7px;margin-top:10px;max-height:180px;overflow:auto}.opex-comment{padding:9px 11px;border-radius:10px;background:#f5f6fb;border:1px solid rgba(70,78,120,.10)}.opex-comment-meta{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:10px;color:#78819a}.opex-comment-meta strong{font-size:11px;color:#4c5673}.opex-comment-text{font-size:12px;line-height:1.4;color:#29324e;white-space:pre-wrap;overflow-wrap:anywhere}.opex-comment-empty{font-size:11px;color:#858da3;padding:6px 2px}
      @media(max-width:620px){.opex-comment-compose{grid-template-columns:1fr}.opex-comment-compose button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function celebrateCompleted(title) {
    document.querySelector('.opex-celebration')?.remove();
    const layer = document.createElement('div'); layer.className = 'opex-celebration';
    layer.innerHTML = `<div class="opex-celebration-card"><div class="opex-celebration-icon">🎉</div><strong>Tiltaket er i mål!</strong><span>${String(title || 'Sterkt jobbet!')}</span></div>`;
    const card = layer.firstElementChild; const colors = ['#765df2','#3d8cd8','#31b887','#f1b84b','#ef6b72'];
    for (let i=0;i<18;i+=1){const piece=document.createElement('i');piece.className='opex-confetti';piece.style.color=colors[i%colors.length];const angle=(Math.PI*2*i)/18;const distance=95+(i%5)*18;piece.style.setProperty('--x',`${Math.cos(angle)*distance}px`);piece.style.setProperty('--y',`${Math.sin(angle)*distance}px`);piece.style.setProperty('--r',`${180+i*37}deg`);card.appendChild(piece);} document.body.appendChild(layer); setTimeout(()=>layer.remove(),1800);
  }

  function suppressLegacyAdminWarning(){const warning=document.getElementById('adminWarning');if(warning)warning.style.setProperty('display','none','important');}
  function trashConfirmationEnabled(){return localStorage.getItem(TRASH_CONFIRM_KEY)!=='false';}
  function setTrashConfirmationEnabled(enabled){localStorage.setItem(TRASH_CONFIRM_KEY,enabled?'true':'false');syncTrashPreferenceControl();}

  function showTrashConfirmation(onConfirm){document.querySelector('.opex-confirm-layer')?.remove();const layer=document.createElement('div');layer.className='opex-confirm-layer';layer.innerHTML=`<div class="opex-confirm-card" role="dialog" aria-modal="true" aria-labelledby="opexTrashConfirmTitle"><h3 id="opexTrashConfirmTitle">Flytte tiltaket til papirkurv?</h3><p>Tiltaket fjernes fra aktive visninger, men kan gjenopprettes senere av administrator.</p><div class="opex-confirm-actions"><button type="button" class="btn secondary" data-confirm-cancel>Avbryt</button><button type="button" class="btn danger" data-confirm-ok>Flytt til papirkurv</button></div></div>`;document.body.appendChild(layer);const close=()=>layer.remove();layer.querySelector('[data-confirm-cancel]')?.addEventListener('click',close);layer.addEventListener('click',event=>{if(event.target===layer)close();});layer.querySelector('[data-confirm-ok]')?.addEventListener('click',()=>{close();onConfirm();});}
  function isTrashButton(element){const button=element?.closest?.('button');if(!button)return null;const text=String(button.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();return text.includes('flytt til papirkurv')?button:null;}
  function installTrashClickGuard(){if(document.documentElement.dataset.opexTrashGuard==='true')return;document.documentElement.dataset.opexTrashGuard='true';document.addEventListener('click',event=>{const button=isTrashButton(event.target);if(!button)return;if(bypassTrashButtons.has(button)){bypassTrashButtons.delete(button);return;}if(!trashConfirmationEnabled())return;event.preventDefault();event.stopImmediatePropagation();showTrashConfirmation(()=>{bypassTrashButtons.add(button);button.click();});},true);}
  function syncTrashPreferenceControl(){const input=document.getElementById('opexTrashPreference');if(input)input.checked=trashConfirmationEnabled();}
  function installUserMenuPreference(){const menu=document.querySelector('.dropdown');if(!menu)return false;if(!document.getElementById('opexTrashPreferenceRow')){const row=document.createElement('div');row.id='opexTrashPreferenceRow';row.className='opex-menu-preference';row.innerHTML=`<div class="opex-menu-pref-copy"><span class="opex-menu-pref-icon">🗑️</span><span>Bekreft før flytting til papirkurv</span></div><label class="opex-menu-switch" title="Bekreft før flytting til papirkurv"><input type="checkbox" id="opexTrashPreference" aria-label="Bekreft før flytting til papirkurv"><span aria-hidden="true"></span></label>`;const adminItem=Array.from(menu.children).find(el=>String(el.textContent||'').trim().toLowerCase().includes('admin'));if(adminItem)menu.insertBefore(row,adminItem);else menu.appendChild(row);const input=row.querySelector('#opexTrashPreference');input?.addEventListener('change',event=>setTrashConfirmationEnabled(Boolean(event.target.checked)));row.addEventListener('click',event=>event.stopPropagation());}syncTrashPreferenceControl();return true;}
  function installOutsideMenuClose(){if(document.documentElement.dataset.opexMenuOutsideClose==='true')return;document.documentElement.dataset.opexMenuOutsideClose='true';document.addEventListener('pointerdown',event=>{const menu=document.querySelector('.dropdown.open');if(!menu)return;const userBox=menu.closest('.userbox');if(menu.contains(event.target)||userBox?.contains(event.target))return;menu.classList.remove('open');});}

  function currentUser(){return window.firebase?.auth?.()?.currentUser||null;}
  function formatCommentTime(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';return new Intl.DateTimeFormat('no-NO',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d);}
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));}
  function stopComments(){if(typeof stopCommentListener==='function')stopCommentListener();stopCommentListener=null;document.getElementById('opexComments')?.remove();}
  async function resolveTaskId(candidate){const id=String(candidate??'').trim();if(!id||id==='new')return null;try{const snap=await firebase.database().ref(`/tiltak/${id}`).once('value');return snap.exists()?id:null;}catch{return null;}}
  function renderCommentItems(container,value){const rows=Object.entries(value||{}).map(([id,c])=>({id,...c})).sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));container.innerHTML=rows.length?rows.map(c=>`<div class="opex-comment"><div class="opex-comment-meta"><strong>${escapeHtml(c.authorName||'Bruker')}</strong><span>${escapeHtml(formatCommentTime(c.createdAt))}</span></div><div class="opex-comment-text">${escapeHtml(c.text)}</div></div>`).join(''):'<div class="opex-comment-empty">Ingen kommentarer ennå.</div>';container.scrollTop=container.scrollHeight;}
  async function mountComments(taskId){stopComments();if(!taskId)return;const grid=document.querySelector('#modal .formgrid')||document.querySelector('.modalbody .formgrid');if(!grid)return;const section=document.createElement('section');section.id='opexComments';section.className='opex-comments';section.innerHTML=`<div class="opex-comments-head"><strong>💬 Kommentarer / ny informasjon</strong><span>Historikk lagres med bruker og tidspunkt</span></div><div class="opex-comment-compose"><textarea id="opexCommentText" placeholder="Skriv kommentar eller ny informasjon…" maxlength="1200"></textarea><button type="button" class="btn primary" id="opexAddComment">Legg til</button></div><div class="opex-comment-list" id="opexCommentList"><div class="opex-comment-empty">Laster kommentarer…</div></div>`;grid.appendChild(section);const ref=firebase.database().ref(`/taskComments/${taskId}`);const handler=snap=>renderCommentItems(section.querySelector('#opexCommentList'),snap.val());ref.on('value',handler);stopCommentListener=()=>ref.off('value',handler);section.querySelector('#opexAddComment')?.addEventListener('click',async()=>{const textarea=section.querySelector('#opexCommentText');const text=String(textarea?.value||'').trim();const user=currentUser();if(!text||!user)return;const button=section.querySelector('#opexAddComment');button.disabled=true;try{await ref.push({text,authorUid:user.uid,authorName:USER_NAMES[user.uid]||user.email||'Bruker',createdAt:new Date().toISOString()});textarea.value='';}finally{button.disabled=false;}});}

  function installCommentModalHook(){
    if(document.documentElement.dataset.opexCommentModalHook==='true')return true;
    document.documentElement.dataset.opexCommentModalHook='true';
    const observer=new MutationObserver(()=>{
      const modal=document.getElementById('modal');
      if(!modal?.classList.contains('open')){if(activeTaskId){activeTaskId=null;stopComments();}return;}
      if(document.getElementById('opexComments'))return;
      const candidate=document.getElementById('m_id')?.value||modal.dataset.taskId||'';
      setTimeout(async()=>{
        if(document.getElementById('opexComments'))return;
        activeTaskId=await resolveTaskId(candidate);
        if(activeTaskId)await mountComments(activeTaskId);
      },40);
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','value']});
    return true;
  }
  function installOpenModalWrapper(){
    if(typeof window.openModal!=='function')return false;
    if(window.openModal.__opexCommentsHook)return true;
    const original=window.openModal;
    const wrapped=function wrappedOpenModal(...args){
      const result=original.apply(this,args);
      suppressLegacyAdminWarning();
      activeTaskId=null;
      setTimeout(async()=>{activeTaskId=await resolveTaskId(args[0]);await mountComments(activeTaskId);},80);
      return result;
    };
    wrapped.__opexCommentsHook=true;
    wrapped.__opexV1H=true;
    window.openModal=wrapped;
    return true;
  }
  function installSaveWrapper(){if(typeof window.saveTask!=='function'||window.saveTask.__opexV1F)return false;const original=window.saveTask;const wrapped=function wrappedSaveTask(...args){const status=document.getElementById('m_status')?.value?.trim();const title=document.getElementById('m_tittel')?.value?.trim();const shouldCelebrate=status==='Fullført'&&Boolean(title);const result=original.apply(this,args);if(shouldCelebrate){setTimeout(()=>{const modalClosed=!document.getElementById('modal')?.classList.contains('open');if(modalClosed)celebrateCompleted(`${title} er fullført. Sterkt jobbet! 💪`);},700);}return result;};wrapped.__opexV1F=true;window.saveTask=wrapped;return true;}

  let attempts=0;const boot=()=>{attempts+=1;installEnhancementStyles();suppressLegacyAdminWarning();installTrashClickGuard();installOutsideMenuClose();installCommentModalHook();const menuReady=installUserMenuPreference();const openReady=installOpenModalWrapper();const saveReady=installSaveWrapper();if((!menuReady||!openReady||!saveReady)&&attempts<80)setTimeout(boot,250);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
