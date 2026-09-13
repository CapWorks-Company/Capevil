// Lightweight procedural sound effects via the Web Audio API. Everything is
// synthesized on the fly with oscillators/noise — no external audio files,
// so it needs zero network access and works fully offline.
const STORAGE_KEY = 'leveldevil_audio';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { muted: false, volume: 0.6 };
    const parsed = JSON.parse(raw);
    return {
      muted: !!parsed.muted,
      volume: Number.isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : 0.6,
    };
  } catch {
    return { muted: false, volume: 0.6 };
  }
}

function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore (private mode, quota…) */ }
}

let settings = loadSettings();
let ctx = null;
let masterGain = null;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = settings.muted ? 0 : settings.volume;
  masterGain.connect(ctx.destination);
  return ctx;
}

// Browsers keep a fresh AudioContext suspended until a real user gesture —
// call this from any keydown/click handler to unlock it as early as possible
// so the very first jump/press already has sound.
export function unlockAudio() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function getAudioSettings() { return { ...settings }; }

export function setMuted(muted) {
  settings.muted = !!muted;
  saveSettings(settings);
  if (masterGain) masterGain.gain.value = settings.muted ? 0 : settings.volume;
  window.dispatchEvent(new CustomEvent('leveldevil:audio-changed'));
}

export function setVolume(volume) {
  settings.volume = Math.max(0, Math.min(1, volume));
  saveSettings(settings);
  if (masterGain && !settings.muted) masterGain.gain.value = settings.volume;
  window.dispatchEvent(new CustomEvent('leveldevil:audio-changed'));
}

function tone({ freq = 440, type = 'sine', duration = 0.15, gain = 0.3, freqEnd = null, delay = 0 }) {
  const c = ensureCtx();
  if (!c || settings.muted) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g); g.connect(masterGain);
  osc.start(t0); osc.stop(t0 + duration + 0.03);
}

function noiseBurst({ duration = 0.2, gain = 0.3, delay = 0, filterFreq = 1200 }) {
  const c = ensureCtx();
  if (!c || settings.muted) return;
  const t0 = c.currentTime + delay;
  const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = filterFreq;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter); filter.connect(g); g.connect(masterGain);
  src.start(t0);
}

// Every entry is a self-contained "instrument" — a couple of short
// oscillator/noise envelopes layered together — tuned by ear rather than
// any real synthesis theory, just enough to give each event a distinct feel.
export const sfx = {
  jump()       { tone({ freq: 420, freqEnd: 780, type: 'square', duration: 0.12, gain: 0.16 }); },
  land()       { noiseBurst({ duration: 0.07, gain: 0.14, filterFreq: 450 }); },
  death()      {
    tone({ freq: 320, freqEnd: 50, type: 'sawtooth', duration: 0.42, gain: 0.22 });
    noiseBurst({ duration: 0.3, gain: 0.22, filterFreq: 900 });
  },
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, type: 'triangle', duration: 0.24, gain: 0.2, delay: i * 0.09 }));
  },
  checkpoint() { tone({ freq: 660, freqEnd: 1000, type: 'sine', duration: 0.16, gain: 0.18 }); },
  teleport()   { tone({ freq: 220, freqEnd: 1500, type: 'sine', duration: 0.24, gain: 0.18 }); },
  spring()     { tone({ freq: 180, freqEnd: 560, type: 'square', duration: 0.18, gain: 0.2 }); },
  button()     { tone({ freq: 520, type: 'square', duration: 0.06, gain: 0.14 }); },
  vanish()     { tone({ freq: 900, freqEnd: 220, type: 'sine', duration: 0.22, gain: 0.14 }); noiseBurst({ duration: 0.12, gain: 0.08, filterFreq: 2200 }); },
  appear()     { tone({ freq: 220, freqEnd: 900, type: 'sine', duration: 0.22, gain: 0.14 }); noiseBurst({ duration: 0.12, gain: 0.08, filterFreq: 2200 }); },
};
