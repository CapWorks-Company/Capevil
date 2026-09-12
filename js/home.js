import { listLevels, isBackendReady } from './supabase-client.js';
import { LOCAL_PREFIX, listLocalDrafts, deleteLocalDraft } from './local-storage.js';

const listEl = document.getElementById('levels-list');
const searchInput = document.getElementById('search');
const backendWarning = document.getElementById('backend-warning');
const localListEl = document.getElementById('local-list');

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function refreshLevels(search = '') {
  const ready = await isBackendReady();
  if (!ready) {
    backendWarning.classList.remove('hidden');
    listEl.innerHTML = '<tr><td colspan="4" class="muted">Base de données non configurée pour le moment.</td></tr>';
    return;
  }
  listEl.innerHTML = '<tr><td colspan="4" class="muted">Chargement…</td></tr>';
  const { levels, error } = await listLevels({ search });
  if (error) {
    listEl.innerHTML = `<tr><td colspan="4" class="muted">Erreur de chargement.</td></tr>`;
    return;
  }
  if (!levels.length) {
    listEl.innerHTML = '<tr><td colspan="4" class="muted">Aucun niveau publié pour l\'instant. Sois le premier !</td></tr>';
    return;
  }
  listEl.innerHTML = levels.map((lvl) => `
    <tr>
      <td>${escapeHtml(lvl.title)}</td>
      <td class="muted">${escapeHtml(lvl.author) || '—'}</td>
      <td class="muted">${lvl.plays} parties · ${lvl.wins} victoires</td>
      <td><a class="btn small accent" href="game.html?id=${lvl.id}">Jouer</a></td>
    </tr>
  `).join('');
}

function refreshLocalDrafts() {
  const drafts = listLocalDrafts();
  if (!drafts.length) {
    localListEl.innerHTML = '<p class="muted">Aucun brouillon local. Crée un niveau dans l\'éditeur !</p>';
    return;
  }
  localListEl.innerHTML = drafts.map((d) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <strong>${escapeHtml(d.title)}</strong>
        <div class="muted" style="font-size:12px;">${d.entityCount} éléments</div>
      </div>
      <div style="display:flex;gap:6px;">
        <a class="btn small accent" href="game.html?local=${d.key}">Jouer</a>
        <a class="btn small" href="editor.html?local=${d.key}">Éditer</a>
        <button class="btn small danger" data-key="${d.key}">Suppr.</button>
      </div>
    </div>
  `).join('');
  localListEl.querySelectorAll('button[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => { deleteLocalDraft(btn.dataset.key); refreshLocalDrafts(); });
  });
}

searchInput.addEventListener('input', () => refreshLevels(searchInput.value));
refreshLevels();
refreshLocalDrafts();
