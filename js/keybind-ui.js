// Small "⌨ Touches" button that opens a modal to rebind each control and
// saves the result locally (see keybindings.js). Shares the same modal
// look as auth-ui.js's login/signup dialog.
import { ACTIONS, ACTION_LABELS, loadKeybinds, saveKeybinds, resetKeybinds, codeLabel } from './keybindings.js';

let modalRoot = null;
function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.id = 'keybind-modal-root';
  document.body.appendChild(modalRoot);
  return modalRoot;
}
function closeModal() { if (modalRoot) modalRoot.innerHTML = ''; }

function openKeybindModal() {
  const root = ensureModalRoot();
  let binds = loadKeybinds();
  let listeningFor = null; // action currently waiting for a keypress

  function draw() {
    root.innerHTML = `
      <div class="modal-backdrop" id="kb-backdrop">
        <div class="modal-box" role="dialog" aria-modal="true">
          <button class="modal-close" id="kb-close" aria-label="Fermer">✕</button>
          <h2>⌨ Touches</h2>
          <p class="muted" style="margin-top:-8px;">Clique « Modifier » puis appuie sur la touche voulue.</p>
          <div class="keybind-list">
            ${ACTIONS.map((a) => `
              <div class="keybind-row">
                <span>${ACTION_LABELS[a]}</span>
                <button class="btn small ${listeningFor === a ? 'accent' : ''}" data-rebind="${a}">
                  ${listeningFor === a ? 'Appuie sur une touche…' : codeLabel(binds[a])}
                </button>
              </div>`).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;">
            <button class="btn small" id="kb-reset">↺ Réinitialiser</button>
            <button class="btn small primary" id="kb-done" style="flex:1;">Terminé</button>
          </div>
        </div>
      </div>`;

    const backdrop = root.querySelector('#kb-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    root.querySelector('#kb-close').addEventListener('click', closeModal);
    root.querySelector('#kb-done').addEventListener('click', closeModal);
    root.querySelector('#kb-reset').addEventListener('click', () => { binds = resetKeybinds(); listeningFor = null; draw(); });
    root.querySelectorAll('[data-rebind]').forEach((btn) => {
      btn.addEventListener('click', () => { listeningFor = btn.dataset.rebind; draw(); });
    });
  }

  function onKeydown(e) {
    if (!listeningFor) return;
    e.preventDefault();
    if (e.code === 'Escape') { listeningFor = null; draw(); return; }
    // If this key was already used by another action, free it up first so
    // two actions never silently share one key.
    for (const a of ACTIONS) if (a !== listeningFor && binds[a] === e.code) binds[a] = null;
    binds[listeningFor] = e.code;
    listeningFor = null;
    saveKeybinds(binds);
    draw();
  }
  document.addEventListener('keydown', onKeydown, true);

  const onEscClose = (e) => { if (e.key === 'Escape' && !listeningFor) { closeModal(); cleanup(); } };
  document.addEventListener('keydown', onEscClose);
  function cleanup() {
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keydown', onEscClose);
  }
  // Clean up listeners whenever the modal root is emptied by any close path.
  const observer = new MutationObserver(() => { if (!root.hasChildNodes()) { cleanup(); observer.disconnect(); } });
  observer.observe(root, { childList: true });

  draw();
}

export function mountKeybindButton(container) {
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.id = 'keybind-btn';
  btn.textContent = '⌨ Touches';
  btn.addEventListener('click', openKeybindModal);
  container.appendChild(btn);
  return btn;
}
