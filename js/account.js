import {
  isBackendReady, listMyLevels, deleteOwnLevel, getMyFullProfile,
  buyBadge, setSkin, listTopPlayers,
} from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink } from './site-chrome.js';
import { showToast, confirmModal } from './ui-kit.js';
import { listLocalDrafts, deleteLocalDraft } from './local-storage.js';
import { escapeHtml, emptyState } from './level-cards.js';
import { BADGES, PLAYER_SKINS, OBJECT_SKINS, maxProjectsForBadges } from './catalog.js';

const backendWarning = document.getElementById('backend-warning');
const accountBar = document.getElementById('account-bar');
const siteNav = document.getElementById('site-nav');
const signedOutCard = document.getElementById('signed-out-card');
const walletCard = document.getElementById('wallet-card');
const walletCoinsEl = document.getElementById('wallet-coins');
const walletBadgesEl = document.getElementById('wallet-badges');
const myLevelsListEl = document.getElementById('my-levels-list');
const myLevelsHint = document.getElementById('my-levels-hint');
const myLevelsCount = document.getElementById('my-levels-count');
const localListEl = document.getElementById('local-list');
const shopListEl = document.getElementById('shop-list');
const skinsEditorEl = document.getElementById('skins-editor');
const topPlayersEl = document.getElementById('top-players-list');

let currentSession = null;
let myProfile = null; // full profile (coins/badges/skins) — only set when signed in, see refreshProfile()

mountSiteNav(siteNav, 'account');
mountAccountBar(accountBar, {
  onChange: (session) => {
    currentSession = session;
    signedOutCard.classList.toggle('hidden', !!session);
    refreshAdminLink(session);
    refreshProfile();
    refreshMyLevels();
  },
});

isBackendReady().then((ready) => { if (!ready) backendWarning.classList.remove('hidden'); });

// -------------------------------------------------------------- tabs
const TABS = ['projects', 'drafts', 'shop', 'skins', 'top'];
function switchTab(tab) {
  if (!TABS.includes(tab)) tab = 'projects';
  for (const t of TABS) {
    document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== tab);
    const btn = document.querySelector(`#account-tabs [data-tab="${t}"]`);
    if (btn) btn.classList.toggle('active', t === tab);
  }
  history.replaceState(null, '', `#${tab}`);
  if (tab === 'top') refreshTopPlayers();
}
document.querySelectorAll('#account-tabs [data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
switchTab((location.hash || '#projects').slice(1));

// -------------------------------------------------------------- wallet
async function refreshProfile() {
  if (!currentSession) {
    myProfile = null;
    walletCard.classList.add('hidden');
    renderShop();
    renderSkins();
    return;
  }
  myProfile = await getMyFullProfile();
  if (!myProfile) { walletCard.classList.add('hidden'); return; }
  walletCard.classList.remove('hidden');
  walletCoinsEl.textContent = myProfile.coins;
  walletBadgesEl.innerHTML = (myProfile.badges || []).map((id) => {
    const b = BADGES.find((x) => x.id === id);
    return b ? `<span class="pill" title="${escapeHtml(b.label)}">${b.icon}</span>` : '';
  }).join('') || '<span class="muted" style="font-size:12px;">Aucun badge pour l\'instant</span>';
  renderShop();
  renderSkins();
}

// -------------------------------------------------------------- mes projets
async function refreshMyLevels() {
  if (!currentSession) {
    myLevelsHint.classList.remove('hidden');
    myLevelsHint.textContent = 'Connecte-toi pour voir et gérer (modifier / supprimer) les niveaux publiés avec ton compte.';
    myLevelsListEl.innerHTML = '';
    myLevelsCount.textContent = '';
    return;
  }
  myLevelsHint.classList.add('hidden');
  const { levels, error } = await listMyLevels();
  if (error) { myLevelsListEl.innerHTML = emptyState('Erreur de chargement.'); return; }
  const max = maxProjectsForBadges(myProfile ? myProfile.badges : []);
  myLevelsCount.textContent = `${levels.length} / ${max} projets publiés${max < 50 ? ' — débloque plus de place avec le Badge Créateur / Ultra dans la boutique' : ''}`;
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
        refreshMyLevels();
        showToast('Niveau supprimé ✓', { type: 'success' });
      } catch (err) {
        showToast('Erreur : ' + (err.message || err), { type: 'error' });
      }
    });
  });
}

// -------------------------------------------------------------- mes brouillons
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

// -------------------------------------------------------------- boutique
function renderShop() {
  const owned = new Set(myProfile ? myProfile.badges : []);
  shopListEl.innerHTML = BADGES.map((b) => {
    const has = owned.has(b.id);
    const canAfford = myProfile && myProfile.coins >= b.price;
    const prereqOk = !b.requires || (b.requires.badge ? owned.has(b.requires.badge) : true); // le prérequis "5 niveaux publiés" est revérifié côté serveur
    const disabled = !currentSession || has;
    return `
      <div class="level-card${has ? ' official' : ''}">
        <div class="lc-title">${b.icon} ${escapeHtml(b.label)}</div>
        <div class="muted" style="font-size:12.5px;">${escapeHtml(b.unlocks)}</div>
        ${b.requiresLabel ? `<div class="muted" style="font-size:11px;">${escapeHtml(b.requiresLabel)}</div>` : ''}
        <div class="lc-stats"><span>🪙 ${b.price}${b.priceIsGuess ? ' (prix indicatif)' : ''}</span></div>
        <div class="lc-actions">
          ${has
            ? '<span class="pill">✓ Débloqué</span>'
            : `<button class="btn small primary" data-buy="${b.id}" ${disabled || !canAfford || !prereqOk ? 'disabled' : ''}>Acheter</button>`}
        </div>
      </div>`;
  }).join('');
  shopListEl.querySelectorAll('button[data-buy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const result = await buyBadge(btn.dataset.buy);
      if (result.error) {
        const messages = {
          not_signed_in: 'Connecte-toi pour acheter un badge.',
          already_owned: 'Tu as déjà ce badge.',
          not_enough_coins: 'Pas assez d\'Evicoins.',
          needs_5_published_levels: 'Il te faut déjà 5 niveaux publiés.',
          needs_creator_badge: 'Il te faut déjà le Badge Créateur.',
          unknown_badge: 'Badge inconnu.',
        };
        showToast(messages[result.error] || 'Erreur lors de l\'achat.', { type: 'error' });
        btn.disabled = false;
        return;
      }
      showToast('Badge débloqué ✓', { type: 'success' });
      await refreshProfile();
    });
  });
}

// -------------------------------------------------------------- mes skins
function renderSkins() {
  if (!currentSession || !myProfile) {
    skinsEditorEl.innerHTML = '<p class="muted">Connecte-toi pour choisir tes skins.</p>';
    return;
  }
  const unlocked = new Set(myProfile.unlocked_skins || ['default']);
  const slotRow = (slot, label, list, current) => `
    <div class="field-group">
      <div class="section-title">${label}</div>
      <div class="flex-row" style="flex-wrap:wrap;">
        ${list.map((s) => {
          const isUnlocked = s.id === 'default' || unlocked.has(s.id);
          const active = current === s.id;
          const swatch = s.primary || s.base || '#555';
          return `<button type="button" class="btn small${active ? ' primary' : ''}" data-slot="${slot}" data-skin="${s.id}" ${isUnlocked ? '' : 'disabled'} title="${isUnlocked ? '' : `Débloqué au niveau Aventure ${s.unlockLevel}`}">
            <span class="palette-swatch" style="background:${swatch};width:16px;height:16px;">${isUnlocked ? '' : '🔒'}</span>${escapeHtml(s.label)}
          </button>`;
        }).join('')}
      </div>
    </div>`;
  skinsEditorEl.innerHTML =
    slotRow('skin1', '🧍 Joueur 1', PLAYER_SKINS, myProfile.skin1) +
    slotRow('skin2', '🧍 Joueur 2', PLAYER_SKINS, myProfile.skin2) +
    slotRow('object_skin', '🧱 Objets', OBJECT_SKINS, myProfile.object_skin);
  skinsEditorEl.querySelectorAll('[data-slot]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error } = await setSkin(btn.dataset.slot, btn.dataset.skin);
      if (error) { showToast('Erreur lors du changement de skin.', { type: 'error' }); return; }
      await refreshProfile();
    });
  });
}

// -------------------------------------------------------------- top joueurs
async function refreshTopPlayers() {
  topPlayersEl.innerHTML = '<p class="muted">Chargement…</p>';
  const players = await listTopPlayers(50);
  if (!players.length) { topPlayersEl.innerHTML = emptyState('Personne pour l\'instant.'); return; }
  topPlayersEl.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Joueur</th><th>Encouragements</th><th>Badges</th></tr></thead>
      <tbody>
        ${players.map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><a href="profile.html?id=${p.id}">${escapeHtml(p.display_name)}</a></td>
            <td>💪 ${p.encouragement_count}</td>
            <td>${(p.badges || []).map((id) => { const b = BADGES.find((x) => x.id === id); return b ? b.icon : ''; }).join(' ')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

refreshMyLevels();
refreshLocalDrafts();
