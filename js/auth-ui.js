// Small reusable "account bar" widget: shows a sign-in/sign-up form when
// logged out, or "Connecté en tant que X · Se déconnecter" when logged in.
// Mounted into a plain container element so index.html / editor.html /
// game.html can all share the same account UI without duplicating markup.
import { signIn, signUp, signOut, onAuthChange, getMyProfile, isBackendReady } from './supabase-client.js';

export async function mountAccountBar(container, { onChange } = {}) {
  const ready = await isBackendReady();
  if (!ready) {
    container.innerHTML = '<span class="muted" style="font-size:12px;">Comptes indisponibles (Supabase non configuré)</span>';
    return;
  }

  let mode = 'bar'; // 'bar' | 'login' | 'signup'

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
    if (mode === 'bar') {
      container.innerHTML = `
        <button class="btn small" id="acct-login-open">Se connecter</button>
        <button class="btn small primary" id="acct-signup-open">Créer un compte</button>
      `;
      container.querySelector('#acct-login-open').addEventListener('click', () => { mode = 'login'; renderSignedOut(); });
      container.querySelector('#acct-signup-open').addEventListener('click', () => { mode = 'signup'; renderSignedOut(); });
      return;
    }
    const isSignup = mode === 'signup';
    container.innerHTML = `
      <form id="acct-form" class="auth-form">
        ${isSignup ? '<input type="text" id="acct-name" placeholder="Nom d\'auteur" required style="width:130px;" />' : ''}
        <input type="text" id="acct-email" placeholder="Email" required style="width:150px;" />
        <input type="password" id="acct-password" placeholder="Mot de passe" required style="width:130px;" />
        <button class="btn small primary" type="submit">${isSignup ? 'Créer le compte' : 'Se connecter'}</button>
        <button class="btn small" type="button" id="acct-cancel">Annuler</button>
        <button class="btn small" type="button" id="acct-switch">${isSignup ? 'J\'ai déjà un compte' : 'Créer un compte'}</button>
      </form>
      <p id="acct-error" class="muted" style="color:#ff8a8a;margin:6px 0 0;"></p>
    `;
    container.querySelector('#acct-cancel').addEventListener('click', () => { mode = 'bar'; renderSignedOut(); });
    container.querySelector('#acct-switch').addEventListener('click', () => { mode = isSignup ? 'login' : 'signup'; renderSignedOut(); });
    container.querySelector('#acct-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = container.querySelector('#acct-email').value.trim();
      const password = container.querySelector('#acct-password').value;
      const errEl = container.querySelector('#acct-error');
      try {
        if (isSignup) {
          const name = container.querySelector('#acct-name').value.trim();
          const session = await signUp(email, password, name);
          if (!session) { errEl.style.color = 'var(--accent-2)'; errEl.textContent = 'Compte créé ✓ Vérifie ta boîte mail pour confirmer, puis connecte-toi.'; mode = 'login'; return; }
        } else {
          await signIn(email, password);
        }
        mode = 'bar';
      } catch (err) {
        errEl.textContent = translateAuthError(err.message || String(err));
      }
    });
  }

  await onAuthChange((session) => {
    mode = 'bar';
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
