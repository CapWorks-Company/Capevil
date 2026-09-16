import {
  isBackendReady, amIAdmin, listPendingApprovals, setLevelApproved,
  listLevels, listReports, dismissReport,
  adminListProfiles, adminSetProfile,
} from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { BADGES } from './catalog.js';
import { showToast } from './ui-kit.js';

const backendWarning = document.getElementById('backend-warning');
const loginCard = document.getElementById('login-card');
const notAdminCard = document.getElementById('not-admin-card');
const adminPanel = document.getElementById('admin-panel');
const reportsCard = document.getElementById('reports-card');
const allLevelsCard = document.getElementById('all-levels-card');
const pendingListEl = document.getElementById('pending-list');
const reportsListEl = document.getElementById('reports-list');
const allListEl = document.getElementById('all-list');
const accountBar = document.getElementById('account-bar');
const accountsCard = document.getElementById('accounts-card');
const accountsListEl = document.getElementById('accounts-list');
const accountSearchInput = document.getElementById('account-search');
const accountSearchBtn = document.getElementById('account-search-btn');

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function refreshAdminPanels(session) {
  loginCard.classList.toggle('hidden', !!session);
  if (!session) {
    notAdminCard.classList.add('hidden');
    adminPanel.classList.add('hidden');
    reportsCard.classList.add('hidden');
    allLevelsCard.classList.add('hidden');
    return;
  }
  const admin = await amIAdmin();
  notAdminCard.classList.toggle('hidden', admin);
  adminPanel.classList.toggle('hidden', !admin);
  reportsCard.classList.toggle('hidden', !admin);
  allLevelsCard.classList.toggle('hidden', !admin);
  accountsCard.classList.toggle('hidden', !admin);
  if (!admin) return;

  refreshPending();
  refreshReports();
  refreshAllOfficial();
  refreshAccounts();
}

// ------------------------------------------------------------- comptes joueurs
async function refreshAccounts(search = '') {
  const { profiles, error } = await adminListProfiles(search);
  if (error) { accountsListEl.innerHTML = '<p class="muted">Erreur de chargement.</p>'; return; }
  if (!profiles.length) { accountsListEl.innerHTML = '<p class="muted">Aucun compte trouvé.</p>'; return; }
  accountsListEl.innerHTML = profiles.map((p) => {
    const owned = new Set(p.badges || []);
    return `
    <div class="card" style="display:flex;flex-direction:column;gap:8px;">
      <div class="flex-row" style="justify-content:space-between;">
        <strong>${escapeHtml(p.display_name) || '—'}</strong>
        <a class="btn small" href="profile.html?id=${p.id}" target="_blank" rel="noopener">👁️ Voir le profil</a>
      </div>
      <div class="muted" style="font-size:12px;">👍 ${p.encouragement_count ?? 0} encouragements</div>
      <label style="font-size:13px;">🪙 Evicoins
        <input type="number" min="0" step="1" class="acct-coins" data-id="${p.id}" value="${p.coins ?? 0}" style="width:100px;margin-left:6px;" />
      </label>
      <div class="flex-row" style="flex-wrap:wrap;gap:10px;font-size:12.5px;">
        ${BADGES.map((b) => `
          <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;">
            <input type="checkbox" class="acct-badge" data-id="${p.id}" value="${b.id}" ${owned.has(b.id) ? 'checked' : ''} />
            ${b.icon} ${escapeHtml(b.label)}
          </label>
        `).join('')}
      </div>
      <div>
        <button class="btn small primary" data-save-acct="${p.id}">💾 Enregistrer</button>
      </div>
    </div>`;
  }).join('');

  accountsListEl.querySelectorAll('button[data-save-acct]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveAcct;
      const coinsInput = accountsListEl.querySelector(`.acct-coins[data-id="${id}"]`);
      const coins = Math.max(0, parseInt(coinsInput.value, 10) || 0);
      const badges = Array.from(accountsListEl.querySelectorAll(`.acct-badge[data-id="${id}"]:checked`)).map((cb) => cb.value);
      btn.disabled = true;
      const { error } = await adminSetProfile(id, coins, badges);
      btn.disabled = false;
      if (error) { showToast('Erreur lors de la sauvegarde du compte.', { type: 'error' }); return; }
      showToast('Compte mis à jour ✓', { type: 'success' });
    });
  });
}

accountSearchBtn.addEventListener('click', () => refreshAccounts(accountSearchInput.value.trim()));
accountSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshAccounts(accountSearchInput.value.trim()); });

async function refreshPending() {
  const { levels, error } = await listPendingApprovals();
  if (error) { pendingListEl.innerHTML = '<p class="muted">Erreur de chargement.</p>'; return; }
  if (!levels.length) { pendingListEl.innerHTML = '<p class="muted">Aucune demande en attente.</p>'; return; }
  pendingListEl.innerHTML = levels.map((lvl) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <strong>${escapeHtml(lvl.title)}</strong>
        <div class="muted" style="font-size:12px;">par ${escapeHtml(lvl.author) || '—'} · ${lvl.plays} parties · 💖 ${lvl.likes ?? 0}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <a class="btn small" href="editor.html?preview=${lvl.id}" target="_blank" rel="noopener">👁️ Aperçu complet</a>
        <button class="btn small accent" data-approve="${lvl.id}">✓ Approuver</button>
      </div>
    </div>
  `).join('');
  pendingListEl.querySelectorAll('button[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await setLevelApproved(btn.dataset.approve, true);
      refreshPending(); refreshAllOfficial();
    });
  });
}

async function refreshReports() {
  const { reports, error } = await listReports();
  if (error) { reportsListEl.innerHTML = '<p class="muted">Erreur de chargement.</p>'; return; }
  if (!reports.length) { reportsListEl.innerHTML = '<p class="muted">Aucun signalement.</p>'; return; }
  reportsListEl.innerHTML = reports.map((r) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <strong>${escapeHtml(r.level_title)}</strong>
        <div class="muted" style="font-size:12px;">${escapeHtml(r.reason)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <a class="btn small" href="editor.html?preview=${r.level_id}" target="_blank" rel="noopener">👁️ Aperçu complet</a>
        <button class="btn small danger" data-unapprove="${r.level_id}">Retirer le statut officiel</button>
        <button class="btn small" data-dismiss="${r.id}">Ignorer</button>
      </div>
    </div>
  `).join('');
  reportsListEl.querySelectorAll('button[data-unapprove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await setLevelApproved(btn.dataset.unapprove, false);
      refreshAllOfficial();
    });
  });
  reportsListEl.querySelectorAll('button[data-dismiss]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await dismissReport(btn.dataset.dismiss);
      refreshReports();
    });
  });
}

async function refreshAllOfficial() {
  const { levels, error } = await listLevels({ officialOnly: true, limit: 100 });
  if (error) { allListEl.innerHTML = '<p class="muted">Erreur de chargement.</p>'; return; }
  if (!levels.length) { allListEl.innerHTML = '<p class="muted">Aucune partie officielle.</p>'; return; }
  allListEl.innerHTML = levels.map((lvl) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <strong>${escapeHtml(lvl.title)}</strong>
        <div class="muted" style="font-size:12px;">par ${escapeHtml(lvl.author) || '—'}</div>
      </div>
      <div style="display:flex;gap:6px;">
        <a class="btn small" href="editor.html?preview=${lvl.id}" target="_blank" rel="noopener">👁️ Aperçu complet</a>
        <button class="btn small danger" data-unapprove2="${lvl.id}">Retirer le statut officiel</button>
      </div>
    </div>
  `).join('');
  allListEl.querySelectorAll('button[data-unapprove2]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await setLevelApproved(btn.dataset.unapprove2, false);
      refreshAllOfficial();
    });
  });
}

async function init() {
  const ready = await isBackendReady();
  if (!ready) { backendWarning.classList.remove('hidden'); return; }
  mountAccountBar(accountBar, { onChange: refreshAdminPanels });
}

init();
