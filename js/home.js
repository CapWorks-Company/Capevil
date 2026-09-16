import { listLevels, isBackendReady, likeLevel, getMyLikedLevelIds, requestApproval, listMyLevels, deleteOwnLevel, reportLevel, amIAdmin } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { LOCAL_PREFIX, listLocalDrafts, deleteLocalDraft } from './local-storage.js';
import { showToast, confirmModal, promptModal } from './ui-kit.js';
import { discoverCampaignLevels, unlockedCount } from './campaign.js';

const listEl = document.getElementById('levels-list');
const officialListEl = document.getElementById('official-list');
const searchInput = document.getElementById('search');
const backendWarning = document.getElementById('backend-warning');
const localListEl = document.getElementById('local-list');
const myLevelsListEl = document.getElementById('my-levels-list');
const myLevelsHint = document.getElementById('my-levels-hint');
const accountBar = document.getElementById('account-bar');
const adventureListEl = document.getElementById('adventure-list');
const adminLinkEl = document.getElementById('admin-link');

let currentSession = null;
let likedLevelIds = new Set(); // level ids the signed-in account has already liked (one like per account)

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function levelRow(lvl) {
  const approvalNote = lvl.approval_requested && !lvl.approved ? '<div class="muted" style="font-size:11px;">Approbation demandée…</div>' : '';
  // Reporting is only possible for official (admin-approved) levels — but
  // open to everyone (any signed-in account), not just the level's creator.
  const reportBtn = lvl.approved
    ? `<button class="btn small" data-report="${lvl.id}">🚩 Signaler</button>`
    : '';
  // Only the level's own creator can request its approval — never anyone else.
  const isOwner = !!(currentSession && lvl.owner_id === currentSession.user.id);
  const approvalBtn = (!lvl.approved && isOwner)
    ? `<button class="btn small" data-request-approval="${lvl.id}" ${lvl.approval_requested ? 'disabled' : ''}>${lvl.approval_requested ? 'Demande envoyée' : 'Demander l’approbation'}</button>`
    : '';
  // A like is capped at one per account — once liked, the button just shows
  // that instead of allowing another click.
  const alreadyLiked = likedLevelIds.has(lvl.id);
  const likeBtn = `<button class="btn small" data-like="${lvl.id}" ${alreadyLiked ? 'disabled' : ''}>${alreadyLiked ? '💖 Déjà liké' : '💖 Liker'}</button>`;
  return `
    <div class="level-card${lvl.approved ? ' official' : ''}" data-id="${lvl.id}">
      <div class="lc-title">${escapeHtml(lvl.title)}${lvl.approved ? ' <span class="pill" title="Partie officielle">🏅 officiel</span>' : ''}</div>
      <div class="lc-author">par ${escapeHtml(lvl.author) || '—'}</div>
      <div class="lc-stats">
        <span title="Parties jouées">🎮 ${lvl.plays}</span>
        <span title="Victoires">🏆 ${lvl.wins}</span>
        <span title="Likes">💖 ${lvl.likes ?? 0}</span>
      </div>
      ${approvalNote}
      <div class="lc-actions">
        <a class="btn small accent" href="game.html?id=${lvl.id}">▶ Jouer</a>
        ${likeBtn}
        ${approvalBtn}
        ${reportBtn}
      </div>
    </div>`;
}

function bindRowActions(container) {
  container.querySelectorAll('button[data-like]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!currentSession) { showToast('Connecte-toi pour liker un niveau.', { type: 'error' }); return; }
      btn.disabled = true;
      const { error, liked } = await likeLevel(btn.dataset.like);
      if (!error && liked) likedLevelIds.add(btn.dataset.like);
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

// Fetches (and merges into the module-level set) which of these level ids
// the signed-in account has already liked, so levelRow() can grey out the
// like button for them. A no-op (empty set) while signed out.
async function loadLikedState(levels) {
  if (!currentSession || !levels.length) return;
  const liked = await getMyLikedLevelIds(levels.map((l) => l.id));
  liked.forEach((id) => likedLevelIds.add(id));
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
  await loadLikedState(levels);
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
  await loadLikedState(levels);
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
        <span title="Victoires">🏆 ${lvl.wins}</span>
        <span title="Likes">💖 ${lvl.likes ?? 0}</span>
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

// The 🗺️ Aventure section: Capevil's own built-in campaign (see
// js/campaign.js — auto-discovered from levels/Niveau 1.json,
// levels/Niveau 2.json, … dropped into that folder, no manifest to edit).
// Levels not yet reached (sequential unlock, tracked per browser) are still
// listed — so the campaign's full length is visible — just dimmed and
// unplayable.
async function refreshAdventure() {
  if (!adventureListEl) return;
  adventureListEl.innerHTML = emptyState('Chargement…');
  const levels = await discoverCampaignLevels();
  if (!levels.length) {
    adventureListEl.innerHTML = emptyState('Aucun niveau d\'aventure pour l\'instant — bientôt !');
    return;
  }
  const unlocked = unlockedCount();
  adventureListEl.innerHTML = levels.map(({ index, level }) => {
    const isUnlocked = index < unlocked;
    const title = isUnlocked ? (level.title || `Niveau ${index + 1}`) : `Niveau ${index + 1}`;
    return `
      <div class="level-card${isUnlocked ? '' : ' level-locked'}">
        <div class="lc-title">${isUnlocked ? '' : '🔒 '}${escapeHtml(title)}</div>
        <div class="lc-stats"><span>Niveau ${index + 1} / ${levels.length}</span></div>
        <div class="lc-actions">
          ${isUnlocked
            ? `<a class="btn small accent" href="game.html?campaign=${index}">▶ Jouer</a>`
            : `<button class="btn small" disabled title="Termine le niveau précédent pour débloquer celui-ci">🔒 Verrouillé</button>`}
        </div>
      </div>`;
  }).join('');
}

function refreshAll() {
  refreshAdventure();
  refreshOfficial();
  refreshLevels(searchInput.value);
  refreshMyLevels();
}

// The 🛡 Admin button in the topbar is only for admins — everyone else
// never sees it exists, it's just hidden by default and revealed only once
// amIAdmin() (Supabase RPC, session-aware) confirms the signed-in account.
async function refreshAdminLink(session) {
  if (!adminLinkEl) return;
  if (!session) { adminLinkEl.classList.add('hidden'); return; }
  const admin = await amIAdmin();
  adminLinkEl.classList.toggle('hidden', !admin);
}

searchInput.addEventListener('input', () => refreshLevels(searchInput.value));
mountAccountBar(accountBar, { onChange: (session) => { currentSession = session; likedLevelIds = new Set(); refreshAll(); refreshAdminLink(session); } });
refreshAdventure();
refreshOfficial();
refreshLevels();
refreshLocalDrafts();
