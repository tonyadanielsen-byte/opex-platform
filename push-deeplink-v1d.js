(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const taskId = params.get('openTask');
  if (!taskId) return;

  let attempts = 0;
  const openWhenReady = () => {
    attempts += 1;
    const hasTask = Array.isArray(window.tasks) ? window.tasks.some(t => t && t.fbKey === taskId) : true;
    if (typeof window.openModal === 'function' && hasTask) {
      try {
        if (typeof window.show === 'function') window.show('alle');
        window.openModal(taskId);
        const clean = new URL(location.href);
        clean.searchParams.delete('openTask');
        history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
        return;
      } catch (error) {
        console.warn('[OpEx Push] Deep-link open failed, retrying', error);
      }
    }
    if (attempts < 40) setTimeout(openWhenReady, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openWhenReady, { once: true });
  else openWhenReady();
})();
