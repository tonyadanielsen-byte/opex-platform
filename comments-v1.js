(() => {
  'use strict';

  const FUNCTIONS_BASE = 'https://europe-west1-opex-nortura.cloudfunctions.net';
  const ADMIN_UID = 'TJKI3zlDKSR7jvFXksVFgEgjS432';

  function installStyles() {
    if (document.getElementById('opex-comments-styles-v1')) return;
    const style = document.createElement('style');
    style.id = 'opex-comments-styles-v1';
    style.textContent = `
      .opex-comments{grid-column:1/-1;margin-top:6px;padding-top:14px;border-top:1px solid rgba(73,78,105,.13)}
      .opex-comments-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:9px}
      .opex-comments-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.opex-comments-head strong{font-size:13px;color:#29324e}.opex-comments-head span{font-size:11px;color:#7a839d;text-align:right}
      .opex-comment-sort{font-size:11px!important;padding:5px 8px!important;border-radius:8px!important;min-height:0!important;color:#4c5673!important;background:#fff!important}
      .opex-comment-compose{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
      .opex-comment-compose textarea{min-height:58px!important;max-height:120px;resize:vertical}
      .opex-comment-compose button{min-height:42px;white-space:nowrap}
      .opex-comment-list{display:grid;gap:7px;margin-top:10px;max-height:220px;overflow:auto}
      .opex-comment{position:relative;padding:9px 42px 9px 11px;border-radius:11px;background:#f5f6fb;border:1px solid rgba(70,78,120,.10)}
      .opex-comment-meta{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:10px;color:#78819a}
      .opex-comment-meta strong{font-size:11px;color:#4c5673}.opex-comment-text{font-size:12px;line-height:1.45;color:#29324e;white-space:pre-wrap;overflow-wrap:anywhere}
      .opex-comment-delete{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:28px;height:28px;min-height:28px!important;padding:0!important;display:grid;place-items:center;border-radius:8px;border:1px solid rgba(190,56,68,.16);background:rgba(255,255,255,.72);color:#b63a48;cursor:pointer;opacity:.62;transition:.16s ease;font-size:13px;line-height:1}
      .opex-comment:hover .opex-comment-delete,.opex-comment-delete:focus{opacity:1;background:#fff1f3;border-color:rgba(190,56,68,.34);box-shadow:0 4px 12px rgba(118,38,51,.10)}
      .opex-comment-delete:disabled{opacity:.38;cursor:wait}
      .opex-comment-empty{font-size:11px;color:#858da3;padding:6px 2px}
      .opex-comment-error{font-size:11px;color:#b6424b;padding:8px 10px;border-radius:9px;background:#fff0f0;border:1px solid #f2c3c6}
      .opex-comment-confirm{position:fixed;inset:0;z-index:14000;display:grid;place-items:center;padding:18px;background:rgba(18,24,48,.44);backdrop-filter:blur(7px)}
      .opex-comment-confirm-card{width:min(390px,100%);padding:20px;border-radius:18px;background:linear-gradient(145deg,#fff,#f7f8ff);border:1px solid rgba(76,88,144,.15);box-shadow:0 28px 80px rgba(35,42,82,.28);color:#202947}
      .opex-comment-confirm-card h3{margin:0 0 7px;font-size:17px}.opex-comment-confirm-card p{margin:0 0 17px;color:#6b748e;font-size:12px;line-height:1.45}.opex-comment-confirm-actions{display:grid;grid-template-columns:1fr 1.2fr;gap:8px}.opex-comment-confirm-actions .btn{min-height:40px}
      @media(max-width:620px){.opex-comments-head{display:block}.opex-comments-head span{display:block;margin-top:5px;text-align:left}.opex-comment-compose{grid-template-columns:1fr}.opex-comment-compose button{width:100%}.opex-comments-title{justify-content:space-between}.opex-comment-sort{max-width:145px}.opex-comment{padding-right:40px}}
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  function formatCommentTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('no-NO', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
  }

  function currentUid() {
    return String(window.firebase?.auth?.()?.currentUser?.uid || 'anonymous');
  }

  function sortStorageKey() {
    return `opex_comment_sort_v1_${currentUid()}`;
  }

  function getSortOrder() {
    const value = localStorage.getItem(sortStorageKey());
    return value === 'oldest' ? 'oldest' : 'newest';
  }

  function setSortOrder(value) {
    localStorage.setItem(sortStorageKey(), value === 'oldest' ? 'oldest' : 'newest');
  }

  function stopComments() {
    document.getElementById('opexComments')?.remove();
    document.querySelector('.opex-comment-confirm')?.remove();
  }

  function canDelete(comment) {
    const uid = currentUid();
    return uid !== 'anonymous' && (uid === ADMIN_UID || uid === String(comment?.authorUid || ''));
  }

  function renderCommentItems(container, rows, sortOrder = getSortOrder()) {
    const comments = Array.isArray(rows) ? rows.slice() : [];
    comments.sort((a,b) => {
      const left = String(a?.createdAt || '');
      const right = String(b?.createdAt || '');
      return sortOrder === 'oldest' ? left.localeCompare(right) : right.localeCompare(left);
    });
    container.__opexCommentRows = Array.isArray(rows) ? rows.slice() : [];
    container.innerHTML = comments.length
      ? comments.map(comment => {
          const deleteButton = canDelete(comment)
            ? `<button type="button" class="opex-comment-delete" data-comment-id="${escapeHtml(comment.id)}" title="Slett kommentar" aria-label="Slett kommentar">🗑</button>`
            : '';
          return `<div class="opex-comment" data-comment-id="${escapeHtml(comment.id)}"><div class="opex-comment-meta"><strong>${escapeHtml(comment.authorName || 'Bruker')}</strong><span>${escapeHtml(formatCommentTime(comment.createdAt))}</span></div><div class="opex-comment-text">${escapeHtml(comment.text)}</div>${deleteButton}</div>`;
        }).join('')
      : '<div class="opex-comment-empty">Ingen kommentarer ennå.</div>';
    container.scrollTop = sortOrder === 'oldest' ? container.scrollHeight : 0;
  }

  async function callFunction(name, data) {
    const user = window.firebase?.auth?.()?.currentUser;
    if (!user) throw new Error('Ingen innlogget Firebase-bruker');
    const token = await user.getIdToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${FUNCTIONS_BASE}/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body: JSON.stringify({data}),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const detail = payload?.error?.message || payload?.error?.status || `HTTP ${response.status}`;
        throw new Error(detail);
      }
      return payload?.result || payload?.data || {};
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Kommentar-API svarte ikke innen 10 sekunder');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadComments(taskId, container, sortOrder = getSortOrder()) {
    container.innerHTML = '<div class="opex-comment-empty">Laster kommentarer…</div>';
    try {
      const result = await callFunction('getTaskCommentsV1', {taskId});
      renderCommentItems(container, result.comments || [], sortOrder);
    } catch (error) {
      console.error('[OpEx Comments] Load failed:', {taskId,error});
      container.innerHTML = `<div class="opex-comment-error">Kunne ikke laste kommentarer · ${escapeHtml(error?.message || 'ukjent feil')}</div>`;
      if (typeof window.toast === 'function') window.toast('Kunne ikke laste kommentarer: ' + (error?.message || 'ukjent feil'), true);
    }
  }

  function confirmDelete(onConfirm) {
    document.querySelector('.opex-comment-confirm')?.remove();
    const layer = document.createElement('div');
    layer.className = 'opex-comment-confirm';
    layer.innerHTML = `<div class="opex-comment-confirm-card" role="dialog" aria-modal="true"><h3>Slett kommentar?</h3><p>Kommentaren fjernes permanent fra historikken. Denne handlingen kan ikke angres.</p><div class="opex-comment-confirm-actions"><button type="button" class="btn secondary" data-comment-cancel>Avbryt</button><button type="button" class="btn danger" data-comment-confirm>Slett kommentar</button></div></div>`;
    document.body.appendChild(layer);
    const close = () => layer.remove();
    layer.querySelector('[data-comment-cancel]')?.addEventListener('click', close);
    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    layer.querySelector('[data-comment-confirm]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Sletter…';
      try { await onConfirm(); close(); }
      catch (error) { button.disabled = false; button.textContent = 'Slett kommentar'; throw error; }
    });
  }

  function mountComments(taskId) {
    stopComments();
    if (!taskId) return;
    const grid = document.querySelector('#modal .formgrid');
    if (!grid) return;

    const selectedSort = getSortOrder();
    const section = document.createElement('section');
    section.id = 'opexComments';
    section.className = 'opex-comments';
    section.dataset.taskId = taskId;
    section.innerHTML = `<div class="opex-comments-head"><div class="opex-comments-title"><strong>💬 Kommentarer / ny informasjon</strong><select class="opex-comment-sort" id="opexCommentSort" aria-label="Sorter kommentarer"><option value="newest"${selectedSort === 'newest' ? ' selected' : ''}>Nyeste først</option><option value="oldest"${selectedSort === 'oldest' ? ' selected' : ''}>Eldste først</option></select></div><span>Historikk lagres med bruker og tidspunkt</span></div><div class="opex-comment-compose"><textarea id="opexCommentText" placeholder="Skriv kommentar eller ny informasjon…" maxlength="1200"></textarea><button type="button" class="btn primary" id="opexAddComment">Legg til</button></div><div class="opex-comment-list" id="opexCommentList"><div class="opex-comment-empty">Laster kommentarer…</div></div>`;
    grid.appendChild(section);

    const list = section.querySelector('#opexCommentList');
    const sortSelect = section.querySelector('#opexCommentSort');
    loadComments(taskId, list, selectedSort);

    sortSelect?.addEventListener('change', () => {
      const value = sortSelect.value === 'oldest' ? 'oldest' : 'newest';
      setSortOrder(value);
      renderCommentItems(list, list.__opexCommentRows || [], value);
    });

    list?.addEventListener('click', event => {
      const button = event.target?.closest?.('.opex-comment-delete');
      if (!button) return;
      const commentId = String(button.dataset.commentId || '').trim();
      if (!commentId) return;
      confirmDelete(async () => {
        try {
          await callFunction('deleteTaskCommentV1', {taskId,commentId});
          await loadComments(taskId, list, sortSelect?.value || getSortOrder());
          if (typeof window.toast === 'function') window.toast('Kommentar slettet ✓');
        } catch (error) {
          console.error('[OpEx Comments] Delete failed:', {taskId,commentId,error});
          if (typeof window.toast === 'function') window.toast('Kunne ikke slette kommentaren: ' + (error?.message || 'ukjent feil'), true);
          throw error;
        }
      });
    });

    section.querySelector('#opexAddComment')?.addEventListener('click', async () => {
      const textarea = section.querySelector('#opexCommentText');
      const text = String(textarea?.value || '').trim();
      if (!text) return;
      const button = section.querySelector('#opexAddComment');
      button.disabled = true;
      button.textContent = 'Lagrer…';
      try {
        await callFunction('addTaskCommentV1', {taskId,text});
        textarea.value = '';
        await loadComments(taskId, list, sortSelect?.value || getSortOrder());
        if (typeof window.toast === 'function') window.toast('Kommentar lagt til ✓');
      } catch (error) {
        console.error('[OpEx Comments] Save failed:', {taskId,error});
        list.innerHTML = `<div class="opex-comment-error">Kommentaren ble ikke lagret · ${escapeHtml(error?.message || 'ukjent feil')}</div>`;
        if (typeof window.toast === 'function') window.toast('Kunne ikke lagre kommentaren: ' + (error?.message || 'ukjent feil'), true);
      } finally {
        button.disabled = false;
        button.textContent = 'Legg til';
      }
    });
  }

  function installHooks() {
    installStyles();
    if (typeof window.openModal !== 'function') {setTimeout(installHooks,100);return;}
    if (!window.openModal.__opexCommentsV38) {
      const originalOpenModal = window.openModal;
      const wrappedOpenModal = function (...args) {
        const result = originalOpenModal.apply(this,args);
        const taskId = String(args[0] || '').trim();
        setTimeout(() => mountComments(taskId),0);
        return result;
      };
      wrappedOpenModal.__opexCommentsV38 = true;
      window.openModal = wrappedOpenModal;
    }
    if (typeof window.closeModal === 'function' && !window.closeModal.__opexCommentsV38) {
      const originalCloseModal = window.closeModal;
      const wrappedCloseModal = function (...args) {stopComments();return originalCloseModal.apply(this,args);};
      wrappedCloseModal.__opexCommentsV38 = true;
      window.closeModal = wrappedCloseModal;
    }
  }

  installHooks();
})();
