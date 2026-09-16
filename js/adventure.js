import { isBackendReady, getSession } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink } from './site-chrome.js';
import { escapeHtml, emptyState } from './level-cards.js';
import { discoverCampaignLevels, unlockedCount, isUnlocked, syncCampaignProgress } from './campaign.js';
import { SKIN_MILESTONES } from './catalog.js';

const backendWarning = document.getElementById('backend-warning');
const guestNote = document.getElementById('guest-note');
const accountBar = document.getElementById('account-bar');
const siteNav = document.getElementById('site-nav');
const gridEl = document.getElementById('adventure-grid');
const trackEl = document.getElementById('reward-track');

mountSiteNav(siteNav, 'adventure');
mountAccountBar(accountBar, {
  onChange: async (session) => {
    refreshAdminLink(session);
    guestNote.classList.toggle('hidden', !!session);
    if (session) await syncCampaignProgress(); // pulls the account's server progress in, merged with local (see campaign.js)
    render();
  },
});

isBackendReady().then((ready) => { if (!ready) backendWarning.classList.remove('hidden'); });

async function render() {
  const levels = await discoverCampaignLevels();
  if (!levels.length) {
    gridEl.innerHTML = emptyState('Aucun niveau d\'aventure pour l\'instant — bientôt !');
    return;
  }
  const unlocked = unlockedCount();
  gridEl.innerHTML = levels.map(({ index, level }) => {
    const reached = isUnlocked(index);
    const completed = index < unlocked - 1; // strictly past the current frontier — see this file's own note above
    if (!reached) {
      return `<div class="adventure-tile locked" title="Termine le niveau précédent pour débloquer celui-ci">
        <span class="at-num">${index + 1}</span>
        <span style="font-size:20px;">🔒</span>
      </div>`;
    }
    return `<a class="adventure-tile unlocked${completed ? ' completed' : ''}" href="game.html?campaign=${index}">
      ${completed ? '<span class="at-badge">✓</span>' : ''}
      <span class="at-num">${index + 1}</span>
      <span class="at-title">${escapeHtml(level.title || `Niveau ${index + 1}`)}</span>
    </a>`;
  }).join('');

  const session = await getSession();
  // `unlockedCount()` is "how many levels are reachable" (1-based), so a
  // level number N has actually been COMPLETED (not just unlocked) once N is
  // strictly less than that count — matches the same `completed` check used
  // for the grid tiles above.
  const levelsCompleted = unlocked - 1;
  trackEl.innerHTML = SKIN_MILESTONES.map((m) => {
    const isLocked = !session || levelsCompleted < m.level;
    const swatch = m.kind === 'player' ? m.skin.primary : (m.skin.base || '#555');
    return `<div class="reward-item${isLocked ? ' locked' : ''}">
      <div class="ri-swatch" style="background:${swatch};"></div>
      <div class="ri-label">${isLocked ? '🔒' : '✓'} ${escapeHtml(m.skin.label)}</div>
      <div class="ri-level">${m.kind === 'player' ? 'Skin joueur' : 'Skin objet'} — niveau ${m.level}</div>
    </div>`;
  }).join('');
}

render();
