(() => {
  'use strict';

  const VAPID_KEY = 'BGZHOWnnMHSGeBnC3pETHWRAu84UFL7yBZBq74Uxoc2xAfBPySP3XuTolheQHJqG_CxgZYNX6-hSZuA5XHDqJXc';
  const MESSAGING_SDK = 'https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js';
  const TOKEN_STORAGE_KEY = 'opex_fcm_token_v1';
  const TOKEN_SYNC_KEY = 'opex_fcm_token_synced_v1';
  let messaging = null;
  let initPromise = null;

  function installMobileHeaderFix() {
    if (document.getElementById('opex-mobile-header-fix')) return;
    const style = document.createElement('style');
    style.id = 'opex-mobile-header-fix';
    style.textContent = `
@media (max-width:820px), (orientation:landscape) and (max-height:600px) and (max-width:1180px) {
  nav{height:auto!important;min-height:0!important;display:flex!important;align-items:center!important;flex-wrap:wrap!important;gap:6px 8px!important;padding:8px 10px!important;overflow:visible!important;z-index:200!important;}
  .brand{order:1!important;flex:1 1 calc(100% - 52px)!important;min-width:0!important;max-width:calc(100% - 52px)!important;overflow:hidden!important;}
  .brand div{min-width:0!important;overflow:hidden!important}.brand small{max-width:100%!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
  .userbox{order:2!important;display:flex!important;position:relative!important;flex:0 0 auto!important;margin-left:auto!important;z-index:220!important;}
  .tabs{order:3!important;position:static!important;display:flex!important;flex:0 0 100%!important;width:100%!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;overflow-x:auto!important;overflow-y:hidden!important;gap:4px!important;padding:4px 0 1px!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;backdrop-filter:none!important;scrollbar-width:none!important;z-index:auto!important;}
  .tabs::-webkit-scrollbar{display:none!important}
  .tab{flex:0 0 auto!important;min-height:46px!important;padding:7px 10px!important;font-size:10px!important;line-height:1.15!important;white-space:nowrap!important;}
  .dropdown{position:fixed!important;display:none!important;top:62px!important;right:8px!important;left:auto!important;width:min(290px,calc(100vw - 16px))!important;max-width:calc(100vw - 16px)!important;max-height:calc(100dvh - 76px)!important;overflow-y:auto!important;z-index:9999!important;}
  .dropdown.open{display:block!important} main{padding-bottom:calc(28px + env(safe-area-inset-bottom))!important}
}
`;
    document.head.appendChild(style);
  }

  function notify(message, error = false) {
    if (typeof window.toast === 'function') return window.toast(message, error);
    console[error ? 'error' : 'log']('[OpEx Push]', message);
  }

  function loadCommentsModule() {
    if (document.querySelector('script[data-opex-comments-v1]')) return;
    const script = document.createElement('script');
    script.src = './comments-v1.js?v=33';
    script.async = true;
    script.dataset.opexCommentsV1 = 'true';
    script.onerror = () => console.error('[OpEx] Kunne ikke laste comments-v1.js');
    document.head.appendChild(script);
  }

  function loadMessagingSdk() {
    if (window.firebase?.messaging) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${MESSAGING_SDK}"]`);
      if (existing) {
        if (window.firebase?.messaging) return resolve();
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = MESSAGING_SDK;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Kunne ikke laste Firebase Messaging SDK'));
      document.head.appendChild(script);
    });
  }

  async function tokenKey(token) {
    if (window.crypto?.subtle) {
      const bytes = new TextEncoder().encode(token);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return btoa(token).replace(/[.#$\[\]/]/g, '_').slice(0, 120);
  }

  async function saveToken(token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(TOKEN_SYNC_KEY, 'false');
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Ingen innlogget bruker');
    const key = await tokenKey(token);
    const payload = {token,uid:user.uid,email:user.email || '',userAgent:navigator.userAgent,platform:navigator.userAgentData?.platform || navigator.platform || '',permission:Notification.permission,updatedAt:new Date().toISOString(),appVersion:'push-v1a'};
    await firebase.database().ref(`pushTokens/${user.uid}/${key}`).set(payload);
    localStorage.setItem(TOKEN_SYNC_KEY, 'true');
  }

  function updateButtons() {
    const enable = document.getElementById('pushEnableButton');
    const copy = document.getElementById('pushCopyButton');
    if (!enable) return;
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!('Notification' in window)) {enable.textContent='🔕 Push støttes ikke her';enable.disabled=true;if(copy)copy.style.display='none';return;}
    if (Notification.permission === 'granted' && token) {enable.textContent=localStorage.getItem(TOKEN_SYNC_KEY)==='true'?'🔔 Varsler er aktivert':'🔔 Varsler aktivert – synkroniser';if(copy)copy.style.display='block';}
    else if (Notification.permission === 'denied') {enable.textContent='🔕 Varsler er blokkert i nettleseren';if(copy)copy.style.display=token?'block':'none';}
    else {enable.textContent='🔔 Aktiver varsler';if(copy)copy.style.display=token?'block':'none';}
  }

  function ensureButtons() {
    const dropdown = document.getElementById('drop');
    if (!dropdown || document.getElementById('pushEnableButton')) return;
    const enable = document.createElement('button'); enable.id='pushEnableButton'; enable.className='dropitem'; enable.type='button'; enable.onclick=event=>{event.stopPropagation();enablePushNotifications();};
    const copy = document.createElement('button'); copy.id='pushCopyButton'; copy.className='dropitem'; copy.type='button'; copy.textContent='🧪 Kopier push-token'; copy.style.display='none'; copy.onclick=event=>{event.stopPropagation();copyPushToken();};
    const admin = document.getElementById('adminDrop'); dropdown.insertBefore(enable,admin||null); dropdown.insertBefore(copy,admin||null); updateButtons();
  }

  async function initMessaging() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!window.isSecureContext) throw new Error('Push krever HTTPS');
      if (!('serviceWorker' in navigator)) throw new Error('Service Worker støttes ikke');
      if (!('Notification' in window)) throw new Error('Varsler støttes ikke i denne nettleseren');
      await loadMessagingSdk(); messaging = firebase.messaging();
      messaging.onMessage(payload => {const title=payload?.notification?.title||payload?.data?.title||'OpEx Hub';const body=payload?.notification?.body||payload?.data?.body||'Du har et nytt varsel.';notify(`${title}: ${body}`);});
      return messaging;
    })().catch(error => {initPromise=null;throw error;});
    return initPromise;
  }

  async function enablePushNotifications() {
    try {
      if (!firebase.auth().currentUser) return notify('Logg inn før du aktiverer varsler.', true);
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {updateButtons();return notify(permission==='denied'?'Varsler er blokkert. Tillat varsler i nettleserinnstillingene.':'Varsler ble ikke aktivert.', true);}
      const instance=await initMessaging(); const registration=await navigator.serviceWorker.ready; const token=await instance.getToken({vapidKey:VAPID_KEY,serviceWorkerRegistration:registration});
      if (!token) throw new Error('Firebase returnerte ikke et push-token');
      try {await saveToken(token);notify('Push-varsler er aktivert på denne enheten 🔔');}
      catch(syncError){localStorage.setItem(TOKEN_STORAGE_KEY,token);localStorage.setItem(TOKEN_SYNC_KEY,'false');notify('Push er aktivert lokalt, men token kunne ikke lagres i Firebase. Test-token kan fortsatt kopieres.',true);console.error('[OpEx Push] Token sync failed:',syncError);}
      updateButtons();
    } catch(error){console.error('[OpEx Push] Activation failed:',error);notify('Kunne ikke aktivere push: '+(error?.message||'ukjent feil'),true);updateButtons();}
  }

  async function copyPushToken() {
    const token=localStorage.getItem(TOKEN_STORAGE_KEY); if(!token)return notify('Ingen push-token er registrert på denne enheten ennå.',true);
    try{await navigator.clipboard.writeText(token);notify('Push-token kopiert ✓');}catch{window.prompt('Kopier push-token:',token);}
  }

  async function refreshExistingToken(user) {
    if (!user || Notification.permission !== 'granted') return;
    const existing=localStorage.getItem(TOKEN_STORAGE_KEY); if(!existing)return;
    try{await saveToken(existing);}catch(error){console.warn('[OpEx Push] Existing token could not be synced:',error);} updateButtons();
  }

  function bootPush() {
    installMobileHeaderFix();
    loadCommentsModule();
    ensureButtons();
    if (!window.firebase?.auth) return;
    firebase.auth().onAuthStateChanged(user => {if(user){ensureButtons();refreshExistingToken(user);}updateButtons();});
  }

  window.enablePushNotifications = enablePushNotifications;
  window.copyPushToken = copyPushToken;
  window.__opexPushV1A = { enablePushNotifications, copyPushToken };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPush, { once: true });
  else bootPush();
})();
