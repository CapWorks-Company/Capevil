// Shared level-card rendering + row actions (like / request approval /
// report) — used by official.js, community.js and account.js (which all
// used to be one copy-pasted block inside the old mega home.js). Kept here
// once so like/report/approval wiring never drifts between the three pages.
import { likeLevel, requestApproval, reportLevel } from './supabase-client.js';
import { showToast, promptModal } from './ui-kit.js';

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// `currentSession` / `likedLevelIds` are passed in rather than imported as
// module state, since each page (official/community/account) tracks its own
// — this module stays a pure renderer with no state of its own.
export function levelRow(lvl, { currentSession, likedLevelIds }) {
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
  const alreadyLiked = likedLevelIds && likedLevelIds.has(lvl.id);
  const likeBtn = `<button class="btn small" data-like="${lvl.id}" ${alreadyLiked ? 'disabled' : ''}>${alreadyLiked ? '💖 Déjà liké' : '💖 Liker'}</button>`;
  // The author's name links to their public profile (see profile.html) —
  // everyone can now see everyone else's account, projects, and encourage
  // them. Falls back to plain text when a level predates owner tracking
  // (owner_id null) — nothing to link to in that case.
  const authorHtml = lvl.owner_id
    ? `<a href="profile.html?id=${lvl.owner_id}">${escapeHtml(lvl.author) || '—'}</a>`
    : (escapeHtml(lvl.author) || '—');
  return `
    <div class="level-card${lvl.approved ? ' official' : ''}" data-id="${lvl.id}">
      <div class="lc-title">${escapeHtml(lvl.title)}${lvl.approved ? ' <span class="pill" title="Partie officielle">🏅 officiel</span>' : ''}</div>
      <div class="lc-author">par ${authorHtml}</div>
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

// `onChanged` is called after any action that should refresh the list (a
// like, a report, an approval request) — each page passes its own refresh.
export function bindRowActions(container, { currentSession, likedLevelIds, onChanged }) {
  container.querySelectorAll('button[data-like]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!currentSession) { showToast('Connecte-toi pour liker un niveau.', { type: 'error' }); return; }
      btn.disabled = true;
      const { error, liked } = await likeLevel(btn.dataset.like);
      if (!error && liked) likedLevelIds.add(btn.dataset.like);
      onChanged();
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

export function emptyState(msg) {
  return `<div class="level-empty">${msg}</div>`;
}
