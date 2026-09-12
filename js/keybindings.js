// Remappable player controls, persisted in this browser (no account needed)
// so a player's preferred keys survive across visits. The engine reads
// these through buildKeyMap() instead of a hardcoded table.
const STORAGE_KEY = 'leveldevil_keybinds';

export const ACTIONS = ['left', 'right', 'up', 'down', 'jump'];
export const ACTION_LABELS = { left: 'Gauche', right: 'Droite', up: 'Haut', down: 'Bas', jump: 'Sauter' };

export const DEFAULT_KEYBINDS = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', jump: 'Space' };

// Human-friendly label for a KeyboardEvent.code, for the rebind UI.
export function codeLabel(code) {
  if (!code) return '—';
  if (code === 'Space') return 'Espace';
  const arrows = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  if (arrows[code]) return arrows[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export function loadKeybinds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_KEYBINDS };
    const saved = JSON.parse(raw);
    const out = { ...DEFAULT_KEYBINDS };
    for (const a of ACTIONS) if (typeof saved[a] === 'string' || saved[a] === null) out[a] = saved[a];
    return out;
  } catch {
    return { ...DEFAULT_KEYBINDS };
  }
}

export function saveKeybinds(binds) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(binds)); } catch { /* ignore: private mode etc. */ }
  // Any live Engine instance listens for this to pick up the change without
  // needing a page reload (see engine.js's `_onKeybindsChanged`).
  window.dispatchEvent(new Event('leveldevil:keybinds-changed'));
}

export function resetKeybinds() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event('leveldevil:keybinds-changed'));
  return { ...DEFAULT_KEYBINDS };
}

// Inverts { action: code } into { code: action } for fast lookup in the
// keydown/keyup handlers. A null/unset binding is simply skipped.
export function buildKeyMap(binds) {
  const map = {};
  for (const action of ACTIONS) {
    const code = binds[action];
    if (code) map[code] = action;
  }
  return map;
}
