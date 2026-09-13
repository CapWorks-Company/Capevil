// Small shared UI kit: toast notifications + confirm/prompt modals, so no
// page ever has to fall back to the browser's own alert()/confirm()/prompt()
// (which look completely out of place next to the rest of the site).
// Reuses the same .modal-backdrop / .modal-box look as auth-ui.js and
// keybind-ui.js, but keeps its own modal root so the three never collide.

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ toasts
let toastRoot = null;
function ensureToastRoot() {
  if (toastRoot) return toastRoot;
  toastRoot = document.createElement('div');
  toastRoot.id = 'toast-root';
  document.body.appendChild(toastRoot);
  return toastRoot;
}

// type: 'info' | 'success' | 'error'
export function showToast(message, { type = 'info', duration = 3200 } = {}) {
  const root = ensureToastRoot();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  // rAF so the initial (pre-.show) state actually paints before transitioning
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 220); };
  el.addEventListener('click', remove);
  setTimeout(remove, duration);
  return el;
}

// ------------------------------------------------------------------ modals
let modalRoot = null;
function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.id = 'ui-kit-modal-root';
  document.body.appendChild(modalRoot);
  return modalRoot;
}
function closeModal() { if (modalRoot) modalRoot.innerHTML = ''; }

// Replaces window.confirm() — resolves true/false. Style the confirm button
// as a danger button for destructive actions (delete, overwrite…).
export function confirmModal(message, { title = 'Confirmer', okLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    root.innerHTML = `
      <div class="modal-backdrop" id="uik-backdrop">
        <div class="modal-box" role="alertdialog" aria-modal="true" style="max-width:360px;">
          <h2>${escapeHtml(title)}</h2>
          <p class="muted" style="margin:10px 0 0;line-height:1.5;">${escapeHtml(message)}</p>
          <div style="display:flex;gap:8px;margin-top:20px;">
            <button class="btn small" id="uik-cancel" style="flex:1;">${escapeHtml(cancelLabel)}</button>
            <button class="btn small ${danger ? 'danger' : 'primary'}" id="uik-ok" style="flex:1;">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const finish = (val) => { cleanup(); closeModal(); resolve(val); };
    const backdrop = root.querySelector('#uik-backdrop');
    const onBackdrop = (e) => { if (e.target === backdrop) finish(false); };
    const onEsc = (e) => { if (e.key === 'Escape') finish(false); };
    backdrop.addEventListener('click', onBackdrop);
    root.querySelector('#uik-cancel').addEventListener('click', () => finish(false));
    root.querySelector('#uik-ok').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onEsc);
    function cleanup() { document.removeEventListener('keydown', onEsc); }
    root.querySelector('#uik-ok').focus();
  });
}

// Replaces window.prompt() — resolves the entered string, or null on cancel.
export function promptModal(message, { title = 'Réponse requise', placeholder = '', okLabel = 'Valider', cancelLabel = 'Annuler', multiline = false } = {}) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    const field = multiline
      ? `<textarea id="uik-input" rows="3" style="width:100%;margin-top:14px;resize:vertical;" placeholder="${escapeHtml(placeholder)}"></textarea>`
      : `<input type="text" id="uik-input" style="width:100%;margin-top:14px;" placeholder="${escapeHtml(placeholder)}" />`;
    root.innerHTML = `
      <div class="modal-backdrop" id="uik-backdrop">
        <div class="modal-box" role="dialog" aria-modal="true" style="max-width:380px;">
          <h2>${escapeHtml(title)}</h2>
          <p class="muted" style="margin:8px 0 0;line-height:1.5;">${escapeHtml(message)}</p>
          ${field}
          <div style="display:flex;gap:8px;margin-top:18px;">
            <button class="btn small" id="uik-cancel" style="flex:1;">${escapeHtml(cancelLabel)}</button>
            <button class="btn small primary" id="uik-ok" style="flex:1;">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const input = root.querySelector('#uik-input');
    const backdrop = root.querySelector('#uik-backdrop');
    const finish = (val) => { cleanup(); closeModal(); resolve(val); };
    const onBackdrop = (e) => { if (e.target === backdrop) finish(null); };
    const onKeydown = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter' && !multiline && document.activeElement === input) finish(input.value);
    };
    backdrop.addEventListener('click', onBackdrop);
    root.querySelector('#uik-cancel').addEventListener('click', () => finish(null));
    root.querySelector('#uik-ok').addEventListener('click', () => finish(input.value));
    document.addEventListener('keydown', onKeydown);
    function cleanup() { document.removeEventListener('keydown', onKeydown); }
    input.focus();
  });
}
