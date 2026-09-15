// Small "⌨ Touches" button that opens a modal to rebind each control and
// saves the result locally (see keybindings.js). Shares the same modal
// look as auth-ui.js's login/signup dialog. Always shows both "Joueur 1" and
// "Joueur 2" sections — the player-2 keybinds only end up mattering once a
// level actually enables a second player (see playerStart2), but keeping the
// setting here (rather than hiding it) means it's ready whenever a level
// needs it, exactly like a controller you'd keep configured in advance.
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
  let binds1 = loadKeybinds(1);
  let binds2 = loadKeybinds(2);
  let listeningFor = null; // { player, action } currently waiting for a keypress

  function bindsFor(player) { return player === 2 ? binds2 : binds1; }

  function renderSection(player, title) {
    const binds = bindsFor(player);
    return `
      <div class="section-title" style="margin-top:14px;">${title}</div>
      <div class="keybind-list">
        ${ACTIONS.map((a) => {
          const active = listeningFor && listeningFor.player === player && listeningFor.action === a;
          return `
          <div class="keybind-row">
            <span>${ACTION_LABELS[a]}</span>
            <button class="btn small ${active ? 'accent' : ''}" data-rebind="${a}" data-player="${player}">
              ${active ? 'Appuie sur une touche…' : codeLabel(binds[a])}
            </button>
          </div>`;
        }).join('')}
      </div>
      <button class="btn small" data-reset-player="${player}" style="margin-top:6px;">↺ Réinitialiser joueur ${player}</button>`;
  }

  function draw() {
    root.innerHTML = `
      <div class="modal-backdrop" id="kb-backdrop">
        <div class="modal-box" role="dialog" aria-modal="true">
          <button class="modal-close" id="kb-close" aria-label="Fermer">✕</button>
          <h2>⌨ Touches</h2>
          <p class="muted" style="margin-top:-8px;">Clique « Modifier » puis appuie sur la touche voulue. Le joueur 2 ne sert que sur un niveau à 2 joueurs.</p>
          ${renderSection(1, '🧍 Joueur 1')}
          ${renderSection(2, '🧍 Joueur 2')}
          <div style="display:flex;gap:8px;margin-top:16px;">
            <button class="btn small primary" id="kb-done" style="flex:1;">Terminé</button>
          </div>
        </div>
      </div>`;

    const backdrop = root.querySelector('#kb-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    root.querySelector('#kb-close').addEventListener('click', closeModal);
    root.querySelector('#kb-done').addEventListener('click', closeModal);
    root.querySelectorAll('[data-reset-player]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const player = parseInt(btn.dataset.resetPlayer, 10);
        const fresh = resetKeybinds(player);
        if (player === 2) binds2 = fresh; else binds1 = fresh;
        listeningFor = null;
        draw();
      });
    });
    root.querySelectorAll('[data-rebind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        listeningFor = { player: parseInt(btn.dataset.player, 10), action: btn.dataset.rebind };
        draw();
      });
    });
  }

  function onKeydown(e) {
    if (!listeningFor) return;
    e.preventDefault();
    if (e.code === 'Escape') { listeningFor = null; draw(); return; }
    const { player, action } = listeningFor;
    const binds = bindsFor(player);
    // If this key was already used by another action FOR THE SAME PLAYER,
    // free it up first so two actions never silently share one key — the two
    // players' keymaps are independent, so the same key can validly be bound
    // to both (e.g. sharing a keyboard split down the middle isn't required).
    for (const a of ACTIONS) if (a !== action && binds[a] === e.code) binds[a] = null;
    binds[action] = e.code;
    listeningFor = null;
    saveKeybinds(binds, player);
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
