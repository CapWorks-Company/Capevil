import { Engine } from './engine.js';
import { buildSampleLevel } from './sample-level.js';
import { deserializeLevel, createEmptyLevel } from './level-model.js';
import {
  getLevel, recordPlay, recordWin, likeLevel, hasLikedLevel, reportLevel, hasReportedLevel, isBackendReady,
  claimWinReward, listComments, postComment, getMyFullProfile, amIAdmin, adminDeleteComment, toggleOwnerLikeComment,
} from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountKeybindButton } from './keybind-ui.js';
import { showToast, promptModal } from './ui-kit.js';
import { mountAudioButton } from './audio-ui.js';
import { discoverCampaignLevels, cloneCampaignLevel, isUnlocked, claimCampaignWin } from './campaign.js';
import { CELL, GAME_VIEWPORT_MAX } from './constants.js';
import { playerSkinById, objectSkinById, skinLabel } from './catalog.js';

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
const winCoinsLine = document.getElementById('win-coins-line');
const winCoinsCount = document.getElementById('win-coins-count');
const winSkinsLine = document.getElementById('win-skins-line');
const loadError = document.getElementById('load-error');
const accountBarEl = document.getElementById('account-bar');
const commentsCard = document.getElementById('comments-card');
const commentsListEl = document.getElementById('comments-list');
const commentInput = document.getElementById('comment-input');
const commentPostBtn = document.getElementById('comment-post-btn');
const commentFormVip = document.getElementById('comment-form-vip');
const commentFormLocked = document.getElementById('comment-form-locked');

// Counts up from 0 to `amount` over about half a second — the "animation de
// l'argent" the win screen shows before the Suivant/Rejouer/Retour buttons
// are usable for real (the buttons stay clickable throughout; this is purely
// cosmetic, never blocks anything). No-ops (stays hidden) when amount is 0 —
// most commonly because nobody is signed in, since rewards are account-only.
function animateCoins(amount) {
  if (!amount) return;
  winCoinsLine.classList.remove('hidden');
  const duration = 600, start = performance.now();
  function tick(t) {
    const p = Math.min(1, (t - start) / duration);
    winCoinsCount.textContent = Math.round(amount * (1 - Math.pow(1 - p, 3))); // ease-out cubic
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// The canvas is sized to exactly match the level's own grid (cols/rows *
// CELL) — no empty letterboxed space around a small level — but never
// bigger than what the browser window actually has room for RIGHT NOW
// (measured live below), so the level's own grid size is never the reason
// the page needs scrolling. GAME_VIEWPORT_MAX (constants.js) is only the
// hard ceiling on top of that — past either limit the camera scrolls/
// follows the player instead of shrinking the world (see engine.js's
// _updateCamera).
//
// A 2-player level stacks two viewports vertically (player 1 on top, player
// 2 below — see engine.js's render/_updateCamera split): the available
// height is split between the two up front, so the whole stack still fits
// on screen instead of capping each one on its own and doubling past
// whatever room the window actually had.
function availableStageSize() {
  // Measured, not guessed: rather than hand-tallying every margin/padding
  // around the canvas (the keybind hint line's own default <p> margin, the
  // stage-wrap's padding, borders, …), collapse the canvas to ~0 for one
  // synchronous instant and see where the last element after it (the
  // keybind hint line) actually ends up — that bottom edge is exactly how
  // much vertical space everything BUT the canvas takes, correctly, even if
  // the surrounding layout changes later. No paint happens in between
  // (nothing here awaits), so this never flashes on screen.
  //
  // document.documentElement.scrollHeight can't be used for this — it's
  // clamped to be at least the viewport's own height, so it stays stuck at
  // window.innerHeight (not the true, smaller content height) whenever the
  // collapsed page is shorter than the window, which is exactly the normal
  // case here.
  const hint = document.querySelector('.keys-hint');
  const prevW = canvas.style.width, prevH = canvas.style.height;
  canvas.style.width = '0px';
  canvas.style.height = '0px';
  const chromeHeight = hint ? hint.getBoundingClientRect().bottom : 250;
  canvas.style.width = prevW;
  canvas.style.height = prevH;
  // Extra safety margin on top of the measured chrome height: the topbar's
  // nav row can wrap onto more lines once a vertical scrollbar shows up
  // (narrower available width), which only happens once the canvas grows —
  // a small chicken-and-egg the exact measurement above can't see coming.
  // Reserving a bit more than measured avoids that feedback loop tipping
  // the page into scrolling by a few px on a narrow window.
  return {
    w: Math.max(320, window.innerWidth - 32),
    h: Math.max(240, window.innerHeight - chromeHeight - 40),
  };
}

function sizeCanvasToLevel(level) {
  const avail = availableStageSize();
  const isSplit = !!level.playerStart2;
  const capW = Math.min(GAME_VIEWPORT_MAX.w, avail.w);
  const capH = Math.min(GAME_VIEWPORT_MAX.h, isSplit ? Math.floor(avail.h / 2) : avail.h);
  const w = Math.min(level.cols * CELL, capW);
  const hPerPlayer = Math.min(level.rows * CELL, capH);
  canvas.width = w;
  canvas.height = isSplit ? hPerPlayer * 2 : hPerPlayer;
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
let loadedLevel = null; // set once loadLevel() resolves — lets the resize handler re-fit the canvas later
let remoteLevelOwnerId = null; // owner_id of the published level currently loaded, or null (local/campaign level, or not loaded yet)

isBackendReady().then((ready) => { if (ready) mountAccountBar(accountBarEl, { onChange: (s) => { session = s; refreshLikeButtonState(); refreshReportButtonState(); refreshCommentFormState(s); } }); });

// A like is capped at one per account — grey the button out (without
// touching the count span inside it) once this account has already liked
// the level currently loaded.
async function refreshLikeButtonState() {
  if (!remoteId) return;
  const liked = await hasLikedLevel(remoteId);
  likeBtn.disabled = liked;
  likeBtn.title = liked ? 'Tu as déjà liké ce niveau.' : '';
}

// Same one-per-account cap as likes — grey the report button out once this
// account has already reported the level currently loaded.
async function refreshReportButtonState() {
  if (!remoteId) return;
  const reported = await hasReportedLevel(remoteId);
  if (reported) reportBtn.textContent = '🚩 Signalé ✓';
  reportBtn.disabled = reported;
  reportBtn.title = reported ? 'Tu as déjà signalé ce niveau.' : '';
}
mountKeybindButton(document.getElementById('keybind-bar'));
mountAudioButton(document.getElementById('audio-bar'));

async function loadLevel() {
  if (remoteId) {
    try {
      const { level, ownerId, likes, approved } = await getLevel(remoteId);
      remoteLevelOwnerId = ownerId;
      recordPlay(remoteId);
      likeCountEl.textContent = likes ?? 0;
      likeBtn.classList.remove('hidden');
      refreshLikeButtonState();
      if (approved) { officialBadge.classList.remove('hidden'); reportBtn.classList.remove('hidden'); refreshReportButtonState(); }
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
  const { error, reported } = await reportLevel(remoteId, reason);
  reportBtn.textContent = error ? '🚩 Erreur' : '🚩 Signalé ✓';
  if (error) showToast("Erreur lors de l'envoi du signalement.", { type: 'error' });
  else showToast(reported ? 'Signalement envoyé, merci !' : 'Tu avais déjà signalé ce niveau.', { type: 'success' });
  await refreshReportButtonState(); // stays disabled once reported; re-enables only on a genuine failure
});

loadLevel().then(async (level) => {
  titleEl.textContent = level.title || 'Niveau';
  authorEl.textContent = level.author ? `par ${level.author}` : '';
  loadedLevel = level;
  sizeCanvasToLevel(level);

  // Account cosmetics (see js/catalog.js) — signed-out players, and anyone
  // who never bought/reached a skin, fall through to null slots, which the
  // engine already treats as "keep the built-in default look".
  const myProfile = await getMyFullProfile();
  const skins = myProfile ? {
    skin1: playerSkinById(myProfile.skin1).primary ? playerSkinById(myProfile.skin1) : null,
    skin2: playerSkinById(myProfile.skin2).primary ? playerSkinById(myProfile.skin2) : null,
    objectSkin: myProfile.object_skin !== 'default' ? objectSkinById(myProfile.object_skin) : null,
  } : {};

  engine = new Engine(canvas, level, {
    skins,
    onDeath: () => {
      canvas.classList.add('flash');
      setTimeout(() => canvas.classList.remove('flash'), 200);
    },
    onWin: async ({ deaths }) => {
      winDeaths.textContent = deaths;
      winCoinsLine.classList.add('hidden');
      winSkinsLine.classList.add('hidden');
      winOverlay.classList.remove('hidden');
      if (remoteId) {
        recordWin(remoteId);
        const coins = await claimWinReward(remoteId, deaths);
        animateCoins(coins);
      }
      if (campaignIndex !== null && campaignLevels) {
        const nextIndex = campaignIndex + 1;
        if (campaignLevels[nextIndex]) {
          winNextBtn.href = `game.html?campaign=${nextIndex}`;
          winNextBtn.classList.remove('hidden');
        }
        const reward = await claimCampaignWin(campaignIndex, deaths);
        if (reward) {
          animateCoins(reward.coins_awarded);
          if (reward.new_skins && reward.new_skins.length) {
            const names = reward.new_skins.map(skinLabel);
            winSkinsLine.textContent = `🎁 Nouveau skin débloqué : ${names.join(', ')} — choisis-le dans « Mon compte ».`;
            winSkinsLine.classList.remove('hidden');
          }
        }
      }
    },
    onStateChange: ({ deaths }) => { deathsEl.textContent = deaths; },
  });
  engine.start();
  window.__engine = engine; // handy for debugging / automated testing from the console

  // Comments only make sense for a real published level (a levels.id row to
  // attach to) — a campaign level (static JSON, no DB row) or a local draft
  // never shows the section at all. Recomputes the VIP/admin/owner flags
  // here (not just refreshComments()) because `remoteLevelOwnerId` has only
  // just been set above — if the account bar's onChange already ran once
  // before this, its iAmLevelOwner check ran too early to see it.
  if (remoteId) { commentsCard.classList.remove('hidden'); refreshCommentFormState(session); }
});

// Re-fit if the window is resized after load (rotating a tablet, resizing a
// desktop window, …) — canvas.width/height can be changed freely mid-game,
// Engine just reads them fresh every frame (see render/_updateCamera).
window.addEventListener('resize', () => { if (loadedLevel) sizeCanvasToLevel(loadedLevel); });

// ------------------------------------------------------------- commentaires
// Lecture publique pour tout le monde ; poster est réservé au badge VIP (côté
// serveur — voir post_comment() — et reflété ici juste pour l'UI : le
// formulaire est simplement caché/désactivé sans ce badge plutôt que de
// laisser quelqu'un taper un commentaire pour se le voir refuser à la fin).
let iAmVip = false;
// Modération : un admin peut supprimer n'importe quel commentaire (bouton
// 🗑️ directement ici, là où le contenu à modérer est déjà affiché — pas de
// panneau séparé dans admin.html pour ça). Le créateur du niveau peut en
// plus mettre en avant un commentaire avec un ❤️ (voir toggle_owner_like_
// comment côté serveur) ; les deux droits sont indépendants et peuvent
// cumuler sur le même compte si l'admin a aussi publié ce niveau.
let iAmAdmin = false;
let iAmLevelOwner = false;

function escapeCommentHtml(s) {
  return (s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function refreshComments() {
  const { comments } = await listComments(remoteId);
  if (!comments.length) {
    commentsListEl.innerHTML = '<p>Aucun commentaire pour l\'instant.</p>';
    return;
  }
  commentsListEl.innerHTML = comments.map((c) => `
    <div class="comment-row" data-comment="${c.id}" style="padding:8px 0;border-bottom:1px solid var(--border);">
      <div class="flex-row" style="justify-content:space-between;align-items:flex-start;">
        <div>
          <strong style="color:var(--text);">${escapeCommentHtml(c.author_name || '—')}</strong>
          <span style="font-size:11px;">${new Date(c.created_at).toLocaleDateString('fr-FR')}</span>
          ${c.liked_by_owner ? '<span class="pill" style="font-size:11px;" title="Aimé par le créateur du niveau">❤️ créateur</span>' : ''}
        </div>
        <div class="flex-row" style="gap:6px;">
          ${iAmLevelOwner ? `<button class="btn small" data-heart="${c.id}" title="${c.liked_by_owner ? 'Retirer le ❤️' : 'Mettre en avant avec un ❤️'}">${c.liked_by_owner ? '❤️' : '🤍'}</button>` : ''}
          ${iAmAdmin ? `<button class="btn small danger" data-mod-delete="${c.id}" title="Supprimer (modération admin)">🗑️</button>` : ''}
        </div>
      </div>
      <div>${escapeCommentHtml(c.body)}</div>
    </div>`).join('');

  commentsListEl.querySelectorAll('button[data-heart]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { error } = await toggleOwnerLikeComment(btn.dataset.heart);
      if (error) showToast("Erreur lors de la mise à jour du ❤️.", { type: 'error' });
      await refreshComments();
    });
  });
  commentsListEl.querySelectorAll('button[data-mod-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { error } = await adminDeleteComment(btn.dataset.modDelete);
      if (error) { showToast("Erreur lors de la suppression.", { type: 'error' }); btn.disabled = false; return; }
      showToast('Commentaire supprimé ✓', { type: 'success' });
      await refreshComments();
    });
  });
}

async function refreshCommentFormState(session) {
  if (!session) {
    commentFormVip.classList.add('hidden');
    commentFormLocked.classList.add('hidden');
    iAmVip = false; iAmAdmin = false; iAmLevelOwner = false;
    if (remoteId) refreshComments();
    return;
  }
  const [profile, admin] = await Promise.all([getMyFullProfile(), amIAdmin()]);
  iAmVip = !!(profile && (profile.badges || []).includes('vip'));
  iAmAdmin = admin;
  iAmLevelOwner = !!(remoteLevelOwnerId && session.user.id === remoteLevelOwnerId);
  commentFormVip.classList.toggle('hidden', !iAmVip);
  commentFormLocked.classList.toggle('hidden', iAmVip);
  if (remoteId) refreshComments();
}

commentPostBtn.addEventListener('click', async () => {
  if (!remoteId || !iAmVip) return;
  const body = commentInput.value.trim();
  if (!body) return;
  commentPostBtn.disabled = true;
  const { error } = await postComment(remoteId, body);
  commentPostBtn.disabled = false;
  if (error) { showToast("Erreur lors de l'envoi du commentaire.", { type: 'error' }); return; }
  commentInput.value = '';
  refreshComments();
});

document.getElementById('restart-btn').addEventListener('click', () => engine && engine.reset());
document.getElementById('win-restart').addEventListener('click', () => {
  winOverlay.classList.add('hidden');
  engine && engine.reset();
});
