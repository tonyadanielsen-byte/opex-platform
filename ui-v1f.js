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
    if (!installSaveWrapper() && attempts < 40) setTimeout(boot, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
