import { Engine } from './engine.js';
import { buildSampleLevel } from './sample-level.js';
import { deserializeLevel, createEmptyLevel } from './level-model.js';
import { getLevel, recordPlay, recordWin, likeLevel, hasLikedLevel, reportLevel, isBackendReady } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountKeybindButton } from './keybind-ui.js';
import { showToast, promptModal } from './ui-kit.js';
import { mountAudioButton } from './audio-ui.js';
import { discoverCampaignLevels, cloneCampaignLevel, isUnlocked, markCompleted } from './campaign.js';
import { CELL, GAME_VIEWPORT_MAX } from './constants.js';

const canvas = document.getElementById('stage');
const deathsEl = document.getElementById('deaths');
const titleEl = document.getElementById('level-title');
const authorEl = document.getElementById('level-author');
const officialBadge = document.getElementById('official-badge');
const campaignBadge = document.getElementById('campaign-badge');
const likeBtn = document.getElementById('like-btn');
const likeCountEl = document.getElementById('like-count');
const reportBtn = document.getElementById('report-btn');
const winOverlay = document.getElementById('win-overlay');
const winDeaths = document.getElementById('win-deaths');
const winNextBtn = document.getElementById('win-next-level');
const loadError = document.getElementById('load-error');
const accountBarEl = document.getElementById('account-bar');

// The canvas is sized to exactly match the level's own grid (cols/rows *
// CELL) — no empty letterboxed space around a small level — capped at
// GAME_VIEWPORT_MAX for a big one (beyond that the camera scrolls/follows
// the player instead of shrinking the world; see engine.js's
// _updateCamera). A narrow browser window still scales the whole canvas
// down visually via the `max-width:100%` CSS rule on #stage, without
// touching this buffer size or the gameplay coordinate space at all.
function sizeCanvasToLevel(level) {
  canvas.width = Math.min(level.cols * CELL, GAME_VIEWPORT_MAX.w);
  canvas.height = Math.min(level.rows * CELL, GAME_VIEWPORT_MAX.h);
}

const params = new URLSearchParams(location.search);
const remoteId = params.get('id');
const localKey = params.get('local');
// The 🗺️ Aventure campaign (see js/campaign.js) — an index into the
// auto-discovered level list, e.g. game.html?campaign=0 for "Niveau 1".
const campaignParam = params.get('campaign');
const campaignIndex = campaignParam !== null ? parseInt(campaignParam, 10) : null;
let campaignLevels = null; // set by loadLevel() once discovery resolves — onWin reuses it to find "the next one".

let engine = null;
let session = null;

isBackendReady().then((ready) => { if (ready) mountAccountBar(accountBarEl, { onChange: (s) => { session = s; refreshLikeButtonState(); } }); });

// A like is capped at one per account — grey the button out (without
// touching the count span inside it) once this account has already liked
// the level currently loaded.
async function refreshLikeButtonState() {
  if (!remoteId) return;
  const liked = await hasLikedLevel(remoteId);
  likeBtn.disabled = liked;
  likeBtn.title = liked ? 'Tu as déjà liké ce niveau.' : '';
}
mountKeybindButton(document.getElementById('keybind-bar'));
mountAudioButton(document.getElementById('audio-bar'));

async function loadLevel() {
  if (remoteId) {
    try {
      const { level, likes, approved } = await getLevel(remoteId);
      recordPlay(remoteId);
      likeCountEl.textContent = likes ?? 0;
      likeBtn.classList.remove('hidden');
      refreshLikeButtonState();
      if (approved) { officialBadge.classList.remove('hidden'); reportBtn.classList.remove('hidden'); }
      return level;
    } catch (err) {
      loadError.textContent = "Impossible de charger ce niveau (Supabase non configuré ou niveau introuvable).";
      loadError.classList.remove('hidden');
      return buildSampleLevel();
    }
  }
  if (localKey) {
    const raw = localStorage.getItem(localKey);
    if (raw) return deserializeLevel(raw);
  }
  if (campaignIndex !== null) {
    campaignLevels = await discoverCampaignLevels();
    const entry = campaignLevels[campaignIndex];
    if (!entry) {
      loadError.textContent = "Ce niveau d'aventure n'existe pas.";
      loadError.classList.remove('hidden');
      return createEmptyLevel('Niveau introuvable');
    }
    if (!isUnlocked(campaignIndex)) {
      loadError.textContent = "Ce niveau d'aventure n'est pas encore débloqué — termine le précédent d'abord.";
      loadError.classList.remove('hidden');
      return createEmptyLevel('Niveau verrouillé');
    }
    campaignBadge.textContent = `🗺️ Aventure — niveau ${campaignIndex + 1}`;
    campaignBadge.classList.remove('hidden');
    return cloneCampaignLevel(entry);
  }
  return buildSampleLevel();
}

likeBtn.addEventListener('click', async () => {
  if (!remoteId) return;
  if (!session) { showToast('Connecte-toi (en haut) pour liker ce niveau.', { type: 'error' }); return; }
  likeBtn.disabled = true;
  const { error, liked } = await likeLevel(remoteId);
  if (!error && liked) likeCountEl.textContent = String(parseInt(likeCountEl.textContent, 10) + 1);
  await refreshLikeButtonState(); // stays disabled once liked; re-enables only on a genuine failure
});

reportBtn.addEventListener('click', async () => {
  if (!remoteId) return;
  if (!session) { showToast('Connecte-toi (en haut) pour signaler ce niveau.', { type: 'error' }); return; }
  const reason = await promptModal('Explique brièvement pourquoi ce niveau officiel pose problème.', {
    title: '🚩 Signaler ce niveau', placeholder: 'Raison du signalement…', okLabel: 'Signaler', multiline: true,
  });
  if (reason === null) return;
  reportBtn.disabled = true;
  const { error } = await reportLevel(remoteId, reason);
  reportBtn.textContent = error ? '🚩 Erreur' : '🚩 Signalé ✓';
  showToast(error ? "Erreur lors de l'envoi du signalement." : 'Signalement envoyé, merci !', { type: error ? 'error' : 'success' });
});

loadLevel().then((level) => {
  titleEl.textContent = level.title || 'Niveau';
  authorEl.textContent = level.author ? `par ${level.author}` : '';
  sizeCanvasToLevel(level);

  engine = new Engine(canvas, level, {
    onDeath: () => {
      canvas.classList.add('flash');
      setTimeout(() => canvas.classList.remove('flash'), 200);
    },
    onWin: ({ deaths }) => {
      winDeaths.textContent = deaths;
      winOverlay.classList.remove('hidden');
      if (remoteId) recordWin(remoteId);
      if (campaignIndex !== null && campaignLevels) {
        markCompleted(campaignIndex);
        const nextIndex = campaignIndex + 1;
        if (campaignLevels[nextIndex]) {
          winNextBtn.href = `game.html?campaign=${nextIndex}`;
          winNextBtn.classList.remove('hidden');
        }
      }
    },
    onStateChange: ({ deaths }) => { deathsEl.textContent = deaths; },
  });
  engine.start();
  window.__engine = engine; // handy for debugging / automated testing from the console
});

document.getElementById('restart-btn').addEventListener('click', () => engine && engine.reset());
document.getElementById('win-restart').addEventListener('click', () => {
  winOverlay.classList.add('hidden');
  engine && engine.reset();
});
