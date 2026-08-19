(() => {
  'use strict';

  const FUNCTIONS_BASE = 'https://europe-west1-opex-nortura.cloudfunctions.net';
  let bootedUid = '';
  let currentItems = [];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('no-NO', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
  }

  function installStyles() {
    if (document.getElementById('opex-activity-styles-v1')) return;
    const style = document.createElement('style');
    style.id = 'opex-activity-styles-v1';
    style.textContent = `
      .opex-activity-overlay{position:fixed;inset:0;background:rgba(7,12,13,.55);backdrop-filter:blur(6px);z-index:12000;display:flex;align-items:flex-start;justify-content:center;padding:88px 18px 24px}
      .opex-activity-panel{width:min(660px,100%);max-height:min(720px,calc(100dvh - 116px));display:flex;flex-direction:column;background:linear-gradient(180deg,#fff,#f6f7f9);border:1px solid rgba(255,255,255,.7);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.34);overflow:hidden;color:#273047}
      .opex-activity-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 20px 14px;background:linear-gradient(135deg,#172d20,#244b30);color:#fff}
      .opex-activity-head h3{margin:0;font-size:19px}.opex-activity-head p{margin:4px 0 0;font-size:12px;color:#d3e0d5}.opex-activity-close{border:0;background:rgba(255,255,255,.12);color:#fff;width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:18px}
      .opex-activity-list{padding:12px;overflow:auto;display:grid;gap:8px}
      .opex-activity-item{border:1px solid #e2e5ea;background:#fff;border-radius:13px;padding:11px 13px;text-align:left;cursor:pointer;box-shadow:0 5px 14px rgba(34,43,63,.05)}
      .opex-activity-item:hover{border-color:#9fad91;background:#fbfcfa}.opex-activity-item strong{display:block;font-size:13px;color:#24324a;margin-bottom:4px}.opex-activity-item span{display:block;font-size:12px;line-height:1.42;color:#59657b}.opex-activity-item time{display:block;margin-top:6px;font-size:10px;color:#8a93a5}
      .opex-activity-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid #e1e4e8;background:#f7f8fa}.opex-activity-foot small{color:#7b8495}.opex-activity-mark{border:0;border-radius:10px;padding:9px 13px;font-weight:750;cursor:pointer;background:#667b23;color:#fff}
      @media(max-width:620px){.opex-activity-overlay{padding:72px 10px 12px}.opex-activity-panel{max-height:calc(100dvh - 88px);border-radius:16px}.opex-activity-head{padding:15px}.opex-activity-foot{align-items:stretch;flex-direction:column}.opex-activity-mark{width:100%}}
    `;
    document.head.appendChild(style);
  }

  async function callFunction(name, data) {
    const user = window.firebase?.auth?.()?.currentUser;
    if (!user) throw new Error('Ingen innlogget Firebase-bruker');
    const token = await user.getIdToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${FUNCTIONS_BASE}/${encodeURIComponent(name)}`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body:JSON.stringify({data}),
        signal:controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) throw new Error(payload?.error?.message || payload?.error?.status || `HTTP ${response.status}`);
      return payload?.result || payload?.data || {};
    } finally {
      clearTimeout(timeout);
    }
  }

  function closePanel() {
    document.getElementById('opexActivityOverlay')?.remove();
  }

  async function markSeen(ids) {
    const cleanIds = Array.from(new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean)));
    if (!cleanIds.length) return;
    await callFunction('markActivitySeenV1', {ids:cleanIds});
  }

  async function openActivity(item) {
    try { await markSeen([item.id]); } catch (error) { console.warn('[OpEx Activity] Kunne ikke markere lest:', error); }
    currentItems = currentItems.filter(row => row.id !== item.id);
    closePanel();
    const taskId = String(item.taskId || '').trim();
    if (taskId && typeof window.openModal === 'function') {
      window.openModal(taskId);
      return;
    }
    const link = String(item.link || '').trim();
    if (link) window.location.href = link;
  }

  function showPanel(items) {
    closePanel();
    currentItems = items.slice();
    const overlay = document.createElement('div');
    overlay.id = 'opexActivityOverlay';
    overlay.className = 'opex-activity-overlay';
    overlay.innerHTML = `<section class="opex-activity-panel" role="dialog" aria-modal="true" aria-label="Nytt siden sist"><header class="opex-activity-head"><div><h3>🔔 Nytt siden sist</h3><p>${items.length} ny${items.length === 1 ? '' : 'e'} oppdatering${items.length === 1 ? '' : 'er'} venter på deg</p></div><button type="button" class="opex-activity-close" aria-label="Lukk">×</button></header><div class="opex-activity-list">${items.map((item,index) => `<button type="button" class="opex-activity-item" data-index="${index}"><strong>${escapeHtml(item.title || 'Oppdatering')}</strong><span>${escapeHtml(item.body || '')}</span><time>${escapeHtml(formatTime(item.createdAt))}</time></button>`).join('')}</div><footer class="opex-activity-foot"><small>Lukk vinduet hvis du vil beholde varslingene som uleste.</small><button type="button" class="opex-activity-mark">Marker alle som lest</button></footer></section>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.opex-activity-close')?.addEventListener('click', closePanel);
    overlay.addEventListener('click', event => { if (event.target === overlay) closePanel(); });
    overlay.querySelectorAll('.opex-activity-item').forEach(button => {
      button.addEventListener('click', () => {
        const item = items[Number(button.dataset.index)];
        if (item) openActivity(item);
      });
    });
    overlay.querySelector('.opex-activity-mark')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Markerar…';
      try {
        await markSeen(items.map(item => item.id));
        currentItems = [];
        closePanel();
        if (typeof window.toast === 'function') window.toast('Oppdateringer markert som lest ✓');
      } catch (error) {
        console.error('[OpEx Activity] Mark all failed:', error);
        button.disabled = false;
        button.textContent = 'Marker alle som lest';
        if (typeof window.toast === 'function') window.toast('Kunne ikke markere varslinger som lest.', true);
      }
    });
  }

  async function loadUnread(user) {
    if (!user || bootedUid === user.uid) return;
    bootedUid = user.uid;
    try {
      const result = await callFunction('getActivityInboxV1', {});
      const unread = (Array.isArray(result.items) ? result.items : []).filter(item => !item?.seenAt);
      if (unread.length) showPanel(unread);
    } catch (error) {
      console.error('[OpEx Activity] Load failed:', error);
      bootedUid = '';
    }
  }

  function boot() {
    installStyles();
    if (!window.firebase?.auth) { setTimeout(boot,100); return; }
    firebase.auth().onAuthStateChanged(user => {
      if (!user) { bootedUid = ''; closePanel(); return; }
      setTimeout(() => loadUnread(user), 350);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
