(() => {
  'use strict';

  const FUNCTIONS_SDK = 'https://www.gstatic.com/firebasejs/9.23.0/firebase-functions-compat.js';
  let functionsPromise = null;

  function installStyles() {
    if (document.getElementById('opex-comments-styles-v1')) return;
    const style = document.createElement('style');
    style.id = 'opex-comments-styles-v1';
    style.textContent = `
      .opex-comments{grid-column:1/-1;margin-top:6px;padding-top:14px;border-top:1px solid rgba(73,78,105,.13)}
      .opex-comments-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:9px}
      .opex-comments-head strong{font-size:13px;color:#29324e}.opex-comments-head span{font-size:11px;color:#7a839d;text-align:right}
      .opex-comment-compose{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
      .opex-comment-compose textarea{min-height:58px!important;max-height:120px;resize:vertical}
      .opex-comment-compose button{min-height:42px;white-space:nowrap}
      .opex-comment-list{display:grid;gap:7px;margin-top:10px;max-height:190px;overflow:auto}
      .opex-comment{padding:9px 11px;border-radius:11px;background:#f5f6fb;border:1px solid rgba(70,78,120,.10)}
      .opex-comment-meta{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:10px;color:#78819a}
      .opex-comment-meta strong{font-size:11px;color:#4c5673}.opex-comment-text{font-size:12px;line-height:1.45;color:#29324e;white-space:pre-wrap;overflow-wrap:anywhere}
      .opex-comment-empty{font-size:11px;color:#858da3;padding:6px 2px}
      @media(max-width:620px){.opex-comments-head{display:block}.opex-comments-head span{display:block;margin-top:3px;text-align:left}.opex-comment-compose{grid-template-columns:1fr}.opex-comment-compose button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  function formatCommentTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('no-NO', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  function stopComments() {
    document.getElementById('opexComments')?.remove();
  }

  function renderCommentItems(container, rows) {
    const comments = Array.isArray(rows) ? rows.slice().sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''))) : [];
    container.innerHTML = comments.length
      ? comments.map(comment => `<div class="opex-comment"><div class="opex-comment-meta"><strong>${escapeHtml(comment.authorName || 'Bruker')}</strong><span>${escapeHtml(formatCommentTime(comment.createdAt))}</span></div><div class="opex-comment-text">${escapeHtml(comment.text)}</div></div>`).join('')
      : '<div class="opex-comment-empty">Ingen kommentarer ennå.</div>';
    container.scrollTop = container.scrollHeight;
  }

  function loadFunctionsSdk() {
    if (window.firebase?.functions) return Promise.resolve();
    if (functionsPromise) return functionsPromise;
    functionsPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${FUNCTIONS_SDK}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = FUNCTIONS_SDK;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Kunne ikke laste Firebase Functions SDK'));
      document.head.appendChild(script);
    }).catch(error => {
      functionsPromise = null;
      throw error;
    });
    return functionsPromise;
  }

  async function callFunction(name, data) {
    await loadFunctionsSdk();
    const fn = firebase.app().functions('europe-west1').httpsCallable(name);
    const result = await fn(data);
    return result?.data || {};
  }

  async function loadComments(taskId, container) {
    container.innerHTML = '<div class="opex-comment-empty">Laster kommentarer…</div>';
    try {
      const result = await callFunction('getTaskCommentsV1', { taskId });
      renderCommentItems(container, result.comments || []);
    } catch (error) {
      console.error('[OpEx Comments] Load failed:', error);
      container.innerHTML = '<div class="opex-comment-empty">Kunne ikke laste kommentarer. Prøv å lukke og åpne tiltaket igjen.</div>';
      if (typeof window.toast === 'function') window.toast('Kunne ikke laste kommentarer: ' + (error?.message || 'ukjent feil'), true);
    }
  }

  function mountComments(taskId) {
    stopComments();
    if (!taskId) return;

    const grid = document.querySelector('#modal .formgrid');
    if (!grid) return;

    const section = document.createElement('section');
    section.id = 'opexComments';
    section.className = 'opex-comments';
    section.innerHTML = `<div class="opex-comments-head"><strong>💬 Kommentarer / ny informasjon</strong><span>Historikk lagres med bruker og tidspunkt</span></div><div class="opex-comment-compose"><textarea id="opexCommentText" placeholder="Skriv kommentar eller ny informasjon…" maxlength="1200"></textarea><button type="button" class="btn primary" id="opexAddComment">Legg til</button></div><div class="opex-comment-list" id="opexCommentList"><div class="opex-comment-empty">Laster kommentarer…</div></div>`;
    grid.appendChild(section);

    const list = section.querySelector('#opexCommentList');
    loadComments(taskId, list);

    section.querySelector('#opexAddComment')?.addEventListener('click', async () => {
      const textarea = section.querySelector('#opexCommentText');
      const text = String(textarea?.value || '').trim();
      if (!text) return;

      const button = section.querySelector('#opexAddComment');
      button.disabled = true;
      button.textContent = 'Lagrer…';
      try {
        await callFunction('addTaskCommentV1', { taskId, text });
        textarea.value = '';
        await loadComments(taskId, list);
        if (typeof window.toast === 'function') window.toast('Kommentar lagt til ✓');
      } catch (error) {
        console.error('[OpEx Comments] Save failed:', error);
        if (typeof window.toast === 'function') window.toast('Kunne ikke lagre kommentaren: ' + (error?.message || 'ukjent feil'), true);
      } finally {
        button.disabled = false;
        button.textContent = 'Legg til';
      }
    });
  }

  function installHooks() {
    installStyles();

    if (typeof window.openModal !== 'function') {
      setTimeout(installHooks, 100);
      return;
    }

    if (!window.openModal.__opexCommentsV1) {
      const originalOpenModal = window.openModal;
      const wrappedOpenModal = function (...args) {
        const result = originalOpenModal.apply(this, args);
        const taskId = String(args[0] || '').trim();
        setTimeout(() => mountComments(taskId), 0);
        return result;
      };
      wrappedOpenModal.__opexCommentsV1 = true;
      window.openModal = wrappedOpenModal;
    }

    if (typeof window.closeModal === 'function' && !window.closeModal.__opexCommentsV1) {
      const originalCloseModal = window.closeModal;
      const wrappedCloseModal = function (...args) {
        stopComments();
        return originalCloseModal.apply(this, args);
      };
      wrappedCloseModal.__opexCommentsV1 = true;
      window.closeModal = wrappedCloseModal;
    }
  }

  installHooks();
})();
