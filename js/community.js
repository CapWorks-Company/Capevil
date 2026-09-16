import { listLevels, isBackendReady, getMyLikedLevelIds } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink } from './site-chrome.js';
import { levelRow, bindRowActions, emptyState } from './level-cards.js';

const listEl = document.getElementById('levels-list');
const backendWarning = document.getElementById('backend-warning');
const accountBar = document.getElementById('account-bar');
const siteNav = document.getElementById('site-nav');
const searchInput = document.getElementById('search');

let currentSession = null;
let likedLevelIds = new Set();

mountSiteNav(siteNav, 'community');
mountAccountBar(accountBar, { onChange: (session) => { currentSession = session; likedLevelIds = new Set(); refresh(searchInput.value); refreshAdminLink(session); } });
searchInput.addEventListener('input', () => refresh(searchInput.value));

async function refresh(search = '') {
  const ready = await isBackendReady();
  if (!ready) {
    backendWarning.classList.remove('hidden');
    listEl.innerHTML = emptyState('Base de données non configurée pour le moment.');
    return;
  }
  listEl.innerHTML = emptyState('Chargement…');
  const { levels, error } = await listLevels({ search });
  if (error) { listEl.innerHTML = emptyState('Erreur de chargement.'); return; }
  if (!levels.length) { listEl.innerHTML = emptyState('Aucun niveau publié pour l\'instant. Sois le premier !'); return; }
  if (currentSession) likedLevelIds = new Set([...likedLevelIds, ...(await getMyLikedLevelIds(levels.map((l) => l.id)))]);
  listEl.innerHTML = levels.map((lvl) => levelRow(lvl, { currentSession, likedLevelIds })).join('');
  bindRowActions(listEl, { currentSession, likedLevelIds, onChanged: () => refresh(searchInput.value) });
}

refresh();
