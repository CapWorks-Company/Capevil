import { getPublicProfile, listLevelsByOwner, getMyLikedLevelIds, hasEncouraged, encourage, unencourage, getSession } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink, refreshNotifBadge } from './site-chrome.js';
import { levelRow, bindRowActions, emptyState, escapeHtml } from './level-cards.js';
import { BADGES } from './catalog.js';
import { showToast } from './ui-kit.js';

const siteNav = document.getElementById('site-nav');
const accountBar = document.getElementById('account-bar');
const notFoundCard = document.getElementById('not-found-card');
const profileCard = document.getElementById('profile-card');
const profileNameEl = document.getElementById('profile-name');
const profileBadgesEl = document.getElementById('profile-badges');
const encouragementCountEl = document.getElementById('profile-encouragement-count');
const encourageBtn = document.getElementById('encourage-btn');
const levelsEl = document.getElementById('profile-levels');

mountSiteNav(siteNav, null);

const params = new URLSearchParams(location.search);
const profileId = params.get('id');
let currentSession = null;
let likedLevelIds = new Set();
let encouraged = false;

mountAccountBar(accountBar, { onChange: (session) => { currentSession = session; refreshAdminLink(session); refreshNotifBadge(session); updateEncourageBtn(); } });

async function load() {
  if (!profileId) { notFoundCard.classList.remove('hidden'); return; }
  const profile = await getPublicProfile(profileId);
  if (!profile) { notFoundCard.classList.remove('hidden'); return; }
  profileCard.classList.remove('hidden');
  document.title = `Capevil — ${profile.display_name}`;
  profileNameEl.textContent = profile.display_name;
  profileBadgesEl.innerHTML = (profile.badges || []).map((id) => {
    const b = BADGES.find((x) => x.id === id);
    return b ? `<span title="${escapeHtml(b.label)}">${b.icon}</span>` : '';
  }).join(' ') || 'Aucun badge pour l\'instant';
  encouragementCountEl.textContent = `💪 ${profile.encouragement_count} encouragement${profile.encouragement_count > 1 ? 's' : ''}`;

  currentSession = await getSession();
  encouraged = currentSession ? await hasEncouraged(profileId) : false;
  updateEncourageBtn();

  const { levels } = await listLevelsByOwner(profileId);
  if (!levels.length) { levelsEl.innerHTML = emptyState('Aucun niveau publié pour l\'instant.'); return; }
  if (currentSession) likedLevelIds = await getMyLikedLevelIds(levels.map((l) => l.id));
  levelsEl.innerHTML = levels.map((lvl) => levelRow(lvl, { currentSession, likedLevelIds })).join('');
  bindRowActions(levelsEl, { currentSession, likedLevelIds, onChanged: load });
}

function updateEncourageBtn() {
  const isSelf = currentSession && currentSession.user.id === profileId;
  encourageBtn.classList.toggle('hidden', !!isSelf);
  encourageBtn.textContent = encouraged ? '💪 Encouragé ✓' : '💪 Encourager';
  encourageBtn.classList.toggle('primary', !encouraged);
}

encourageBtn.addEventListener('click', async () => {
  if (!currentSession) { showToast('Connecte-toi pour encourager ce joueur.', { type: 'error' }); return; }
  encourageBtn.disabled = true;
  const { error } = encouraged ? await unencourage(profileId) : await encourage(profileId);
  encourageBtn.disabled = false;
  if (error) { showToast('Erreur.', { type: 'error' }); return; }
  encouraged = !encouraged;
  updateEncourageBtn();
  load();
});

load();
