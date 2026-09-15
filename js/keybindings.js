// Remappable player controls, persisted in this browser (no account needed)
// so a player's preferred keys survive across visits. The engine reads
// these through buildKeyMap() instead of a hardcoded table.
//
// Two independent sets are kept — player 1 and player 2 (see level-model.js's
// playerStart2 / "2 joueurs") — under separate storage keys, each with its
// own defaults so out-of-the-box they don't collide (arrows+Espace for
// player 1, WASD+F for player 2). Every function below takes an optional
// `player` (1 or 2, defaults to 1) so existing single-player call sites don't
// need to change.
const STORAGE_KEY_P1 = 'capevil_keybinds';       // unchanged from before 2-player support, for backward compatibility
const STORAGE_KEY_P2 = 'capevil_keybinds_p2';

export const ACTIONS = ['left', 'right', 'up', 'down', 'jump'];
export const ACTION_LABELS = { left: 'Gauche', right: 'Droite', up: 'Haut', down: 'Bas', jump: 'Sauter' };

export const DEFAULT_KEYBINDS = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', jump: 'Space' };
export const DEFAULT_KEYBINDS_P2 = { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', jump: 'KeyF' };

function storageKey(player) { return player === 2 ? STORAGE_KEY_P2 : STORAGE_KEY_P1; }
function defaultsFor(player) { return player === 2 ? DEFAULT_KEYBINDS_P2 : DEFAULT_KEYBINDS; }

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

export function loadKeybinds(player = 1) {
  const defaults = defaultsFor(player);
  try {
    const raw = localStorage.getItem(storageKey(player));
    if (!raw) return { ...defaults };
    const saved = JSON.parse(raw);
    const out = { ...defaults };
    for (const a of ACTIONS) if (typeof saved[a] === 'string' || saved[a] === null) out[a] = saved[a];
    return out;
  } catch {
    return { ...defaults };
  }
}

export function saveKeybinds(binds, player = 1) {
  try { localStorage.setItem(storageKey(player), JSON.stringify(binds)); } catch { /* ignore: private mode etc. */ }
  // Any live Engine instance listens for this to pick up the change without
  // needing a page reload (see engine.js's `_onKeybindsChanged`).
  window.dispatchEvent(new Event('capevil:keybinds-changed'));
}

export function resetKeybinds(player = 1) {
  try { localStorage.removeItem(storageKey(player)); } catch { /* ignore */ }
  window.dispatchEvent(new Event('capevil:keybinds-changed'));
  return { ...defaultsFor(player) };
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
