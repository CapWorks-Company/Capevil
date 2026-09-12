import { Engine } from './engine.js';
import { buildSampleLevel } from './sample-level.js';
import { deserializeLevel } from './level-model.js';
import { getLevel, recordPlay, recordWin } from './supabase-client.js';

const canvas = document.getElementById('stage');
const deathsEl = document.getElementById('deaths');
const titleEl = document.getElementById('level-title');
const authorEl = document.getElementById('level-author');
const winOverlay = document.getElementById('win-overlay');
const winDeaths = document.getElementById('win-deaths');
const loadError = document.getElementById('load-error');

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

async function loadLevel() {
  if (remoteId) {
    try {
      const { level } = await getLevel(remoteId);
      recordPlay(remoteId);
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
