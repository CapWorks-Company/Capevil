import { listLevels, isBackendReady, likeLevel, requestApproval, listMyLevels, deleteOwnLevel, reportLevel } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { LOCAL_PREFIX, listLocalDrafts, deleteLocalDraft } from './local-storage.js';

const listEl = document.getElementById('levels-list');
const officialListEl = document.getElementById('official-list');
const searchInput = document.getElementById('search');
const backendWarning = document.getElementById('backend-warning');
const localListEl = document.getElementById('local-list');
const myLevelsListEl = document.getElementById('my-levels-list');
const myLevelsHint = document.getElementById('my-levels-hint');
const accountBar = document.getElementById('account-bar');

let currentSession = null;

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function levelRow(lvl) {
  const approvalNote = lvl.approval_requested && !lvl.approved ? '<div class="muted" style="font-size:11px;">Approbation demandée…</div>' : '';
  // Reporting is only possible for official (admin-approved) levels.
  const reportBtn = lvl.approved
    ? `<button class="btn small" data-report="${lvl.id}">🚩 Signaler</button>`
    : '';
  return `
    <tr data-id="${lvl.id}">
      <td>${escapeHtml(lvl.title)}${lvl.approved ? ' <span class="pill" title="Partie officielle">🏅</span>' : ''}</td>
      <td class="muted">${escapeHtml(lvl.author) || '—'}</td>
      <td class="muted">${lvl.plays} parties · ${lvl.wins} victoires · ❤ ${lvl.likes ?? 0}${approvalNote}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <a class="btn small accent" href="game.html?id=${lvl.id}">Jouer</a>
        <button class="btn small" data-like="${lvl.id}">❤ Liker</button>
        ${!lvl.approved ? `<button class="btn small" data-request-approval="${lvl.id}" ${lvl.approval_requested ? 'disabled' : ''}>${lvl.approval_requested ? 'Demande envoyée' : 'Demander l’approbation'}</button>` : ''}
        ${reportBtn}
      </td>
    </tr>`;
}

function bindRowActions(container) {
  container.querySelectorAll('button[data-like]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await likeLevel(btn.dataset.like);
      refreshAll();
    });
  });
  container.querySelectorAll('button[data-request-approval]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!currentSession) { alert('Connecte-toi pour demander une approbation.'); return; }
      btn.disabled = true;
      btn.textContent = 'Demande envoyée';
      await requestApproval(btn.dataset.requestApproval);
    });
  });
  container.querySelectorAll('button[data-report]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!currentSession) { alert('Connecte-toi pour signaler un niveau.'); return; }
      const reason = prompt('Pourquoi signales-tu ce niveau officiel ?');
      if (reason === null) return;
      btn.disabled = true;
      const { error } = await reportLevel(btn.dataset.report, reason);
      btn.textContent = error ? 'Erreur' : 'Signalé ✓';
    });
  });
}

async function refreshOfficial() {
  const ready = await isBackendReady();
  if (!ready) {
    officialListEl.innerHTML = '<tr><td colspan="4" class="muted">Base de données non configurée pour le moment.</td></tr>';
    return;
  }
  const { levels, error } = await listLevels({ officialOnly: true, limit: 20 });
  if (error) { officialListEl.innerHTML = '<tr><td colspan="4" class="muted">Erreur de chargement.</td></tr>'; return; }
  if (!levels.length) { officialListEl.innerHTML = '<tr><td colspan="4" class="muted">Aucune partie officielle pour l\'instant.</td></tr>'; return; }
  officialListEl.innerHTML = levels.map(levelRow).join('');
  bindRowActions(officialListEl);
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
  listEl.innerHTML = levels.map(levelRow).join('');
  bindRowActions(listEl);
}

async function refreshMyLevels() {
  if (!currentSession) {
    myLevelsHint.classList.remove('hidden');
    myLevelsHint.textContent = 'Connecte-toi pour voir et gérer (modifier / supprimer) les niveaux publiés avec ton compte.';
    myLevelsListEl.innerHTML = '';
    return;
  }
  myLevelsHint.classList.add('hidden');
  const { levels, error } = await listMyLevels();
  if (error) { myLevelsListEl.innerHTML = '<p class="muted">Erreur de chargement.</p>'; return; }
  if (!levels.length) { myLevelsListEl.innerHTML = '<p class="muted">Tu n\'as encore publié aucun niveau.</p>'; return; }
  myLevelsListEl.innerHTML = levels.map((lvl) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <strong>${escapeHtml(lvl.title)}</strong>${lvl.approved ? ' <span class="pill">🏅 officiel</span>' : ''}
        <div class="muted" style="font-size:12px;">${lvl.plays} parties · ${lvl.wins} victoires · ❤ ${lvl.likes ?? 0}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <a class="btn small accent" href="game.html?id=${lvl.id}">Jouer</a>
        <a class="btn small" href="editor.html?edit=${lvl.id}">Modifier</a>
        <button class="btn small danger" data-delete-mine="${lvl.id}">Supprimer</button>
      </div>
    </div>
  `).join('');
  myLevelsListEl.querySelectorAll('button[data-delete-mine]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement ce niveau publié ?')) return;
      try {
        await deleteOwnLevel(btn.dataset.deleteMine);
        refreshAll();
      } catch (err) {
        alert('Erreur : ' + (err.message || err));
      }
    });
  });
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

function refreshAll() {
  refreshOfficial();
  refreshLevels(searchInput.value);
  refreshMyLevels();
}

searchInput.addEventListener('input', () => refreshLevels(searchInput.value));
mountAccountBar(accountBar, { onChange: (session) => { currentSession = session; refreshMyLevels(); } });
refreshOfficial();
refreshLevels();
refreshLocalDrafts();
