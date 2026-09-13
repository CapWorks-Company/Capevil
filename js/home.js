import { listLevels, isBackendReady, likeLevel, requestApproval, listMyLevels, deleteOwnLevel, reportLevel } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { LOCAL_PREFIX, listLocalDrafts, deleteLocalDraft } from './local-storage.js';
import { showToast, confirmModal, promptModal } from './ui-kit.js';

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
    <div class="level-card${lvl.approved ? ' official' : ''}" data-id="${lvl.id}">
      <div class="lc-title">${escapeHtml(lvl.title)}${lvl.approved ? ' <span class="pill" title="Partie officielle">🏅 officiel</span>' : ''}</div>
      <div class="lc-author">par ${escapeHtml(lvl.author) || '—'}</div>
      <div class="lc-stats">
        <span title="Parties jouées">🎮 ${lvl.plays}</span>
        <span title="Victoires">🏁 ${lvl.wins}</span>
        <span title="Likes">❤ ${lvl.likes ?? 0}</span>
      </div>
      ${approvalNote}
      <div class="lc-actions">
        <a class="btn small accent" href="game.html?id=${lvl.id}">▶ Jouer</a>
        <button class="btn small" data-like="${lvl.id}">❤ Liker</button>
        ${!lvl.approved ? `<button class="btn small" data-request-approval="${lvl.id}" ${lvl.approval_requested ? 'disabled' : ''}>${lvl.approval_requested ? 'Demande envoyée' : 'Demander l’approbation'}</button>` : ''}
        ${reportBtn}
      </div>
    </div>`;
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
      if (!currentSession) { showToast('Connecte-toi pour demander une approbation.', { type: 'error' }); return; }
      btn.disabled = true;
      btn.textContent = 'Demande envoyée';
      await requestApproval(btn.dataset.requestApproval);
      showToast('Demande d’approbation envoyée ✓', { type: 'success' });
    });
  });
  container.querySelectorAll('button[data-report]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!currentSession) { showToast('Connecte-toi pour signaler un niveau.', { type: 'error' }); return; }
      const reason = await promptModal('Explique brièvement pourquoi ce niveau officiel pose problème.', {
        title: '🚩 Signaler ce niveau', placeholder: 'Raison du signalement…', okLabel: 'Signaler', multiline: true,
      });
      if (reason === null) return;
      btn.disabled = true;
      const { error } = await reportLevel(btn.dataset.report, reason);
      btn.textContent = error ? 'Erreur' : 'Signalé ✓';
      showToast(error ? "Erreur lors de l'envoi du signalement." : 'Signalement envoyé, merci !', { type: error ? 'error' : 'success' });
    });
  });
}

function emptyState(msg) {
  return `<div class="level-empty">${msg}</div>`;
}

async function refreshOfficial() {
  const ready = await isBackendReady();
  if (!ready) {
    officialListEl.innerHTML = emptyState('Base de données non configurée pour le moment.');
    return;
  }
  const { levels, error } = await listLevels({ officialOnly: true, limit: 20 });
  if (error) { officialListEl.innerHTML = emptyState('Erreur de chargement.'); return; }
  if (!levels.length) { officialListEl.innerHTML = emptyState('Aucune partie officielle pour l\'instant.'); return; }
  officialListEl.innerHTML = levels.map(levelRow).join('');
  bindRowActions(officialListEl);
}

async function refreshLevels(search = '') {
  const ready = await isBackendReady();
  if (!ready) {
    backendWarning.classList.remove('hidden');
    listEl.innerHTML = emptyState('Base de données non configurée pour le moment.');
    return;
  }
  listEl.innerHTML = emptyState('Chargement…');
  const { levels, error } = await listLevels({ search });
  if (error) {
    listEl.innerHTML = emptyState('Erreur de chargement.');
    return;
  }
  if (!levels.length) {
    listEl.innerHTML = emptyState('Aucun niveau publié pour l\'instant. Sois le premier !');
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
  if (error) { myLevelsListEl.innerHTML = emptyState('Erreur de chargement.'); return; }
  if (!levels.length) { myLevelsListEl.innerHTML = emptyState('Tu n\'as encore publié aucun niveau.'); return; }
  myLevelsListEl.innerHTML = levels.map((lvl) => `
    <div class="level-card${lvl.approved ? ' official' : ''}">
      <div class="lc-title">${escapeHtml(lvl.title)}${lvl.approved ? ' <span class="pill">🏅 officiel</span>' : ''}</div>
      <div class="lc-stats">
        <span title="Parties jouées">🎮 ${lvl.plays}</span>
        <span title="Victoires">🏁 ${lvl.wins}</span>
        <span title="Likes">❤ ${lvl.likes ?? 0}</span>
      </div>
      <div class="lc-actions">
        <a class="btn small accent" href="game.html?id=${lvl.id}">▶ Jouer</a>
        <a class="btn small" href="editor.html?edit=${lvl.id}">✏️ Modifier</a>
        <button class="btn small danger" data-delete-mine="${lvl.id}">🗑 Supprimer</button>
      </div>
    </div>
  `).join('');
  myLevelsListEl.querySelectorAll('button[data-delete-mine]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal('Supprimer définitivement ce niveau publié ? Cette action est irréversible.', {
        title: 'Supprimer ce niveau', okLabel: 'Supprimer', danger: true,
      });
      if (!ok) return;
      try {
        await deleteOwnLevel(btn.dataset.deleteMine);
        refreshAll();
        showToast('Niveau supprimé ✓', { type: 'success' });
      } catch (err) {
        showToast('Erreur : ' + (err.message || err), { type: 'error' });
      }
    });
  });
}

function refreshLocalDrafts() {
  const drafts = listLocalDrafts();
  if (!drafts.length) {
    localListEl.innerHTML = emptyState('Aucun brouillon local. Crée un niveau dans l\'éditeur !');
    return;
  }
  localListEl.innerHTML = drafts.map((d) => `
    <div class="level-card">
      <div class="lc-title">${escapeHtml(d.title)}</div>
      <div class="lc-stats"><span>🧩 ${d.entityCount} éléments</span></div>
      <div class="lc-actions">
        <a class="btn small accent" href="game.html?local=${d.key}">▶ Jouer</a>
        <a class="btn small" href="editor.html?local=${d.key}">✏️ Éditer</a>
        <button class="btn small danger" data-key="${d.key}">🗑 Suppr.</button>
      </div>
    </div>
  `).join('');
  localListEl.querySelectorAll('button[data-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal('Supprimer ce brouillon local ? Cette action est irréversible.', { title: 'Supprimer le brouillon', okLabel: 'Supprimer', danger: true });
      if (!ok) return;
      deleteLocalDraft(btn.dataset.key);
      refreshLocalDrafts();
      showToast('Brouillon supprimé ✓', { type: 'success' });
    });
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
