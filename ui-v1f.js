(() => {
  'use strict';

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

  function showTrashConfirmation(onConfirm) {
    document.querySelector('.opex-confirm-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'opex-confirm-layer';
    layer.innerHTML = `
      <div class="opex-confirm-card" role="dialog" aria-modal="true" aria-labelledby="opexTrashConfirmTitle">
        <h3 id="opexTrashConfirmTitle">Flytte tiltaket til papirkurv?</h3>
        <p>Tiltaket fjernes fra aktive visninger, men kan gjenopprettes senere av administrator.</p>
        <label class="opex-confirm-remember">
          <input type="checkbox" id="opexTrashDontAsk">
          <span>Ikke spør meg igjen på denne enheten</span>
        </label>
        <div class="opex-confirm-actions">
          <button type="button" class="btn secondary" data-confirm-cancel>Avbryt</button>
          <button type="button" class="btn danger" data-confirm-ok>Flytt til papirkurv</button>
        </div>
      </div>`;
    document.body.appendChild(layer);

    const close = () => layer.remove();
    layer.querySelector('[data-confirm-cancel]')?.addEventListener('click', close);
    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    layer.querySelector('[data-confirm-ok]')?.addEventListener('click', () => {
      const dontAsk = Boolean(layer.querySelector('#opexTrashDontAsk')?.checked);
      localStorage.setItem('opex_confirm_trash', dontAsk ? 'false' : 'true');
      close();
      onConfirm(dontAsk);
    });
  }

  function installTrashWrapper() {
    if (typeof window.moveToTrash !== 'function' || window.moveToTrash.__opexV1H) return false;
    const original = window.moveToTrash;
    const wrapped = function wrappedMoveToTrash(...args) {
      const confirmationEnabled = localStorage.getItem('opex_confirm_trash') !== 'false';
      if (!confirmationEnabled) return original.apply(this, args);

      showTrashConfirmation(() => {
        const previous = localStorage.getItem('opex_confirm_trash');
        localStorage.setItem('opex_confirm_trash', 'false');
        try {
          original.apply(this, args);
        } finally {
          if (previous === null) localStorage.removeItem('opex_confirm_trash');
          else localStorage.setItem('opex_confirm_trash', previous);
        }
      });
    };
    wrapped.__opexV1H = true;
    window.moveToTrash = wrapped;
    return true;
  }

  function installOpenModalWrapper() {
    if (typeof window.openModal !== 'function' || window.openModal.__opexV1H) return false;
    const original = window.openModal;
    const wrapped = function wrappedOpenModal(...args) {
      const result = original.apply(this, args);
      suppressLegacyAdminWarning();
      return result;
    };
    wrapped.__opexV1H = true;
    window.openModal = wrapped;
    return true;
  }

  function installSaveWrapper() {
    if (typeof window.saveTask !== 'function' || window.saveTask.__opexV1F) return false;
    const original = window.saveTask;
    const wrapped = function wrappedSaveTask(...args) {
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
    wrapped.__opexV1F = true;
    window.saveTask = wrapped;
    return true;
  }

  let attempts = 0;
  const boot = () => {
    attempts += 1;
    suppressLegacyAdminWarning();
    const openReady = installOpenModalWrapper();
    const trashReady = installTrashWrapper();
    const saveReady = installSaveWrapper();
    if ((!openReady || !trashReady || !saveReady) && attempts < 40) setTimeout(boot, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
