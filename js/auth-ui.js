// Small reusable "account bar" widget: shows compact "Se connecter" / "Créer
// un compte" buttons when logged out (opening a proper modal dialog to do
// so), or "👤 Nom · Se déconnecter" when logged in. Mounted into a plain
// container element so index.html / editor.html / game.html / admin.html can
// all share the same account UI without duplicating markup.
import { signIn, signUp, signOut, onAuthChange, getMyProfile, isBackendReady } from './supabase-client.js';

let modalRoot = null; // lazily created, shared across every mountAccountBar call

function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.id = 'auth-modal-root';
  document.body.appendChild(modalRoot);
  return modalRoot;
}

function closeModal() {
  if (modalRoot) modalRoot.innerHTML = '';
}

// Renders the login/signup dialog into the shared modal root. `mode` is
// 'login' or 'signup'; `onDone` fires once auth actually succeeds/settles.
function openAuthModal(mode) {
  const root = ensureModalRoot();
  let isSignup = mode === 'signup';

  function draw() {
    root.innerHTML = `
      <div class="modal-backdrop" id="auth-backdrop">
        <div class="modal-box auth-modal" role="dialog" aria-modal="true">
          <button class="modal-close" id="auth-close" aria-label="Fermer">✕</button>
          <h2>${isSignup ? '✨ Créer un compte' : '👋 Se connecter'}</h2>
          <p class="muted" style="margin-top:-8px;">${isSignup
            ? 'Un compte permet de publier des niveaux sous ton nom, de les modifier/supprimer, et de les liker.'
            : 'Connecte-toi pour publier, gérer tes niveaux, liker et signaler.'}</p>
          <form id="acct-form" class="auth-form-modal">
            ${isSignup ? `<label>Nom d'auteur<input type="text" id="acct-name" placeholder="Ton pseudo" required /></label>` : ''}
            <label>Email<input type="email" id="acct-email" placeholder="toi@exemple.com" required /></label>
            <label>Mot de passe<input type="password" id="acct-password" placeholder="••••••••" required minlength="6" /></label>
            <button class="btn primary" type="submit" style="width:100%;margin-top:6px;">${isSignup ? 'Créer le compte' : 'Se connecter'}</button>
          </form>
          <p id="acct-error" class="muted" style="color:#ff8a8a;min-height:16px;margin:10px 0 0;"></p>
          <p class="muted" style="text-align:center;margin:14px 0 0;">
            ${isSignup ? 'Déjà un compte ?' : 'Pas encore de compte ?'}
            <a href="#" id="acct-switch">${isSignup ? 'Se connecter' : 'Créer un compte'}</a>
          </p>
        </div>
      </div>`;

    const backdrop = root.querySelector('#auth-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    root.querySelector('#auth-close').addEventListener('click', closeModal);
    root.querySelector('#acct-switch').addEventListener('click', (e) => {
      e.preventDefault();
      isSignup = !isSignup;
      draw();
    });
    root.querySelector('#acct-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = root.querySelector('#acct-email').value.trim();
      const password = root.querySelector('#acct-password').value;
      const errEl = root.querySelector('#acct-error');
      const submitBtn = root.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        if (isSignup) {
          const name = root.querySelector('#acct-name').value.trim();
          const session = await signUp(email, password, name);
          if (!session) {
            errEl.style.color = 'var(--accent-2)';
            errEl.textContent = 'Compte créé ✓ Vérifie ta boîte mail pour confirmer, puis connecte-toi.';
            isSignup = false;
            submitBtn.disabled = false;
            draw();
            return;
          }
        } else {
          await signIn(email, password);
        }
        closeModal();
      } catch (err) {
        errEl.textContent = translateAuthError(err.message || String(err));
        submitBtn.disabled = false;
      }
    });
  }

  draw();
  // Escape closes the modal (once, cleaned up on next open/close).
  const onKey = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

export async function mountAccountBar(container, { onChange } = {}) {
  const ready = await isBackendReady();
  if (!ready) {
    container.innerHTML = '<span class="muted" style="font-size:12px;">Comptes indisponibles (Supabase non configuré)</span>';
    return;
  }

  async function renderSignedIn(session) {
    const profile = await getMyProfile();
    const name = profile ? profile.display_name : session.user.email;
    container.innerHTML = `
      <span class="pill" title="${session.user.email}">👤 ${escapeHtml(name)}</span>
      <button class="btn small" id="acct-signout">Se déconnecter</button>
    `;
    container.querySelector('#acct-signout').addEventListener('click', async () => {
      await signOut();
    });
  }

  function renderSignedOut() {
    container.innerHTML = `
      <button class="btn small" id="acct-login-open">Se connecter</button>
      <button class="btn small primary" id="acct-signup-open">Créer un compte</button>
    `;
    container.querySelector('#acct-login-open').addEventListener('click', () => openAuthModal('login'));
    container.querySelector('#acct-signup-open').addEventListener('click', () => openAuthModal('signup'));
  }

  await onAuthChange((session) => {
    closeModal();
    if (session) renderSignedIn(session); else renderSignedOut();
    if (onChange) onChange(session);
  });
}

function translateAuthError(msg) {
  if (/already registered/i.test(msg)) return 'Cet email a déjà un compte.';
  if (/invalid login credentials/i.test(msg)) return 'Email ou mot de passe incorrect.';
  if (/password/i.test(msg) && /6/i.test(msg)) return 'Le mot de passe doit faire au moins 6 caractères.';
  return msg;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
