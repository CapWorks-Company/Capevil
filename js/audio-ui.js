// Compact inline mute toggle + volume slider, mounted next to the keybind
// button. No modal needed here (unlike auth/keybinds) — a slider is simple
// enough to live directly in the toolbar.
import { getAudioSettings, setMuted, setVolume, unlockAudio } from './audio-fx.js';

export function mountAudioButton(container) {
  const wrap = document.createElement('div');
  wrap.className = 'audio-control';
  wrap.innerHTML = `
    <button class="btn small" id="audio-mute-btn" type="button" title="Couper / activer le son"></button>
    <input type="range" id="audio-volume" min="0" max="100" step="1" title="Volume" />
  `;
  container.appendChild(wrap);

  const muteBtn = wrap.querySelector('#audio-mute-btn');
  const volumeSlider = wrap.querySelector('#audio-volume');

  function sync() {
    const s = getAudioSettings();
    muteBtn.textContent = s.muted || s.volume === 0 ? '🔇' : (s.volume < 0.4 ? '🔉' : '🔊');
    volumeSlider.value = String(Math.round(s.volume * 100));
    volumeSlider.disabled = s.muted;
  }

  muteBtn.addEventListener('click', () => {
    unlockAudio();
    setMuted(!getAudioSettings().muted);
    sync();
  });
  volumeSlider.addEventListener('input', () => {
    unlockAudio();
    setVolume(volumeSlider.valueAsNumber / 100);
    if (getAudioSettings().muted) setMuted(false);
    sync();
  });
  window.addEventListener('capevil:audio-changed', sync);

  sync();
  return wrap;
}
