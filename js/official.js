import { listLevels, isBackendReady, getMyLikedLevelIds, onAuthChange } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink, refreshNotifBadge } from './site-chrome.js';
import { levelRow, bindRowActions, emptyState } from './level-cards.js';

const listEl = document.getElementById('official-list');
const backendWarning = document.getElementById('backend-warning');
const accountBar = document.getElementById('account-bar');
const siteNav = document.getElementById('site-nav');

let currentSession = null;
let likedLevelIds = new Set();

mountSiteNav(siteNav, 'official');
mountAccountBar(accountBar, { onChange: (session) => { currentSession = session; likedLevelIds = new Set(); refresh(); refreshAdminLink(session); refreshNotifBadge(session); } });

async function refresh() {
  const ready = await isBackendReady();
  if (!ready) {
    backendWarning.classList.remove('hidden');
    listEl.innerHTML = emptyState('Base de données non configurée pour le moment.');
    return;
  }
  const { levels, error } = await listLevels({ officialOnly: true, limit: 50 });
  if (error) { listEl.innerHTML = emptyState('Erreur de chargement.'); return; }
  if (!levels.length) { listEl.innerHTML = emptyState('Aucune partie officielle pour l\'instant.'); return; }
  if (currentSession) likedLevelIds = new Set([...likedLevelIds, ...(await getMyLikedLevelIds(levels.map((l) => l.id)))]);
  listEl.innerHTML = levels.map((lvl) => levelRow(lvl, { currentSession, likedLevelIds })).join('');
  bindRowActions(listEl, { currentSession, likedLevelIds, onChanged: refresh });
}

refresh();
