(() => {
  'use strict';

  const TRASH_CONFIRM_KEY = 'opex_confirm_trash';
  const bypassTrashButtons = new WeakSet();

  function installEnhancementStyles() {
    if (document.getElementById('opexUserPreferenceStyles')) return;
    const style = document.createElement('style');
    style.id = 'opexUserPreferenceStyles';
    style.textContent = `
      .opex-menu-preference{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 14px;border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08);color:#e8ebf7;cursor:default}
      .opex-menu-pref-copy{display:flex;align-items:center;gap:9px;min-width:0;font-size:13px;line-height:1.25}.opex-menu-pref-icon{flex:0 0 auto}.opex-menu-switch{position:relative;display:inline-flex;flex:0 0 auto;margin:0!important;cursor:pointer}.opex-menu-switch input{position:absolute;opacity:0;pointer-events:none}.opex-menu-switch span{display:block;width:38px;height:22px;border-radius:999px;background:#65708b;position:relative;transition:.18s ease;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}.opex-menu-switch span:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:.18s ease}.opex-menu-switch input:checked+span{background:linear-gradient(135deg,#765df2,#4e87f2)}.opex-menu-switch input:checked+span:after{transform:translateX(16px)}.opex-confirm-card p{margin-bottom:19px!important}
    `;
    document.head.appendChild(style);
  }

  function celebrateCompleted(title) {
    document.querySelector('.opex-celebration')?.remove();
    const layer = document.createElement('div');
    layer.className = 'opex-celebration';
    layer.innerHTML = `<div class="opex-celebration-card"><div class="opex-celebration-icon">🎉</div><strong>Tiltaket er i mål!</strong><span>${String(title || 'Sterkt jobbet!')}</span></div>`;
    const card = layer.firstElementChild;
    const colors = ['#765df2','#3d8cd8','#31b887','#f1b84b','#ef6b72'];
    for (let i = 0; i < 18; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'opex-confetti';
      piece.style.color = colors[i % colors.length];
      const angle = (Math.PI * 2 * i) / 18;
      const distance = 95 + (i % 5) * 18;
      piece.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
      piece.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
      piece.style.setProperty('--r', `${180 + i * 37}deg`);
      card.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1800);
  }

  function suppressLegacyAdminWarning() {
    const warning = document.getElementById('adminWarning');
    if (warning) warning.style.setProperty('display', 'none', 'important');
  }

  function syncNextStepField(isExistingTask) {
    const field = document.getElementById('m_nestesteg');
    const row = field?.closest('.full');
    if (!field || !row) return;
    row.style.display = isExistingTask ? 'none' : '';
    field.required = !isExistingTask;
    field.setAttribute('aria-required', String(!isExistingTask));
    const label = row.querySelector('label');
    if (label) label.textContent = isExistingTask ? 'Neste steg' : 'Neste steg *';
  }

  function trashConfirmationEnabled() {
    return localStorage.getItem(TRASH_CONFIRM_KEY) !== 'false';
  }

  function setTrashConfirmationEnabled(enabled) {
    localStorage.setItem(TRASH_CONFIRM_KEY, enabled ? 'true' : 'false');
    syncTrashPreferenceControl();
  }

  function showTrashConfirmation(onConfirm) {
    document.querySelector('.opex-confirm-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'opex-confirm-layer';
    layer.innerHTML = `<div class="opex-confirm-card" role="dialog" aria-modal="true" aria-labelledby="opexTrashConfirmTitle"><h3 id="opexTrashConfirmTitle">Flytte tiltaket til papirkurv?</h3><p>Tiltaket fjernes fra aktive visninger, men kan gjenopprettes senere av administrator.</p><div class="opex-confirm-actions"><button type="button" class="btn secondary" data-confirm-cancel>Avbryt</button><button type="button" class="btn danger" data-confirm-ok>Flytt til papirkurv</button></div></div>`;
    document.body.appendChild(layer);
    const close = () => layer.remove();
    layer.querySelector('[data-confirm-cancel]')?.addEventListener('click', close);
    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    layer.querySelector('[data-confirm-ok]')?.addEventListener('click', () => { close(); onConfirm(); });
  }

  function isTrashButton(element) {
    const button = element?.closest?.('button');
    if (!button) return null;
    const text = String(button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text.includes('flytt til papirkurv') ? button : null;
  }

  function installTrashClickGuard() {
    if (document.documentElement.dataset.opexTrashGuard === 'true') return;
    document.documentElement.dataset.opexTrashGuard = 'true';
    document.addEventListener('click', event => {
      const button = isTrashButton(event.target);
      if (!button) return;
      if (bypassTrashButtons.has(button)) {
        bypassTrashButtons.delete(button);
        return;
      }
      if (!trashConfirmationEnabled()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showTrashConfirmation(() => {
        bypassTrashButtons.add(button);
        button.click();
      });
    }, true);
  }

  function syncTrashPreferenceControl() {
    const input = document.getElementById('opexTrashPreference');
    if (input) input.checked = trashConfirmationEnabled();
  }

  function installUserMenuPreference() {
    const menu = document.querySelector('.dropdown');
    if (!menu) return false;
    if (!document.getElementById('opexTrashPreferenceRow')) {
      const row = document.createElement('div');
      row.id = 'opexTrashPreferenceRow';
      row.className = 'opex-menu-preference';
      row.innerHTML = `<div class="opex-menu-pref-copy"><span class="opex-menu-pref-icon">🗑️</span><span>Bekreft før flytting til papirkurv</span></div><label class="opex-menu-switch" title="Bekreft før flytting til papirkurv"><input type="checkbox" id="opexTrashPreference" aria-label="Bekreft før flytting til papirkurv"><span aria-hidden="true"></span></label>`;
      const adminItem = Array.from(menu.children).find(el => String(el.textContent || '').trim().toLowerCase().includes('admin'));
      if (adminItem) menu.insertBefore(row, adminItem); else menu.appendChild(row);
      const input = row.querySelector('#opexTrashPreference');
      input?.addEventListener('change', event => setTrashConfirmationEnabled(Boolean(event.target.checked)));
      row.addEventListener('click', event => event.stopPropagation());
    }
    syncTrashPreferenceControl();
    return true;
  }

  function installOutsideMenuClose() {
    if (document.documentElement.dataset.opexMenuOutsideClose === 'true') return;
    document.documentElement.dataset.opexMenuOutsideClose = 'true';
    document.addEventListener('pointerdown', event => {
      const menu = document.querySelector('.dropdown.open');
      if (!menu) return;
      const userBox = menu.closest('.userbox');
      if (menu.contains(event.target) || userBox?.contains(event.target)) return;
      menu.classList.remove('open');
    });
  }

  function installOpenModalWrapper() {
    if (typeof window.openModal !== 'function') return false;
    if (window.openModal.__opexUiV35) return true;
    const original = window.openModal;
    const wrapped = function wrappedOpenModal(...args) {
      const result = original.apply(this, args);
      suppressLegacyAdminWarning();
      const isExistingTask = Boolean(String(args[0] || '').trim());
      syncNextStepField(isExistingTask);
      return result;
    };
    wrapped.__opexUiV35 = true;
    window.openModal = wrapped;
    return true;
  }

  function installSaveWrapper() {
    if (typeof window.saveTask !== 'function' || window.saveTask.__opexV35) return false;
    const original = window.saveTask;
    const wrapped = function wrappedSaveTask(...args) {
      const nextStep = document.getElementById('m_nestesteg');
      const nextStepVisible = nextStep?.closest('.full')?.style.display !== 'none';
      if (nextStepVisible && !String(nextStep?.value || '').trim()) {
        if (typeof window.toast === 'function') window.toast('Fyll ut Neste steg før tiltaket opprettes', true);
        nextStep?.focus();
        return;
      }

      const status = document.getElementById('m_status')?.value?.trim();
      const title = document.getElementById('m_tittel')?.value?.trim();
      const shouldCelebrate = status === 'Fullført' && Boolean(title);
      const result = original.apply(this, args);
      if (shouldCelebrate) {
        setTimeout(() => {
          const modalClosed = !document.getElementById('modal')?.classList.contains('open');
          if (modalClosed) celebrateCompleted(`${title} er fullført. Sterkt jobbet! 💪`);
        }, 700);
      }
      return result;
    };
    wrapped.__opexV35 = true;
    window.saveTask = wrapped;
    return true;
  }

  let attempts = 0;
  const boot = () => {
    attempts += 1;
    installEnhancementStyles();
    suppressLegacyAdminWarning();
    installTrashClickGuard();
    installOutsideMenuClose();
    const menuReady = installUserMenuPreference();
    const openReady = installOpenModalWrapper();
    const saveReady = installSaveWrapper();
    if ((!menuReady || !openReady || !saveReady) && attempts < 80) setTimeout(boot, 250);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
