import { Engine } from './engine.js';
import { buildSampleLevel } from './sample-level.js';
import { deserializeLevel } from './level-model.js';
import { getLevel, recordPlay, recordWin, likeLevel, reportLevel, isBackendReady } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';

const canvas = document.getElementById('stage');
const deathsEl = document.getElementById('deaths');
const titleEl = document.getElementById('level-title');
const authorEl = document.getElementById('level-author');
const officialBadge = document.getElementById('official-badge');
const likeBtn = document.getElementById('like-btn');
const likeCountEl = document.getElementById('like-count');
const reportBtn = document.getElementById('report-btn');
const winOverlay = document.getElementById('win-overlay');
const winDeaths = document.getElementById('win-deaths');
const loadError = document.getElementById('load-error');
const accountBarEl = document.getElementById('account-bar');

function fitCanvas() {
  const maxW = Math.min(1000, window.innerWidth - 32);
  const ratio = 560 / 1000;
  canvas.width = maxW;
  canvas.height = Math.round(maxW * ratio);
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

const params = new URLSearchParams(location.search);
const remoteId = params.get('id');
const localKey = params.get('local');

let engine = null;
let session = null;

isBackendReady().then((ready) => { if (ready) mountAccountBar(accountBarEl, { onChange: (s) => { session = s; } }); });

async function loadLevel() {
  if (remoteId) {
    try {
      const { level, likes, approved } = await getLevel(remoteId);
      recordPlay(remoteId);
      likeCountEl.textContent = likes ?? 0;
      likeBtn.classList.remove('hidden');
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
  return buildSampleLevel();
}

likeBtn.addEventListener('click', async () => {
  if (!remoteId) return;
  likeBtn.disabled = true;
  const { error } = await likeLevel(remoteId);
  if (!error) likeCountEl.textContent = String(parseInt(likeCountEl.textContent, 10) + 1);
  likeBtn.disabled = false;
});

reportBtn.addEventListener('click', async () => {
  if (!remoteId) return;
  if (!session) { alert('Connecte-toi (en haut) pour signaler ce niveau.'); return; }
  const reason = prompt('Pourquoi signales-tu ce niveau officiel ?');
  if (reason === null) return;
  reportBtn.disabled = true;
  const { error } = await reportLevel(remoteId, reason);
  reportBtn.textContent = error ? '🚩 Erreur' : '🚩 Signalé ✓';
});

loadLevel().then((level) => {
  titleEl.textContent = level.title || 'Niveau';
  authorEl.textContent = level.author ? `par ${level.author}` : '';

  engine = new Engine(canvas, level, {
    onDeath: () => {
      canvas.classList.add('flash');
      setTimeout(() => canvas.classList.remove('flash'), 200);
    },
    onWin: ({ deaths }) => {
      winDeaths.textContent = deaths;
      winOverlay.classList.remove('hidden');
      if (remoteId) recordWin(remoteId);
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
