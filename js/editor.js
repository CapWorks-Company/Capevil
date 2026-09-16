import {
  CELL, ENTITY_TYPES, ACTION_TYPES, GRAVITY_DIRS, GRID_LIMITS,
  ENTITY_TOGGLES, TOGGLE_LABELS, togglesForType, FACING_LABELS,
  TELEPORTER_MAX_PER_FREQUENCY, TELEPORTER_FREQUENCIES,
  LAYER_MIN, LAYER_MAX, clampLayer,
  RELEASE_MODE_LABELS, ACTIVATOR_LABELS,
  PLATE_PRESS_MODE_LABELS,
} from './constants.js';
import {
  createEmptyLevel, createEntity, createAction, cloneLevel, findEntity,
  removeEntity, validateLevel, uid, normalizeLevel, nextTeleporterFrequency,
} from './level-model.js';
import { buildSampleLevel } from './sample-level.js';
import { Engine } from './engine.js';
import { saveLocalDraft, loadLocalDraft } from './local-storage.js';
import { publishLevel, updateOwnLevel, getLevel, isBackendReady, getSession, getMyProfile, canSignIn } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountKeybindButton } from './keybind-ui.js';
import { mountAudioButton } from './audio-ui.js';
import { showToast, confirmModal } from './ui-kit.js';

// ---------------------------------------------------------------- palette
const PALETTE = [
  { type: ENTITY_TYPES.BLOCK, label: 'Bloc solide', color: '#111319', icon: '🧱' },
  { type: ENTITY_TYPES.SPIKE, label: 'Pointes', color: '#e63946', icon: '🔺' },
  { type: ENTITY_TYPES.SPRING, label: 'Ressort (haut/bas)', color: '#ffd166', icon: '🌀' },
  { type: ENTITY_TYPES.FAN, label: 'Ventilateur (vent)', color: '#48cae4', icon: '🌬️' },
  { type: ENTITY_TYPES.SPINNER, label: 'Roue tournante', color: '#c9184a', icon: '⚙️' },
  { type: ENTITY_TYPES.TELEPORTER, label: 'Téléporteur', color: '#9d4edd', icon: '🛸' },
  { type: ENTITY_TYPES.CHECKPOINT, label: 'Checkpoint', color: '#118ab2', icon: '🚩' },
  { type: ENTITY_TYPES.GOAL, label: 'Arrivée (but)', color: '#2ec4b6', icon: '🏆' },
  { type: ENTITY_TYPES.TRIGGER, label: 'Zone de trigger (invisible)', color: '#f4d35e', icon: '👁️' },
  { type: ENTITY_TYPES.BUTTON, label: 'Bouton (visible, répétable)', color: '#06d6a0', icon: '🔘' },
  { type: ENTITY_TYPES.PLATE, label: 'Plaque de pression', color: '#c98a2b', icon: '🟫' },
  { type: ENTITY_TYPES.CRATE, label: 'Cube poussable', color: '#8a5a34', icon: '📦' },
];

const ACTION_LABELS = {
  [ACTION_TYPES.MOVE_ELEMENT]: 'Déplacer un élément',
  [ACTION_TYPES.TELEPORT]: 'Téléporter un élément',
  [ACTION_TYPES.SET_WORLD_STATE]: "Changer l'état du monde",
  [ACTION_TYPES.SET_STATE]: "Changer l'état d'un élément",
  [ACTION_TYPES.SET_PLAYER_STATE]: 'Changer l\'état du joueur',
};
// An action's target: MOVE_ELEMENT/TELEPORT/SET_STATE act on a chosen entity;
// only TELEPORT may also target the player directly (that's its whole job —
// MOVE_ELEMENT explicitly can't, since "moving" the player is what a
// teleporter is for). SET_WORLD_STATE/SET_PLAYER_STATE never need a target:
// they always act on the level itself / the player.
const NEEDS_TARGET = new Set([ACTION_TYPES.MOVE_ELEMENT, ACTION_TYPES.TELEPORT, ACTION_TYPES.SET_STATE]);
const ALLOWS_PLAYER_TARGET = new Set([ACTION_TYPES.TELEPORT]);

const GRAVITY_LABELS = { down: 'Bas (normal)', up: 'Haut', left: 'Gauche', right: 'Droite' };

// ---------------------------------------------------------------- state
let level = null;
let tool = 'select';
let selectedId = null; // an entity id, the string 'playerstart', or null
let pickingTargetFor = null; // { onPick } while armed to pick a target on canvas
let playtesting = false;
let testEngine = null;
let session = null;       // current Supabase Auth session, kept in sync via onAuthChange
let editingRemoteId = null; // set when this editor session is editing an already-published level
let previewMode = false;  // read-only admin preview: full editor view, nothing can be changed/saved
let authGateBypass = false; // true once canSignIn() comes back false (Supabase unreachable) — see updateAuthGate
let showCoordOverlay = false; // true while a "Téléporter un élément" action's x/y field has focus
let blockViewIds = new Set(); // entity ids currently showing their actions as "blocs" (see renderActionBlock) instead of the compact list
let bottomTab = 'hierarchy'; // 'hierarchy' | 'actions' — which panel occupies the shared slot below the canvas
let dragActionId = null; // action.id currently being dragged in the Actions panel, or null
let actionsPanelTarget = 'press'; // 'press' | 'release' — for a PLATE only, which of its two action lists the
                                   // Actions panel is currently showing (TRIGGER/BUTTON only ever have 'press').
let lastActionsEntityId = null; // last entity id renderActionsPanel ran for — lets it reset actionsPanelTarget
                                 // back to 'press' whenever the selection changes to a different entity.
let hiddenLayers = new Set(); // `layer` values currently toggled off in the layers panel — a view filter only,
                               // never saved with the level and never touched by anything but that panel.
let editRealView = false; // "🎬 Voir le jeu" — read-only static preview of exactly what the real game
                           // renders (no grid/trigger zones/invisible entities/edit-only dimming), toggled
                           // straight from the edit canvas, no playtest needed — see render()/handleCellClick.
let propsTab = 'actions'; // 'general' | 'actions' | 'activation' — for TRIGGER/BUTTON/PLATE only, which of the
                           // props panel's tabs is showing (see renderPropsTabBar). Defaults to "Actions" — what
                           // these three exist for, and what used to sit immediately visible right below Général
                           // before this tab split — not "Général", so selecting one still lands you straight on
                           // its action list exactly like before. Other entity types have too little to configure
                           // to need tabs at all and keep a single flat panel.
let lastPropsTabEntityId = null; // last entity id renderProps ran the tab logic for — resets propsTab back to
                                  // 'general' whenever the selection changes to a different entity (staying on
                                  // the SAME entity, e.g. after an edit, preserves whichever tab was open).

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const toolboxEl = document.getElementById('toolbox');
const propsEl = document.getElementById('props');
const hierarchyEl = document.getElementById('hierarchy');
const actionsPanelEl = document.getElementById('actions-panel');
const layersPanelEl = document.getElementById('layers-panel');
const titleInput = document.getElementById('level-title-input');
const authorInput = document.getElementById('level-author-input');
const colsInput = document.getElementById('cols-input');
const rowsInput = document.getElementById('rows-input');
const worldGravityInput = document.getElementById('ws-gravity');
const worldBgInput = document.getElementById('ws-bg');
const authGateEl = document.getElementById('auth-gate');
const editorMainEl = document.getElementById('editor-main');
const ceilingGlitchInput = document.getElementById('ws-ceiling-glitch');
const statusEl = document.getElementById('status-msg');
const pickBanner = document.getElementById('pick-banner');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff8a8a' : 'var(--muted)';
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}

// ---------------------------------------------------------------- undo / redo
// Snapshot-based rather than instrumented at every mutation call site: there
// are dozens of scattered places `level` gets mutated (props-panel field
// bindings, palette placement, canvas clicks, hierarchy clicks, the world-
// condition modal…) and instrumenting each one individually is exactly the
// kind of thing that quietly goes stale the next time a feature is added.
// Instead we watch the whole document for click/change/keyup — the DOM
// events every one of those mutations is ultimately driven by — and, a tick
// later (so the handler has already finished mutating `level`), compare its
// serialized JSON against the last recorded snapshot. Any difference becomes
// one undo step. This is deliberately named `undoStack`/`undoIndex`, NOT
// `history` — editor.js already uses the bare global `history` (the
// browser's own History API, see "Sauver (local)"'s `history.replaceState`)
// and a module-level `let history = …` would silently shadow it everywhere.
const UNDO_LIMIT = 200;
let undoStack = [];   // JSON strings, oldest first
let undoIndex = -1;   // index into undoStack matching the CURRENT level state
let lastSnapshot = null;
let suppressUndoCapture = false; // true while undo()/redo() itself is restoring a snapshot, so that restore doesn't get re-captured as a new edit

function snapshotLevel() { return JSON.stringify(level); }

// Called once `level` is in its real starting state (after init(), and again
// after "Nouveau", "Charger la démo" or "Importer JSON" fully replace it) —
// resets the undo stack to a single entry so Ctrl+Z can never reach back
// into a previous, now-irrelevant level.
function initUndoHistory() {
  const snap = snapshotLevel();
  undoStack = [snap];
  undoIndex = 0;
  lastSnapshot = snap;
  updateUndoRedoButtons();
}

function captureUndoStep() {
  if (suppressUndoCapture || !level) return;
  const snap = snapshotLevel();
  if (snap === lastSnapshot) return; // nothing actually changed
  undoStack = undoStack.slice(0, undoIndex + 1); // drop any redo branch
  undoStack.push(snap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  undoIndex = undoStack.length - 1;
  lastSnapshot = snap;
  updateUndoRedoButtons();
}
function scheduleUndoCapture() { setTimeout(captureUndoStep, 0); }
document.addEventListener('click', scheduleUndoCapture, true);
document.addEventListener('change', scheduleUndoCapture, true);
document.addEventListener('keyup', scheduleUndoCapture, true);

function restoreUndoSnapshot(snap) {
  suppressUndoCapture = true;
  level = normalizeLevel(JSON.parse(snap));
  lastSnapshot = snap;
  selectedId = null;
  pickingTargetFor = null;
  pickBanner.classList.add('hidden');
  tool = 'select';
  syncHeaderInputs();
  buildPalette();
  resizeCanvas();
  render();
  renderProps();
  updateUndoRedoButtons();
  suppressUndoCapture = false;
}
function undo() {
  if (previewMode || playtesting || undoIndex <= 0) return;
  undoIndex--;
  restoreUndoSnapshot(undoStack[undoIndex]);
}
function redo() {
  if (previewMode || playtesting || undoIndex >= undoStack.length - 1) return;
  undoIndex++;
  restoreUndoSnapshot(undoStack[undoIndex]);
}
function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = previewMode || playtesting || undoIndex <= 0;
  if (redoBtn) redoBtn.disabled = previewMode || playtesting || undoIndex >= undoStack.length - 1;
}
// Ctrl+Z / Cmd+Z to undo, Ctrl+Shift+Z (or Ctrl+Y) to redo — but not while the
// keybind-rebind modal is actively capturing a keypress (its own capture-
// phase listener in keybind-ui.js calls preventDefault() in that case, which
// we detect via e.defaultPrevented since it always runs before this bubble-
// phase listener), and not while typing in the level-title text field, so
// the browser's native undo-within-a-text-field still works there.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
  if (!isUndo && !isRedo) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'))) return;
  e.preventDefault();
  if (isRedo) redo(); else undo();
});

// ---------------------------------------------------------------- init
async function init() {
  const params = new URLSearchParams(location.search);
  const localKey = params.get('local');
  const wantDemo = params.get('demo') === '1';
  const editId = params.get('edit');
  const previewId = params.get('preview');
  if (previewId) {
    // Admin-only read-only preview (reported / pending-approval / official
    // levels): reuses the exact same full editor rendering — invisible/
    // passable entities revealed, every mechanic visible — so an admin sees
    // everything a player wouldn't. Loading works just like `edit=`, but
    // nothing here is ever wired up to save.
    try {
      const { level: remoteLevel } = await getLevel(previewId);
      level = remoteLevel;
      level.localKey = null;
      previewMode = true;
    } catch {
      setStatus("Impossible de charger ce niveau pour l'aperçu.", true);
      level = createEmptyLevel();
    }
  } else if (editId) {
    try {
      const { level: remoteLevel } = await getLevel(editId);
      level = remoteLevel;
      level.localKey = null;
      editingRemoteId = editId;
    } catch {
      setStatus("Impossible de charger ce niveau pour modification.", true);
      level = createEmptyLevel();
    }
  } else if (localKey) {
    const draft = loadLocalDraft(localKey);
    level = draft ? { ...normalizeLevel(draft), localKey } : createEmptyLevel();
  } else if (wantDemo) {
    level = buildSampleLevel();
    level.localKey = null;
  } else {
    // A new level always starts empty — the demo is only ever loaded on
    // explicit request (via "Charger la démo"), never silently.
    level = createEmptyLevel();
    level.localKey = null;
  }
  syncHeaderInputs();
  buildPalette();
  resizeCanvas();
  render();
  renderProps();
  initUndoHistory();
  bindToolbar();
  bindCanvas();
  bindBottomTabs();
  bindLayersPanel();
  mountKeybindButton(document.getElementById('keybind-bar'));
  mountAudioButton(document.getElementById('audio-bar'));
  if (previewMode) applyPreviewModeUI();

  const accountBar = document.getElementById('account-bar');
  if (accountBar) {
    mountAccountBar(accountBar, {
      onChange: async (s) => {
        session = s;
        await syncAuthorField();
        updatePublishButtonState();
        updateAuthGate();
      },
    });
  } else {
    session = await getSession();
    await syncAuthorField();
  }
  // A second, identical account widget inside the gate card itself — signing
  // in there (or in the topbar one, they're both wired to the same Supabase
  // auth state) reveals the builder via the onChange callback above.
  const authGateBar = document.getElementById('auth-gate-bar');
  if (authGateBar) mountAccountBar(authGateBar);
  // If the Supabase client itself can't be reached (network hiccup, blocked
  // CDN — see canSignIn()'s own comment), signing in isn't actually possible
  // right now: bypass the gate rather than permanently locking everyone out
  // of building levels over a transient failure that has nothing to do with
  // whether they have an account.
  authGateBypass = !(await canSignIn());
  updateAuthGate();
}

// Building a level requires an account — signed out, the whole builder stays
// behind #auth-gate (see the card in editor.html) instead of just gating the
// "🚀 Publier" button like before, so a level Caroline builds is never only
// sitting in this one browser's local storage: it's tied to her account from
// the very first entity she places. The admin-only read-only preview
// (?preview=, see init()) is exempt — it never lets you change anything
// regardless of session, so there's nothing here that needs protecting. Also
// bypassed when Supabase itself is unreachable (authGateBypass) — see the
// canSignIn() call above.
function updateAuthGate() {
  if (!authGateEl || !editorMainEl) return;
  const show = previewMode || !!session || authGateBypass;
  authGateEl.classList.toggle('hidden', show);
  editorMainEl.classList.toggle('hidden', !show);
}

// The author name is always the signed-in account's display name — never a
// free-typed field — so publishing under someone else's name isn't possible.
async function syncAuthorField() {
  if (session) {
    const profile = await getMyProfile();
    authorInput.value = profile ? profile.display_name : '';
    level.author = authorInput.value;
    authorInput.readOnly = true;
    authorInput.title = 'Ton nom d\'auteur vient de ton compte.';
  } else {
    authorInput.readOnly = true;
    authorInput.value = '';
    authorInput.title = 'Connecte-toi pour publier sous ton nom.';
  }
}

function updatePublishButtonState() {
  const btn = document.getElementById('publish-btn');
  if (!btn) return;
  btn.textContent = editingRemoteId ? '💾 Enregistrer les modifications' : '🚀 Publier';
  btn.title = session ? '' : 'Connecte-toi (ou crée un compte) pour publier.';
}

function syncHeaderInputs() {
  titleInput.value = level.title || '';
  colsInput.value = level.cols;
  rowsInput.value = level.rows;
  if (worldGravityInput) worldGravityInput.value = level.gravityScale ?? 1;
  if (worldBgInput) worldBgInput.value = level.background || '#1b1e2b';
  if (ceilingGlitchInput) ceilingGlitchInput.checked = !!level.ceilingJumpGlitch;
  updateLevelSettingsLabel();
  updatePublishButtonState();
}

function resizeCanvas() {
  canvas.width = level.cols * CELL;
  canvas.height = level.rows * CELL;
}

// Locks the editor into a pure viewer: no placing/moving/erasing entities,
// no publishing/saving/importing, palette hidden (nothing to place). Used
// for the admin panel's "Aperçu" links on reported/pending/official levels
// so an admin sees the exact same full-detail view a level's own author
// gets in the editor (invisible/passable entities revealed, etc.) without
// any risk of accidentally overwriting the level.
function applyPreviewModeUI() {
  const banner = document.getElementById('preview-banner');
  if (banner) banner.classList.remove('hidden');
  if (toolboxEl) toolboxEl.style.display = 'none';
  tool = 'select';
  ['new-level', 'load-demo', 'save-local', 'undo-btn', 'redo-btn', 'export-json', 'publish-btn', 'level-settings-btn',
    'shift-up', 'shift-down', 'shift-left', 'shift-right', 'shift-step']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = true; });
  const importInput = document.getElementById('import-json');
  if (importInput) { importInput.disabled = true; importInput.closest('label')?.classList.add('hidden'); }
  titleInput.readOnly = true;
}

// Small glanceable summary on the "🌍 Condition du monde" toolbar button, so
// the grid size (and any non-default gravity) is visible without opening the
// settings panel.
function updateLevelSettingsLabel() {
  const label = document.getElementById('level-settings-label');
  if (!label) return;
  const bits = [`${level.cols}×${level.rows}`];
  if (Number.isFinite(level.gravityScale) && level.gravityScale !== 1) bits.push(`gravité ${level.gravityScale}×`);
  label.textContent = `(${bits.join(' · ')})`;
}

// ---------------------------------------------------------------- palette UI
function buildPalette() {
  toolboxEl.innerHTML = '<h3 style="margin-top:0;">Outils</h3>';
  const selectBtn = paletteButton('select', 'Sélection / déplacer', '#888', '↖️');
  const eraseBtn = paletteButton('erase', 'Gomme', '#555', '🧽');
  const startBtn = paletteButton('playerstart', 'Départ joueur', '#f77f00', '🧍');
  // "2 joueurs": placing this the first time turns the second player on for
  // this level (see handleCellClick); it stays available afterward to move
  // player 2's spawn, and can be removed again from its own props panel
  // (renderPlayerStartProps).
  const start2Btn = paletteButton('playerstart2', level.playerStart2 ? 'Départ joueur 2' : 'Départ joueur 2 (activer)', '#2ec4ff', '🧍');
  toolboxEl.append(selectBtn, startBtn, start2Btn, eraseBtn);
  const hr = document.createElement('hr');
  hr.className = 'toolbox-sep';
  toolboxEl.appendChild(hr);
  for (const p of PALETTE) toolboxEl.appendChild(paletteButton(p.type, p.label, p.color, p.icon));
}

function paletteButton(toolId, label, color, icon = '') {
  const btn = document.createElement('button');
  btn.className = 'palette-btn' + (tool === toolId ? ' active' : '');
  btn.dataset.tool = toolId;
  btn.innerHTML = `<span class="palette-swatch" style="background:${color}">${icon}</span>${label}`;
  btn.addEventListener('click', () => { tool = toolId; selectedId = null; buildPalette(); render(); renderProps(); });
  return btn;
}

// True while `ent` sits on a `layer` value currently hidden in the layers
// panel — a pure editor view-state check, never persisted with the level.
function isHiddenEntity(ent) {
  return !!ent && hiddenLayers.has(clampLayer(ent.layer || 0));
}

// ---------------------------------------------------------------- rendering (static edit view)
function render() {
  if (playtesting) return;
  ctx.fillStyle = level.background || '#1b1e2b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "🎬 Voir le jeu" (editRealView) swaps the canvas to exactly what the real
  // game shows — same rule the playtest engine uses for its own debug/real
  // toggle (see engine.js's debugTriggers): no grid, no trigger zones, no
  // invisible entities, no dimming for passable/harmless (those never change
  // an entity's look in real play — see engine.js's _renderEntity). It's a
  // read-only preview: handleCellClick bails out immediately while it's on.
  if (!editRealView) {
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let c = 0; c <= level.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke(); }
    for (let r = 0; r <= level.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke(); }
  }

  // Same purely-cosmetic layer split as the real game engine (see engine.js's
  // render()): layer<=0 entities draw behind the player-start marker,
  // layer>0 in front of it — a stable sort keeps layer-0 entities in their
  // original order so an untouched level looks exactly as before.
  const layerSorted = [...level.entities].sort((a, b) => (a.layer || 0) - (b.layer || 0));
  // A TRIGGER zone is invisible in real play, same as anything explicitly
  // flagged invisible (engine.js's _renderEntity/TRIGGER render case).
  const visibleInView = (ent) => !isHiddenEntity(ent) && !(editRealView && (ent.invisible || ent.type === ENTITY_TYPES.TRIGGER));
  for (const ent of layerSorted) { if ((ent.layer || 0) <= 0 && visibleInView(ent)) drawEntity(ent); }
  if (!editRealView) drawTriggerLinks();
  if (!editRealView && showCoordOverlay) drawCoordOverlay();

  // player start marker(s) — player 2's uses the same blue as its in-game
  // sprite (see engine.js's _renderPlayer) so the two are never confused.
  // An invisible spawn draws nothing at all in real view (no 👻 hint either
  // — that hint is itself an edit-only aid for something real play hides).
  const ps = level.playerStart;
  if (!(editRealView && ps.invisible)) {
    ctx.fillStyle = 'rgba(247,127,0,0.85)';
    ctx.fillRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);
    if (ps.invisible && !editRealView) { ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('👻', ps.x * CELL + CELL / 2, ps.y * CELL + CELL / 2 + 4); }
  }
  const ps2 = level.playerStart2;
  if (ps2 && !(editRealView && ps2.invisible)) {
    ctx.fillStyle = 'rgba(46,196,255,0.85)';
    ctx.fillRect(ps2.x * CELL + 6, ps2.y * CELL + 6, CELL - 12, CELL - 12);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(ps2.x * CELL + 6, ps2.y * CELL + 6, CELL - 12, CELL - 12);
    if (ps2.invisible && !editRealView) { ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('👻', ps2.x * CELL + CELL / 2, ps2.y * CELL + CELL / 2 + 4); }
  }

  for (const ent of layerSorted) { if ((ent.layer || 0) > 0 && visibleInView(ent)) drawEntity(ent); }

  if (!editRealView) {
    if (selectedId === 'playerstart') {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.strokeRect(ps.x * CELL - 2, ps.y * CELL - 2, CELL + 4, CELL + 4);
    } else if (selectedId === 'playerstart2' && ps2) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.strokeRect(ps2.x * CELL - 2, ps2.y * CELL - 2, CELL + 4, CELL + 4);
    } else if (selectedId) {
      const ent = findEntity(level, selectedId);
      if (ent && !isHiddenEntity(ent)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(ent.x * CELL - 2, ent.y * CELL - 2, ent.w * CELL + 4, ent.h * CELL + 4);
      }
    }
  }
  renderBottomPanel();
  renderLayersPanel();
}

// ---------------------------------------------------------------- hierarchy / actions tab
// Hiérarchie and Actions share one slot below the canvas — switching tabs
// just swaps which of the two divs is visible, no layout reflow. Called from
// render() so both panels always reflect the current selection/edits.
function renderBottomPanel() {
  if (hierarchyEl) hierarchyEl.classList.toggle('hidden', bottomTab !== 'hierarchy');
  if (actionsPanelEl) actionsPanelEl.classList.toggle('hidden', bottomTab !== 'actions');
  renderHierarchy();
  renderActionsPanel();
}

function switchBottomTab(tab) {
  bottomTab = tab;
  const hTab = document.getElementById('tab-hierarchy');
  const aTab = document.getElementById('tab-actions');
  if (hTab) hTab.classList.toggle('active', tab === 'hierarchy');
  if (aTab) aTab.classList.toggle('active', tab === 'actions');
  renderBottomPanel();
}

function bindBottomTabs() {
  const hTab = document.getElementById('tab-hierarchy');
  const aTab = document.getElementById('tab-actions');
  if (hTab) hTab.addEventListener('click', () => switchBottomTab('hierarchy'));
  if (aTab) aTab.addEventListener('click', () => switchBottomTab('actions'));
}

// One delegated listener bound once on the stable #layers-panel element
// (never itself replaced — only its innerHTML is, on every renderLayersPanel
// call), instead of rebinding a listener to each row button on every
// render. See the comment in renderLayersPanel for why per-button listeners
// aren't safe here.
function bindLayersPanel() {
  if (!layersPanelEl) return;
  // Clicking a row right after editing a numeric props field (typically
  // "Couche" itself) would otherwise blur that field first — committing its
  // value via a native 'change' event and re-rendering this very panel
  // mid-click. If that swaps out the row under the pointer between
  // mousedown and mouseup, some browsers drop the click entirely. Stopping
  // the mousedown's default focus-shift keeps the field focused (its value
  // still commits normally whenever it's blurred some other way) so the
  // click always lands on a stable, still-attached target.
  layersPanelEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-layer], #layers-show-all')) e.preventDefault();
  });
  layersPanelEl.addEventListener('click', (e) => {
    if (e.target.closest('#layers-show-all')) { hiddenLayers.clear(); render(); return; }
    const row = e.target.closest('[data-layer]');
    if (!row) return;
    const l = Number(row.dataset.layer);
    if (hiddenLayers.has(l)) hiddenLayers.delete(l); else hiddenLayers.add(l);
    render();
  });
}

// The Actions panel: a Scratch-like canvas for the CURRENTLY SELECTED
// trigger/bouton/plaque's action list — the same "block" cards as before
// (see renderActionBlock), but given the whole bottom slot instead of the
// narrow props panel, and drag-and-drop reorderable. Selecting something
// else (or nothing, or the player spawn) just shows a placeholder — it never
// changes tabs on its own, so flipping through entities while this tab is
// open stays on the Actions tab.
function renderActionsPanel() {
  if (!actionsPanelEl || bottomTab !== 'actions') return;
  const ent = (selectedId && selectedId !== 'playerstart' && selectedId !== 'playerstart2') ? findEntity(level, selectedId) : null;
  if (!ent || !hasActionListType(ent.type)) {
    lastActionsEntityId = null;
    actionsPanelEl.innerHTML = `<p class="muted empty" style="font-size:12.5px;margin:4px 0;">Sélectionne un trigger, un bouton ou une plaque de pression pour assembler ses actions ici.</p>`;
    return;
  }
  // Switching to a different entity always lands back on its "press" list —
  // only staying on the SAME plate preserves whichever sub-tab was open.
  if (ent.id !== lastActionsEntityId) { actionsPanelTarget = 'press'; lastActionsEntityId = ent.id; }
  const isPlate = ent.type === ENTITY_TYPES.PLATE;
  const onRelease = isPlate && actionsPanelTarget === 'release';
  const actions = (onRelease ? ent.props.releaseActions : ent.props.actions) || [];
  const blocksHtml = actions.map((a) => `
    <div class="action-block-slot" data-drag-id="${a.id}">${renderActionBlock(a)}</div>`).join('');
  // A PLATE gets two little sub-tabs (its press list and its separate
  // release list); TRIGGER/BUTTON only ever have the one list, no sub-tabs.
  const subTabsHtml = isPlate ? `
    <div class="subtabs">
      <button type="button" class="btn small${onRelease ? '' : ' active'}" id="ap-tab-press">⬇️ Appui</button>
      <button type="button" class="btn small${onRelease ? ' active' : ''}" id="ap-tab-release">⬆️ Relâchement</button>
    </div>` : '';
  // The press list keeps its "Boucle infinie" checkbox for TRIGGER/BUTTON
  // (unchanged); a PLATE's press list gets the fuller 3-way select instead
  // (une fois / tant que maintenu / boucle) since it's no longer just a
  // boolean. The release list has neither — it's inherently a single fire —
  // and gets its own "fermer définitivement" checkbox instead.
  const modeControlHtml = onRelease
    ? `<label class="toggle-row" style="margin:0;"><input type="checkbox" id="ap-close-release" ${ent.props.closeOnRelease ? 'checked' : ''} />Fermer définitivement après</label>`
    : (isPlate
      ? `<label style="margin:0;display:flex;align-items:center;gap:6px;">À l'appui : ${selectHtml('ap-press-mode', PLATE_PRESS_MODE_LABELS, ent.props.pressMode || 'hold')}</label>`
      : `<label class="toggle-row" style="margin:0;"><input type="checkbox" id="ap-loop" ${ent.props.loop ? 'checked' : ''} />Boucle infinie</label>`);
  actionsPanelEl.innerHTML = `
    ${subTabsHtml}
    <div class="actions-panel-header">
      <span class="pill type-badge">${paletteLabel(ent.type)}</span>
      ${modeControlHtml}
      <span class="spacer"></span>
      <button type="button" class="btn small primary" id="ap-add-action">+ Ajouter une action</button>
    </div>
    <div id="actions-panel-list">
      ${blocksHtml || '<p class="muted empty" style="font-size:12.5px;">Aucune action pour l\'instant — clique « + Ajouter une action ».</p>'}
    </div>`;
  bindActionsPanel(ent, onRelease);
  if (previewMode) {
    actionsPanelEl.querySelectorAll('input, select, button, textarea').forEach((el) => { el.disabled = true; });
  }
}

function bindActionsPanel(ent, onRelease) {
  const pressTab = document.getElementById('ap-tab-press');
  const releaseTab = document.getElementById('ap-tab-release');
  if (pressTab) pressTab.addEventListener('click', () => { actionsPanelTarget = 'press'; renderActionsPanel(); });
  if (releaseTab) releaseTab.addEventListener('click', () => { actionsPanelTarget = 'release'; renderActionsPanel(); });
  const loopChk = document.getElementById('ap-loop');
  if (loopChk) loopChk.addEventListener('change', () => { ent.props.loop = loopChk.checked; render(); });
  const pressModeSel = document.getElementById('ap-press-mode');
  if (pressModeSel) pressModeSel.addEventListener('change', () => {
    ent.props.pressMode = pressModeSel.value;
    ent.props.loop = pressModeSel.value === 'loop'; // kept in sync — see createEntity's PLATE case
    render();
  });
  const closeReleaseChk = document.getElementById('ap-close-release');
  if (closeReleaseChk) closeReleaseChk.addEventListener('change', () => { ent.props.closeOnRelease = closeReleaseChk.checked; render(); });
  const addBtn = document.getElementById('ap-add-action');
  if (addBtn) addBtn.addEventListener('click', () => {
    const list = onRelease ? ent.props.releaseActions : ent.props.actions;
    list.push(createAction(ACTION_TYPES.MOVE_ELEMENT, { params: defaultParamsFor(ACTION_TYPES.MOVE_ELEMENT) }));
    render();
  });
  const actions = (onRelease ? ent.props.releaseActions : ent.props.actions) || [];
  actions.forEach((action) => bindActionRow(ent, action, actionsPanelEl, onRelease));
  bindActionDragAndDrop(ent, onRelease);
}

// Manual pointer-driven drag-to-reorder (mousedown/mousemove/mouseup rather
// than native HTML5 draggable/dragstart/dragover/drop) — closer to how
// Scratch's own block canvas actually feels (native browser DnD tends to
// look janky: a semi-transparent ghost, no touch support, inconsistent
// cross-browser behavior), and it's driven entirely by this module's own
// state so it's simple to reason about and test. Grabbing anywhere on a
// card's header (`.block-head`, cursor: grab) and dragging it up/down over
// another card shows which half you're hovering (`.drop-before` /
// `.drop-after`) and reorders the active list (press or release — see
// `onRelease`) in place on release.
function bindActionDragAndDrop(ent, onRelease) {
  const list = document.getElementById('actions-panel-list');
  if (!list) return;
  list.querySelectorAll('.action-block-slot').forEach((slot) => {
    const handle = slot.querySelector('.block-drag-handle');
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragActionId = slot.dataset.dragId;
      slot.classList.add('dragging');
      const onMove = (moveEvt) => {
        const overSlot = document.elementFromPoint(moveEvt.clientX, moveEvt.clientY)?.closest('.action-block-slot');
        list.querySelectorAll('.action-block-slot').forEach((s) => s.classList.remove('drop-before', 'drop-after'));
        if (!overSlot || overSlot.dataset.dragId === dragActionId) return;
        const r = overSlot.getBoundingClientRect();
        const before = moveEvt.clientY < r.top + r.height / 2;
        overSlot.classList.add(before ? 'drop-before' : 'drop-after');
      };
      const onUp = (upEvt) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        slot.classList.remove('dragging');
        const overSlot = document.elementFromPoint(upEvt.clientX, upEvt.clientY)?.closest('.action-block-slot');
        list.querySelectorAll('.action-block-slot').forEach((s) => s.classList.remove('drop-before', 'drop-after'));
        const draggedId = dragActionId;
        dragActionId = null;
        if (!overSlot || overSlot.dataset.dragId === draggedId) return;
        const actions = onRelease ? ent.props.releaseActions : ent.props.actions;
        const fromIdx = actions.findIndex((a) => a.id === draggedId);
        let toIdx = actions.findIndex((a) => a.id === overSlot.dataset.dragId);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = actions.splice(fromIdx, 1);
        if (fromIdx < toIdx) toIdx--; // account for the shift after removal
        const r = overSlot.getBoundingClientRect();
        const before = upEvt.clientY < r.top + r.height / 2;
        actions.splice(before ? toIdx : toIdx + 1, 0, moved);
        render();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---------------------------------------------------------------- hierarchy panel
// Lists every placed entity (plus the player spawn) front-to-back — the same
// stacking order the canvas itself draws in (see render(), above) — so an
// author can find and click something they can't easily pick out on a
// crowded or overlapping grid, instead of relying purely on canvas clicks.
// Purely a selection aid: it never reorders or edits anything itself, it
// just drives the same `selectedId` the canvas click handler does.
function renderHierarchy() {
  if (!hierarchyEl) return;
  const rows = [
    ...level.entities.map((ent) => ({ kind: 'entity', ent, sortLayer: ent.layer || 0 })),
    { kind: 'playerstart', sortLayer: 0.5 }, // matches render()'s own <=0 / player / >0 draw split
  ];
  if (level.playerStart2) rows.push({ kind: 'playerstart2', sortLayer: 0.5 });
  rows.sort((a, b) => b.sortLayer - a.sortLayer); // front (highest layer) first

  const html = [`<div class="section-title">🗂️ Hiérarchie <span class="pill">${level.entities.length}</span></div>`];
  if (!level.entities.length) {
    html.push('<p class="muted empty">Aucun élément placé pour l\'instant.</p>');
  }
  for (const row of rows) {
    if (row.kind === 'playerstart') {
      const active = selectedId === 'playerstart' ? ' active' : '';
      const ps = level.playerStart;
      html.push(`<button type="button" class="hierarchy-row${active}" data-hid="playerstart">
        <span class="hswatch" style="background:rgba(247,127,0,0.85);">🏃</span>
        <span class="hlabel">Départ joueur${level.playerStart2 ? ' 1' : ''}</span>
        <span class="hlayer">(${ps.x},${ps.y})</span>
      </button>`);
      continue;
    }
    if (row.kind === 'playerstart2') {
      const active = selectedId === 'playerstart2' ? ' active' : '';
      const ps2 = level.playerStart2;
      html.push(`<button type="button" class="hierarchy-row${active}" data-hid="playerstart2">
        <span class="hswatch" style="background:rgba(46,196,255,0.85);">🧍</span>
        <span class="hlabel">Départ joueur 2</span>
        <span class="hlayer">(${ps2.x},${ps2.y})</span>
      </button>`);
      continue;
    }
    const ent = row.ent;
    const pal = PALETTE.find((p) => p.type === ent.type);
    const active = selectedId === ent.id ? ' active' : '';
    const layerVal = clampLayer(ent.layer ?? 0);
    // Still listed and still clickable even while its layer is hidden — the
    // point of the hierarchy is finding things you can't spot on the grid,
    // and that's doubly true once they're invisible there. Just dimmed as a
    // hint that it won't show up on the canvas right now.
    const hiddenHint = hiddenLayers.has(layerVal) ? ' hrow-hidden' : '';
    html.push(`<button type="button" class="hierarchy-row${active}${hiddenHint}" data-hid="${ent.id}">
      <span class="hswatch" style="background:${(pal && pal.color) || '#555'};">${(pal && pal.icon) || ''}</span>
      <span class="hlabel">${paletteLabel(ent.type)}</span>
      <span class="hlayer">${hiddenLayers.has(layerVal) ? '🚫 ' : ''}${layerVal !== 0 ? `c.${layerVal} · ` : ''}(${ent.x},${ent.y})</span>
    </button>`);
  }
  hierarchyEl.innerHTML = html.join('');
  hierarchyEl.querySelectorAll('[data-hid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedId = btn.dataset.hid;
      render(); renderProps();
    });
  });
}

// ------------------------------------------------------------ layers panel
// Sits under the tool palette, on the editor's left side. One row per
// distinct `layer` value actually used by placed entities (front-most
// first, same order as the hierarchy panel), each with an eye toggle to
// hide that layer from the canvas while editing a crowded level — purely a
// view filter for this editing session: it's never saved with the level,
// never touches the level data, and the hierarchy panel keeps listing
// everything regardless (see renderHierarchy's hiddenHint).
function renderLayersPanel() {
  if (!layersPanelEl) return;
  const counts = new Map();
  for (const ent of level.entities) {
    const l = clampLayer(ent.layer ?? 0);
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  // Drop any hidden-layer entry that no longer has entities on it (deleted,
  // moved to another layer, etc.) so the panel never shows a stale toggle.
  for (const l of [...hiddenLayers]) { if (!counts.has(l)) hiddenLayers.delete(l); }
  const layers = [...counts.keys()].sort((a, b) => b - a);
  const rows = layers.map((l) => {
    const hidden = hiddenLayers.has(l);
    const label = l === 0 ? 'Couche 0 (défaut)' : `Couche ${l > 0 ? '+' : ''}${l}`;
    return `<button type="button" class="layer-row${hidden ? ' layer-hidden' : ''}" data-layer="${l}" title="${hidden ? 'Afficher' : 'Masquer'} cette couche dans l'éditeur">
      <span class="layer-eye">${hidden ? '🚫' : '👁️'}</span>
      <span class="llabel">${label}</span>
      <span class="lcount">${counts.get(l)}</span>
    </button>`;
  }).join('');
  layersPanelEl.innerHTML = `
    <h3>👁️ Couches</h3>
    ${layers.length ? `<div id="layers-list">${rows}</div>` : '<p class="muted empty" style="font-size:12px;margin:4px 0;">Aucun élément placé.</p>'}
    ${hiddenLayers.size ? '<button type="button" class="btn small" id="layers-show-all" style="width:100%;margin-top:8px;">👁️ Tout afficher</button>' : ''}
  `;
  // Listener lives on the never-replaced panel element itself (bound once,
  // see bindLayersPanel) rather than on these buttons: editing a numeric
  // props field (e.g. "Couche") and then clicking a row here in one motion
  // blurs that field first, which re-renders this panel synchronously and
  // would swap the very button being clicked out from under a per-button
  // listener, silently eating that first click.
}

// Draws a dashed "string" from the currently-selected trigger/button/plate to
// every entity its actions target — only while it's selected, so the grid
// doesn't get cluttered with every link in the level at once.
function drawTriggerLinks() {
  if (!selectedId || selectedId === 'playerstart' || selectedId === 'playerstart2') return;
  const trig = findEntity(level, selectedId);
  if (!trig || !hasActionListType(trig.type) || isHiddenEntity(trig)) return;
  drawActionLinksFor(trig, trig.props && trig.props.actions, 'rgba(255,255,255,0.85)');
  // A PLATE's separate release list targets entities the same way — drawn
  // in a different color so both sets of links stay distinguishable when
  // shown at once.
  if (trig.type === ENTITY_TYPES.PLATE) drawActionLinksFor(trig, trig.props && trig.props.releaseActions, 'rgba(120,200,255,0.85)');
}

function drawActionLinksFor(fromEnt, actions, color) {
  actions = actions || [];
  if (!actions.length) return;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const fromX = fromEnt.x * CELL + (fromEnt.w * CELL) / 2;
  const fromY = fromEnt.y * CELL + (fromEnt.h * CELL) / 2;
  const seen = new Set();
  for (const action of actions) {
    if (!action.targetId || seen.has(action.targetId)) continue;
    seen.add(action.targetId);
    if (action.targetId === 'player') {
      const ps = level.playerStart;
      drawLink(fromX, fromY, ps.x * CELL + CELL / 2, ps.y * CELL + CELL / 2);
      continue;
    }
    if (action.targetId === 'player2') {
      if (!level.playerStart2) continue;
      const ps2 = level.playerStart2;
      drawLink(fromX, fromY, ps2.x * CELL + CELL / 2, ps2.y * CELL + CELL / 2);
      continue;
    }
    const target = findEntity(level, action.targetId);
    if (!target || isHiddenEntity(target)) continue;
    const tx = target.x * CELL + (target.w * CELL) / 2;
    const ty = target.y * CELL + (target.h * CELL) / 2;
    drawLink(fromX, fromY, tx, ty);
  }
  ctx.restore();
}

// Labels every cell with its (x, y) grid coordinate — shown only while
// editing a "Téléporter un élément" action's x/y fields, so you can read off
// the exact coordinates to type in instead of guessing/counting cells.
function drawCoordOverlay() {
  ctx.save();
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let cy = 0; cy < level.rows; cy++) {
    for (let cx = 0; cx < level.cols; cx++) {
      ctx.fillText(`${cx},${cy}`, cx * CELL + CELL / 2, cy * CELL + CELL / 2);
    }
  }
  ctx.restore();
}

function hasActionListType(type) {
  return type === ENTITY_TYPES.TRIGGER || type === ENTITY_TYPES.BUTTON || type === ENTITY_TYPES.PLATE;
}

function drawLink(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x2, y2, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawEntity(ent) {
  const x = ent.x * CELL, y = ent.y * CELL, w = ent.w * CELL, h = ent.h * CELL;
  ctx.save();
  // passable/invisible dimming is an edit-only hint — real play never dims
  // or recolors for these toggles (see engine.js's _renderEntity comment);
  // an invisible entity is filtered out of drawEntity entirely in real view
  // (see render()'s visibleInView), so this dimming would never even apply
  // to it there, but skipping it for passable too keeps the two consistent.
  if ((ent.passable || ent.invisible) && !editRealView) ctx.globalAlpha = 0.55;
  switch (ent.type) {
    case ENTITY_TYPES.BLOCK: ctx.fillStyle = '#111319'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#3a3f52'; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); break;
    case ENTITY_TYPES.CRATE:
      ctx.fillStyle = '#8a5a34'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#5c3a1e'; ctx.lineWidth = 2; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + w - 4, y + h - 4);
      ctx.moveTo(x + w - 4, y + 4); ctx.lineTo(x + 4, y + h - 4);
      ctx.stroke();
      break;
    case ENTITY_TYPES.SPIKE: {
      // "harmless" never recolors in real play (see engine.js's comment by
      // _renderEntity) — a harmless spike still LOOKS dangerous there, on
      // purpose. The gray-out is purely an edit-mode hint, suppressed here
      // too in real view.
      ctx.fillStyle = (ent.harmless && !editRealView) ? '#5b6b7a' : '#e63946';
      const facing = ent.props.facing || 'up';
      if (facing === 'up' || facing === 'down') {
        for (let i = 0; i < ent.w; i++) {
          ctx.beginPath();
          if (facing === 'up') { ctx.moveTo(x + i * CELL, y + h); ctx.lineTo(x + i * CELL + CELL / 2, y); ctx.lineTo(x + i * CELL + CELL, y + h); }
          else { ctx.moveTo(x + i * CELL, y); ctx.lineTo(x + i * CELL + CELL / 2, y + h); ctx.lineTo(x + i * CELL + CELL, y); }
          ctx.closePath(); ctx.fill();
        }
      } else {
        for (let i = 0; i < ent.h; i++) {
          ctx.beginPath();
          if (facing === 'left') { ctx.moveTo(x + w, y + i * CELL); ctx.lineTo(x, y + i * CELL + CELL / 2); ctx.lineTo(x + w, y + i * CELL + CELL); }
          else { ctx.moveTo(x, y + i * CELL); ctx.lineTo(x + w, y + i * CELL + CELL / 2); ctx.lineTo(x, y + i * CELL + CELL); }
          ctx.closePath(); ctx.fill();
        }
      }
      break;
    }
    case ENTITY_TYPES.SPRING:
      ctx.fillStyle = '#ffd166'; ctx.fillRect(x + 4, y + h * 0.4, w - 8, h * 0.6);
      ctx.fillStyle = '#8a6d1a'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText({ up: '↑', down: '↓' }[ent.props.direction || 'up'], x + w / 2, y + h * 0.35);
      break;
    case ENTITY_TYPES.FAN:
      ctx.fillStyle = '#0d3b4a'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#48cae4'; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.fillStyle = '#90e0ef'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText({ up: '↑', down: '↓', left: '←', right: '→' }[ent.props.direction || 'right'], x + w / 2, y + h / 2 + 5);
      break;
    case ENTITY_TYPES.SPINNER:
      ctx.fillStyle = (ent.harmless && !editRealView) ? '#5b6b7a' : '#c9184a'; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, CELL * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    case ENTITY_TYPES.TELEPORTER: {
      const freq = ent.props.frequency || 1;
      const colors = ['#9d4edd', '#f72585', '#4cc9f0', '#f9c74f', '#43aa8b', '#f3722c', '#577590', '#90be6d'];
      const color = colors[(freq - 1) % colors.length];
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(freq), x + w / 2, y + h / 2 + 4);
      if (ent.props.oneUse) { ctx.font = '8px sans-serif'; ctx.fillStyle = color; ctx.fillText('1×', x + w / 2, y + h - 3); }
      break;
    }
    case ENTITY_TYPES.CHECKPOINT: {
      const poleX = x + w * 0.34, poleW = Math.max(2, w * 0.07), poleTopY = y + h * 0.04;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(poleX + poleW / 2, y + h - 1, w * 0.22, Math.max(1.5, h * 0.035), 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5fa9bc'; ctx.fillRect(poleX, poleTopY, poleW, y + h - poleTopY);
      ctx.fillStyle = '#eafdff'; ctx.beginPath(); ctx.arc(poleX + poleW / 2, poleTopY, Math.max(2, w * 0.05), 0, Math.PI * 2); ctx.fill();
      const flagTop = poleTopY + h * 0.06, flagH = h * 0.36, flagW = w * 0.52;
      const grad = ctx.createLinearGradient(poleX, flagTop, poleX + flagW, flagTop);
      grad.addColorStop(0, '#5fe0f2'); grad.addColorStop(1, '#0f8fae');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(poleX + poleW, flagTop);
      ctx.quadraticCurveTo(poleX + flagW * 0.6, flagTop + flagH * 0.16, poleX + flagW, flagTop + flagH * 0.4);
      ctx.quadraticCurveTo(poleX + flagW * 0.6, flagTop + flagH * 0.64, poleX + poleW, flagTop + flagH);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1; ctx.stroke();
      break;
    }
    case ENTITY_TYPES.GOAL: {
      // A blue doorway, shown open (matches its idle in-game look — it only
      // slides shut once the player actually walks in).
      const insetX = Math.max(2, w * 0.08), insetY = Math.max(2, h * 0.04);
      ctx.fillStyle = '#1b2a4a'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#05060a'; ctx.fillRect(x + insetX, y + insetY, w - insetX * 2, h - insetY);
      ctx.fillStyle = '#2d6cdf'; ctx.fillRect(x + insetX, y + insetY, (w - insetX * 2) * 0.16, h - insetY);
      break;
    }
    case ENTITY_TYPES.TRIGGER:
      ctx.fillStyle = 'rgba(244,211,94,0.25)'; ctx.strokeStyle = '#f4d35e';
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#f4d35e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(ent.props.loop ? 'T ∞' : 'T', x + w / 2, y + h / 2 + 3);
      break;
    case ENTITY_TYPES.BUTTON:
      withFacingRotation(ent, x, y, w, h, () => {
        ctx.fillStyle = '#2b2d3d'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#5b5f7a'; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        ctx.fillStyle = '#06d6a0'; ctx.fillRect(x + w * 0.18, y + h * 0.56, w * 0.64, h * 0.32);
        if (ent.props.loop) { ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('∞', x + w / 2, y + h * 0.32); }
      });
      break;
    case ENTITY_TYPES.PLATE:
      withFacingRotation(ent, x, y, w, h, () => {
        ctx.fillStyle = '#5c3d13'; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#c98a2b'; ctx.fillRect(x + 3, y + h * 0.55, w - 6, h * 0.35);
        ctx.strokeStyle = '#7a531a'; ctx.strokeRect(x + 3, y + h * 0.55, w - 6, h * 0.35);
        if (ent.props.loop) { ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('∞', x + w / 2, y + h * 0.32); }
      });
      break;
  }
  ctx.restore();
}

// Purely cosmetic facing rotation for the editor-canvas preview, mirroring
// engine.js's _facingAngle exactly (same angle map, same 'up' = identity
// default) so the editor and the actual game always look the same.
function facingAngle(facing) {
  return { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[facing] || 0;
}
function withFacingRotation(ent, x, y, w, h, draw) {
  const angle = facingAngle(ent.props && ent.props.facing);
  if (!angle) { draw(); return; }
  const cx = x + w / 2, cy = y + h / 2;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(angle); ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

// ---------------------------------------------------------------- canvas input
function bindCanvas() {
  canvas.addEventListener('click', (e) => {
    if (playtesting) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX, py = (e.clientY - rect.top) * scaleY;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
    if (cx < 0 || cy < 0 || cx >= level.cols || cy >= level.rows) return;
    handleCellClick(cx, cy);
  });
}

function entityAt(cx, cy) {
  // topmost (last placed) entity whose box contains the cell — entities on a
  // hidden layer are skipped, exactly as if they weren't there: you can't
  // click, drag, erase, or target-pick something you can't currently see.
  for (let i = level.entities.length - 1; i >= 0; i--) {
    const e = level.entities[i];
    if (isHiddenEntity(e)) continue;
    if (cx >= e.x && cx < e.x + e.w && cy >= e.y && cy < e.y + e.h) return e;
  }
  return null;
}

function handleCellClick(cx, cy) {
  // "🎬 Voir le jeu": a pure visual preview, not a selection tool like
  // previewMode below — clicking the canvas does nothing at all while it's
  // on (see toggleEditRealView to leave it).
  if (editRealView) return;
  if (previewMode) {
    // View-only: clicking only ever selects (to inspect props), never
    // moves/places/erases anything.
    const clicked = entityAt(cx, cy);
    const ps2 = level.playerStart2;
    selectedId = clicked ? clicked.id
      : (cx === level.playerStart.x && cy === level.playerStart.y ? 'playerstart'
      : (ps2 && cx === ps2.x && cy === ps2.y ? 'playerstart2' : null));
    render(); renderProps();
    return;
  }
  if (pickingTargetFor) {
    const ent = entityAt(cx, cy);
    // A crate is a physics object, not a scriptable "element" — it can never
    // be an action's target, so clicking one while picking just does nothing
    // (stays in picking mode instead of clearing the target to "aucune").
    if (ent && ent.type === ENTITY_TYPES.CRATE) {
      setStatus("Un cube poussable n'est pas une cible valide pour une action.", true);
      return;
    }
    pickingTargetFor.onPick(ent ? ent.id : null);
    pickingTargetFor = null;
    pickBanner.classList.add('hidden');
    render(); renderProps();
    return;
  }
  if (tool === 'playerstart') {
    // keep the spawn's own state (gravity/visibility) — only move it
    level.playerStart.x = cx; level.playerStart.y = cy;
    selectedId = 'playerstart';
    tool = 'select';
    buildPalette();
    render(); renderProps();
    return;
  }
  if (tool === 'playerstart2') {
    // First click while there's no player 2 yet creates one ("activate" the
    // feature); once it exists, this tool just relocates it — same
    // create-or-move split the palette button's own label already implies
    // ("Départ joueur 2" vs "Départ joueur 2 (activer)").
    if (level.playerStart2) {
      level.playerStart2.x = cx; level.playerStart2.y = cy;
    } else {
      level.playerStart2 = { x: cx, y: cy, gravityDir: 'down', invisible: false };
    }
    selectedId = 'playerstart2';
    tool = 'select';
    buildPalette();
    render(); renderProps();
    return;
  }
  if (tool === 'erase') {
    const ent = entityAt(cx, cy);
    if (ent) { removeEntity(level, ent.id); if (selectedId === ent.id) selectedId = null; }
    render(); renderProps();
    return;
  }
  if (tool === 'select') {
    if (selectedId) {
      const clicked = entityAt(cx, cy);
      if (clicked && clicked.id !== selectedId) {
        selectedId = clicked.id; // switch selection instead
      } else if (selectedId === 'playerstart') {
        level.playerStart.x = cx; level.playerStart.y = cy;
      } else if (selectedId === 'playerstart2') {
        if (level.playerStart2) { level.playerStart2.x = cx; level.playerStart2.y = cy; }
      } else {
        const ent = findEntity(level, selectedId);
        if (ent) { ent.x = cx; ent.y = cy; }
      }
    } else {
      const clicked = entityAt(cx, cy);
      const ps2 = level.playerStart2;
      if (clicked) selectedId = clicked.id;
      else if (cx === level.playerStart.x && cy === level.playerStart.y) selectedId = 'playerstart';
      else if (ps2 && cx === ps2.x && cy === ps2.y) selectedId = 'playerstart2';
    }
    render(); renderProps();
    return;
  }
  // placing a new entity of type == tool
  if (tool === ENTITY_TYPES.BLOCK) {
    // Solid blocks are placed cell-by-cell and assemble seamlessly with
    // their neighbors — no resizing, and no stacking a second block on a
    // cell that already has one. The tool deliberately stays active so you
    // can keep clicking to lay down a run of blocks without reselecting it.
    const occupied = level.entities.some(e => e.type === ENTITY_TYPES.BLOCK && cx >= e.x && cx < e.x + e.w && cy >= e.y && cy < e.y + e.h);
    if (occupied) return;
    const block = createEntity(tool, cx, cy, {}, level);
    level.entities.push(block);
    selectedId = block.id;
    render(); renderProps();
    return;
  }
  const ent = createEntity(tool, cx, cy, {}, level);
  level.entities.push(ent);
  selectedId = ent.id;
  tool = 'select';
  buildPalette();
  render(); renderProps();
}

// ---------------------------------------------------------------- properties panel
// Wraps a block of fields in a titled card — this is what gives the props
// panel visual sections (État, Orientation, Ventilateur…) instead of one
// long flat run of labels. `bodyHtml` is skipped entirely if empty, so
// callers can build it unconditionally without an extra guard.
function fieldGroup(title, bodyHtml) {
  if (!bodyHtml) return '';
  return `<div class="field-group"><div class="section-title">${title}</div>${bodyHtml}</div>`;
}

function renderProps() {
  // Rebuilding the panel destroys whatever had focus, so drop the coordinate
  // overlay too — it comes back the moment a teleport x/y field is focused
  // again (see bindActionRow).
  if (showCoordOverlay) { showCoordOverlay = false; render(); }
  if (!selectedId) {
    propsEl.innerHTML = '<h3 style="margin-top:0;">Propriétés</h3><p class="muted">Sélectionne un élément sur la grille (outil « Sélection ») pour l\'éditer.</p>';
    return;
  }
  if (selectedId === 'playerstart') { renderPlayerStartProps(1); return; }
  if (selectedId === 'playerstart2') {
    if (!level.playerStart2) { selectedId = null; return renderProps(); }
    renderPlayerStartProps(2);
    return;
  }
  const ent = findEntity(level, selectedId);
  if (!ent) { selectedId = null; return renderProps(); }

  // TRIGGER/BUTTON/PLATE carry enough settings (an action list, plus a whole
  // card of activation timing/repeat options) that stacking it all in one
  // flat panel got overwhelming — these three alone get a Général/Actions/
  // Activation tab bar (see renderPropsTabBar) so only one concern shows at
  // a time. Every other type has little enough to configure that a single
  // flat panel (the pre-existing layout) stays the simplest option.
  const isTabbedType = ent.type === ENTITY_TYPES.TRIGGER || ent.type === ENTITY_TYPES.BUTTON || ent.type === ENTITY_TYPES.PLATE;
  if (isTabbedType) {
    // Switching to a different entity always lands back on "Actions" — only
    // staying on the SAME entity (e.g. after editing a field) preserves
    // whichever tab was open, exactly like the Actions panel's own press/
    // release sub-tabs (actionsPanelTarget) do.
    if (ent.id !== lastPropsTabEntityId) { propsTab = 'actions'; lastPropsTabEntityId = ent.id; }
  } else {
    lastPropsTabEntityId = null;
  }

  const html = [];
  html.push(`<div class="props-header"><h3>Propriétés</h3><div class="pill type-badge">${paletteLabel(ent.type)}</div></div>`);
  if (isTabbedType) html.push(renderPropsTabBar());

  if (!isTabbedType || propsTab === 'general') {
    html.push('<div class="props-panel">');
    html.push(`<label>Position (colonne / ligne)</label>
      <div class="row">
        <input type="number" id="p-x" value="${ent.x}" min="0" max="${level.cols - 1}" />
        <input type="number" id="p-y" value="${ent.y}" min="0" max="${level.rows - 1}" />
      </div>`);

    // A checkpoint's flag is always drawn at the same fixed size, so the size
    // fields don't apply to it — every other type (BLOCK included: solid
    // blocks are placed one cell at a time, but resizable afterward here,
    // just like a crate) gets them.
    if (ent.type !== ENTITY_TYPES.CHECKPOINT) {
      html.push(`<label>Taille (largeur / hauteur en cases)</label>
        <div class="row">
          <input type="number" id="p-w" value="${ent.w}" min="1" max="${level.cols}" />
          <input type="number" id="p-h" value="${ent.h}" min="1" max="${level.rows}" />
        </div>`);
    }

    const layerCurrent = clampLayer(ent.layer ?? 0);
    html.push(fieldGroup('Affichage', `
      <label>Couche (superposition visuelle)</label>
      <input type="number" id="p-layer" value="${layerCurrent}" min="${LAYER_MIN}" max="${LAYER_MAX}" step="1" />
      <p class="hint">0 = normal (par défaut). Négatif = plus en arrière-plan, positif = plus au premier plan — devant ou derrière le joueur selon le signe. Change seulement l'ordre d'affichage : quelle que soit la couche, cet élément continue d'interagir normalement avec le joueur (collisions, dangers, actions...). Utilise le panneau « Hiérarchie » pour voir et sélectionner les éléments par couche.</p>`));

    const toggles = togglesForType(ent.type);
    if (toggles.length) {
      const rows = toggles.map(t => `<label class="toggle-row"><input type="checkbox" data-toggle="${t}" ${ent[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`).join('');
      html.push(fieldGroup('État', `<div class="toggle-list">${rows}</div>`));
    }

    if (ent.type === ENTITY_TYPES.SPIKE || ent.type === ENTITY_TYPES.BUTTON || ent.type === ENTITY_TYPES.PLATE) {
      html.push(fieldGroup('Orientation', `
        ${selectHtml('p-facing', FACING_LABELS, ent.props.facing || 'up')}
        ${ent.type !== ENTITY_TYPES.SPIKE ? '<p class="hint">Purement visuel (comme pour la pointe) : ça ne change pas où il faut marcher/appuyer pour l\'activer.</p>' : ''}`));
    }
    if (ent.type === ENTITY_TYPES.SPRING) {
      html.push(fieldGroup('Ressort', `
        <label>Direction (haut / bas uniquement)</label>
        ${selectHtml('p-dir', { up: GRAVITY_LABELS.up, down: GRAVITY_LABELS.down }, ent.props.direction || 'up')}
        <label>Puissance (x saut normal)</label>
        <input type="number" id="p-power" value="${ent.props.power ?? 1.6}" step="0.1" min="0.2" max="5" />`));
    }
    if (ent.type === ENTITY_TYPES.FAN) {
      html.push(fieldGroup('Ventilateur', `
        <label>Direction du vent</label>
        ${selectHtml('p-fandir', GRAVITY_LABELS, ent.props.direction || 'right')}
        <label>Force du vent</label>
        <input type="number" id="p-force" value="${ent.props.force ?? 1}" step="0.1" min="0.1" max="4" />
        <label>Portée (nombre de cases touchées par l'air)</label>
        <input type="number" id="p-range" value="${ent.props.range ?? 5}" step="1" min="0" max="40" />
        <label class="toggle-row" style="margin-top:10px;"><input type="checkbox" id="p-falloff" ${ent.props.falloff ? 'checked' : ''} />Diminution en fonction de la distance</label>
        <p class="hint">Ex. avec une portée de 5 cases, un joueur à 4 cases est encore propulsé ; au-delà de 5, plus rien.</p>`));
    }
    if (ent.type === ENTITY_TYPES.SPINNER) {
      html.push(fieldGroup('Rotation', `
        <label>Vitesse de rotation</label>
        <input type="number" id="p-speed" value="${ent.props.speed ?? 2}" step="0.1" min="0.1" max="10" />
        <label>Sens de rotation</label>
        ${selectHtml('p-spin-direction', { cw: 'Horaire', ccw: 'Antihoraire' }, ent.props.direction || 'cw')}`));
    }
    if (ent.type === ENTITY_TYPES.CRATE) {
      html.push(fieldGroup('Cube poussable', `
        <label>Gravité (x normal, négatif = flotte vers le haut)</label>
        <input type="number" id="p-crate-gravity" value="${ent.props.gravity ?? 1}" step="0.1" min="-5" max="5" />
        <p class="hint">Se combine avec la gravité du monde (« Condition du monde ») : si les deux sont négatives (ou les deux positives), le cube tombe normalement ; si un seul des deux l'est, il flotte vers le haut. 0 = insensible à la gravité.</p>
        <label>Difficulté à pousser</label>
        <input type="number" id="p-crate-pushdiff" value="${ent.props.pushDifficulty ?? 1}" step="0.1" min="0.1" max="10" />
        <p class="hint">1 = normal (suit le joueur sans résistance). Plus haut = plus lourd, il traîne derrière le joueur qui le pousse.</p>`));
    }
    if (ent.type === ENTITY_TYPES.TELEPORTER) {
      const freqLabels = {};
      for (const f of TELEPORTER_FREQUENCIES) freqLabels[f] = `Fréquence ${f} (${teleporterGroupCount(f, ent.id)}/${TELEPORTER_MAX_PER_FREQUENCY})`;
      html.push(fieldGroup('Téléportation', `
        <label>Fréquence (relie les téléporteurs, max 3 par fréquence)</label>
        ${selectHtml('p-freq', freqLabels, ent.props.frequency || 1)}
        <label class="toggle-row" style="margin-top:10px;"><input type="checkbox" id="p-oneuse" ${ent.props.oneUse ? 'checked' : ''} />Sens unique (utilisable une seule fois)</label>
        <p class="hint">S'applique à toute la fréquence : les téléporteurs liés deviennent tous « sens unique » ensemble, et l'aller-retour est impossible une fois emprunté.</p>`));
    }
    html.push('</div>');
  }

  if (isTabbedType) {
    const parts = ent.type === ENTITY_TYPES.TRIGGER ? renderTriggerEditor(ent)
      : ent.type === ENTITY_TYPES.BUTTON ? renderButtonEditor(ent)
      : renderPlateEditor(ent);
    if (propsTab === 'actions') html.push(parts.actions);
    else if (propsTab === 'activation') html.push(parts.activation);
  }

  html.push(`<div style="margin-top:14px;"><button class="btn danger small" id="delete-ent" style="width:100%;">Supprimer cet élément</button></div>`);

  propsEl.innerHTML = html.join('');
  bindPropsInputs(ent);
  bindPropsTabBar();
  if (previewMode) {
    // Bindings above still get attached (harmless — they'd just mutate an
    // in-memory level nothing ever saves), but disable every control so
    // there's nothing to accidentally click/type into in the first place.
    propsEl.querySelectorAll('input, select, button, textarea').forEach((el) => { el.disabled = true; });
  }
}

function renderPlayerStartProps(player = 1) {
  const isP2 = player === 2;
  const ps = isP2 ? level.playerStart2 : level.playerStart;
  const html = [];
  html.push(`<div class="props-header"><h3>Propriétés</h3><div class="pill type-badge">🧍 Départ joueur${isP2 ? ' 2' : (level.playerStart2 ? ' 1' : '')}</div></div>`);
  html.push('<div class="props-panel">');
  html.push(`<label>Position (colonne / ligne)</label>
    <div class="row">
      <input type="number" id="p-x" value="${ps.x}" min="0" max="${level.cols - 1}" />
      <input type="number" id="p-y" value="${ps.y}" min="0" max="${level.rows - 1}" />
    </div>`);
  html.push(fieldGroup('État initial', `
    <label>Centre de gravité au départ</label>
    ${selectHtml('p-ps-gravity', GRAVITY_LABELS, ps.gravityDir || 'down')}
    <label class="toggle-row" style="margin-top:10px;"><input type="checkbox" id="p-ps-invisible" ${ps.invisible ? 'checked' : ''} />Joueur invisible au départ</label>
    <p class="hint">Même invisible, le joueur reste bien présent : le son et les particules (saut, atterrissage, mort…) continuent de fonctionner normalement.</p>`));
  if (isP2) {
    html.push(fieldGroup('2 joueurs', `
      <p class="hint">Retire le joueur 2 : le niveau redevient un niveau à 1 joueur (les actions qui le ciblaient viseront à nouveau le joueur 1).</p>
      <button type="button" class="btn small danger" id="p-ps2-delete">🗑️ Supprimer le joueur 2</button>`));
  }
  html.push('</div>');
  propsEl.innerHTML = html.join('');

  const num = (id, cb) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => cb(parseFloat(el.value))); };
  num('p-x', (v) => { ps.x = clampInt(v, 0, level.cols - 1); render(); });
  num('p-y', (v) => { ps.y = clampInt(v, 0, level.rows - 1); render(); });
  const gravSel = document.getElementById('p-ps-gravity');
  if (gravSel) gravSel.addEventListener('change', () => { ps.gravityDir = gravSel.value; });
  const invChk = document.getElementById('p-ps-invisible');
  if (invChk) invChk.addEventListener('change', () => { ps.invisible = invChk.checked; render(); });
  const delBtn = document.getElementById('p-ps2-delete');
  if (delBtn) delBtn.addEventListener('click', () => {
    // Any action that was targeting 'player2' loses its target rather than
    // silently repointing at player 1 — matches how deleting a normal
    // entity leaves dangling targets untouched (author has to notice and
    // re-pick), instead of surprising them with a target swap.
    level.playerStart2 = null;
    selectedId = null;
    tool = 'select';
    buildPalette();
    render(); renderProps();
  });
  if (previewMode) propsEl.querySelectorAll('input, select, button, textarea').forEach((el) => { el.disabled = true; });
}

function teleporterGroupCount(freq, excludeId) {
  return level.entities.filter(e => e.type === ENTITY_TYPES.TELEPORTER && e.id !== excludeId && (e.props.frequency || 1) === freq).length;
}

function paletteLabel(type) {
  const found = PALETTE.find(p => p.type === type);
  return found ? found.label : type;
}
function selectHtml(id, labelsMap, current) {
  return `<select id="${id}">${Object.entries(labelsMap).map(([v, l]) => `<option value="${v}" ${String(v) === String(current) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function bindPropsInputs(ent) {
  const num = (id, cb) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => cb(parseFloat(el.value))); };
  num('p-x', (v) => { ent.x = clampInt(v, 0, level.cols - 1); render(); });
  num('p-y', (v) => { ent.y = clampInt(v, 0, level.rows - 1); render(); });
  num('p-w', (v) => { ent.w = Math.max(1, Math.round(v)); render(); });
  num('p-h', (v) => { ent.h = Math.max(1, Math.round(v)); render(); });

  propsEl.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('change', () => { ent[el.dataset.toggle] = el.checked; render(); });
  });

  num('p-layer', (v) => { ent.layer = clampLayer(v); render(); });

  const facingSel = document.getElementById('p-facing');
  if (facingSel) facingSel.addEventListener('change', () => { ent.props.facing = facingSel.value; render(); });
  const dirSel = document.getElementById('p-dir');
  if (dirSel) dirSel.addEventListener('change', () => { ent.props.direction = dirSel.value; render(); });
  const fanDirSel = document.getElementById('p-fandir');
  if (fanDirSel) fanDirSel.addEventListener('change', () => { ent.props.direction = fanDirSel.value; render(); });
  num('p-power', (v) => { ent.props.power = v; });
  num('p-force', (v) => { ent.props.force = v; });
  num('p-range', (v) => { ent.props.range = Math.max(0, Math.round(v)); });
  const falloffChk = document.getElementById('p-falloff');
  if (falloffChk) falloffChk.addEventListener('change', () => { ent.props.falloff = falloffChk.checked; });
  num('p-speed', (v) => { ent.props.speed = v; });
  const spinDirSel = document.getElementById('p-spin-direction');
  if (spinDirSel) spinDirSel.addEventListener('change', () => { ent.props.direction = spinDirSel.value; });
  num('p-crate-gravity', (v) => { ent.props.gravity = Number.isFinite(v) ? Math.max(-5, Math.min(5, v)) : 1; });
  num('p-crate-pushdiff', (v) => { ent.props.pushDifficulty = Number.isFinite(v) ? Math.max(0.1, Math.min(10, v)) : 1; });

  const freqSel = document.getElementById('p-freq');
  if (freqSel) freqSel.addEventListener('change', () => {
    const newFreq = parseInt(freqSel.value, 10);
    if (teleporterGroupCount(newFreq, ent.id) >= TELEPORTER_MAX_PER_FREQUENCY) {
      setStatus(`Impossible : la fréquence ${newFreq} a déjà ${TELEPORTER_MAX_PER_FREQUENCY} téléporteurs.`, true);
      freqSel.value = ent.props.frequency || 1;
      return;
    }
    // Adopt the destination group's existing "sens unique" setting (if it
    // already has members) so the whole frequency always agrees.
    const groupMate = level.entities.find(e => e.type === ENTITY_TYPES.TELEPORTER && e.id !== ent.id && (e.props.frequency || 1) === newFreq);
    ent.props.frequency = newFreq;
    if (groupMate) ent.props.oneUse = !!groupMate.props.oneUse;
    render(); renderProps();
  });
  const oneUseChk = document.getElementById('p-oneuse');
  if (oneUseChk) oneUseChk.addEventListener('change', () => {
    // "Sens unique" is a whole-frequency setting: flipping it here flips it
    // for every teleporter sharing this one's frequency.
    const freq = ent.props.frequency || 1;
    const val = oneUseChk.checked;
    for (const e of level.entities) {
      if (e.type === ENTITY_TYPES.TELEPORTER && (e.props.frequency || 1) === freq) e.props.oneUse = val;
    }
    render();
  });

  const delBtn = document.getElementById('delete-ent');
  if (delBtn) delBtn.addEventListener('click', () => { removeEntity(level, ent.id); selectedId = null; render(); renderProps(); });

  // trigger/button/plate-specific bindings — "Boucle infinie" now lives in
  // the Actions panel (see bindActionsPanel's #ap-loop), alongside the
  // actions it governs.
  const reversibleChk = document.getElementById('p-reversible');
  if (reversibleChk) reversibleChk.addEventListener('change', () => { ent.props.reversible = reversibleChk.checked; render(); renderProps(); });

  // "Activation avancée" — see renderAdvancedActivation and engine.js's
  // _activate/_canActivate/_graceOverlap/_fireTrigger.
  const releaseModeSel = document.getElementById('p-releasemode');
  if (releaseModeSel) releaseModeSel.addEventListener('change', () => { ent.props.releaseMode = releaseModeSel.value; });
  const activatorSel = document.getElementById('p-activator');
  if (activatorSel) activatorSel.addEventListener('change', () => { ent.props.activator = activatorSel.value; });
  num('p-activationdelay', (v) => { ent.props.activationDelay = Math.max(0, v || 0); });
  num('p-releasegrace', (v) => { ent.props.releaseGrace = Math.max(0, v || 0); });
  const sequentialChk = document.getElementById('p-sequential');
  if (sequentialChk) sequentialChk.addEventListener('change', () => { ent.props.sequential = sequentialChk.checked; });
  num('p-maxrepeats', (v) => { ent.props.maxRepeats = Math.max(0, Math.round(v || 0)); });
  num('p-rearmcooldown', (v) => { ent.props.rearmCooldown = Math.max(0, v || 0); });

  // Actions themselves (add/reorder/edit) live in the "🧩 Actions" panel
  // below the canvas now, not here — see renderActionsPanel/bindActionsPanel.
  // This button just jumps you there for the currently-selected entity.
  const openActionsBtn = document.getElementById('open-actions-panel');
  if (openActionsBtn) openActionsBtn.addEventListener('click', () => { actionsPanelTarget = 'press'; switchBottomTab('actions'); });
  // PLATE only: same idea, but jumps straight to its separate "Relâchement"
  // sub-tab (see renderPlateReleaseEditor / renderActionsPanel).
  const openReleaseBtn = document.getElementById('open-release-panel');
  if (openReleaseBtn) openReleaseBtn.addEventListener('click', () => { actionsPanelTarget = 'release'; switchBottomTab('actions'); });
  const closeOnReleaseChk = document.getElementById('p-close-on-release');
  if (closeOnReleaseChk) closeOnReleaseChk.addEventListener('change', () => { ent.props.closeOnRelease = closeOnReleaseChk.checked; render(); renderProps(); });
}

function clampInt(v, min, max) { return Math.max(min, Math.min(max, Math.round(v))); }

// ------------------------------------------------------- trigger/button/plate UI

// The props panel's own tab bar for TRIGGER/BUTTON/PLATE (see renderProps's
// isTabbedType) — same small pill look as the Actions panel's press/release
// sub-tabs (.subtabs, shared on purpose). "Général" covers position/size/
// display/state/orientation, exactly what every other entity type shows in
// its one flat panel; "Actions" is the action list(s); "Activation" is the
// timing/repeat/who-can-activate settings that used to always sit in view
// under the label "Activation avancée" — now a dedicated tab instead of a
// permanent wall of fields under the actions.
function renderPropsTabBar() {
  const tabs = [
    ['general', '📋 Général'],
    ['actions', '🧩 Actions'],
    ['activation', '⚡ Activation'],
  ];
  return `<div class="subtabs">${tabs.map(([id, label]) =>
    `<button type="button" class="btn small${propsTab === id ? ' active' : ''}" data-props-tab="${id}">${label}</button>`
  ).join('')}</div>`;
}

function bindPropsTabBar() {
  propsEl.querySelectorAll('[data-props-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { propsTab = btn.dataset.propsTab; renderProps(); });
  });
}

function renderLoopCheckbox(ent) {
  return `<label class="toggle-row" style="margin-top:8px;"><input type="checkbox" id="p-loop" ${ent.props.loop ? 'checked' : ''} />Boucle infinie (une fois déclenché, répète les actions pour toujours)</label>`;
}

// Shared shape for TRIGGER/BUTTON/PLATE: a titled card explaining how it
// fires, an optional extra toggle (e.g. "reversible" for button/plate), and
// a pointer over to the "🧩 Actions" panel below the canvas — that's now the
// only place its action list (add/reorder/edit, "boucle infinie" included)
// actually lives, so there's a full-width Scratch-like space to assemble it
// in instead of the narrow props column. See renderActionsPanel.
function renderActionListEditor(title, hintHtml, actionsLabel, ent, extraHtml = '') {
  const count = (ent.props.actions || []).length;
  const body = `
    <p class="hint" style="margin-top:0;">${hintHtml}</p>
    ${extraHtml}
    <div class="row" style="align-items:center;margin-top:14px;">
      <label style="margin:0;flex:1;">${actionsLabel}</label>
      <span class="pill">${count} action${count === 1 ? '' : 's'}</span>
    </div>
    <button type="button" class="btn small primary" id="open-actions-panel" style="width:100%;margin-top:8px;">🧩 Assembler les actions</button>`;
  return fieldGroup(title, body);
}

// Emoji/accent color/title for each action type's "bloc" card (see
// renderActionBlock) — purely cosmetic, no bearing on behavior.
const ACTION_BLOCK_META = {
  [ACTION_TYPES.MOVE_ELEMENT]: { emoji: '🧭', color: '#3a86ff' },
  [ACTION_TYPES.TELEPORT]: { emoji: '🌀', color: '#8338ec' },
  [ACTION_TYPES.SET_STATE]: { emoji: '⚙️', color: '#ffb703' },
  [ACTION_TYPES.SET_WORLD_STATE]: { emoji: '🌍', color: '#06d6a0' },
  [ACTION_TYPES.SET_PLAYER_STATE]: { emoji: '🧍', color: '#ef476f' },
};

// The "Accéder aux blocs" rendering of one action: the exact same data
// (target, params, delay) as renderActionRow, but laid out as a natural-
// language sentence with small inline editable pieces instead of a stacked
// form — closer to "Déplacé [cible] de [] à droite", "Téléporté [cible] à la
// case [x,y]", etc. Reuses the identical data-f/data-pick-target/data-ws-*
// attributes as renderActionRow, so bindActionRow needs no changes at all to
// bind either view.
function renderActionBlock(action) {
  const p = action.params || {};
  const meta = ACTION_BLOCK_META[action.type] || { emoji: '🧩', color: null };
  const needsTarget = NEEDS_TARGET.has(action.type);
  const allowPlayer = ALLOWS_PLAYER_TARGET.has(action.type);
  // One single clickable chip picks the target — it used to be a plain
  // (non-clickable) label next to a separate "Choisir sur la grille" button,
  // which looked like two controls for the same job. Now there's just one:
  // click the chip itself, whether picking for the first time or changing
  // an already-set target.
  const targetLabel = targetLabelFor(action.targetId) || 'clique pour choisir sur la grille';
  const targetChip = needsTarget ? `
    <button type="button" class="btn small block-chip" data-pick-target="${action.id}">🎯 ${targetLabel}</button>
    ${playerTargetButtons(action, allowPlayer)}` : '';

  let body = '';
  switch (action.type) {
    case ACTION_TYPES.MOVE_ELEMENT:
      body = `
        <div class="block-sentence">
          <span>Déplacer</span> ${targetChip} <span>de</span>
          <input type="number" class="block-input" data-f="axisX" value="${p.axisX ?? 0}" title="+ = droite, − = gauche" />
          <span>case(s) — <strong>+</strong> droite / <strong>−</strong> gauche</span>
        </div>
        <div class="block-sentence">
          <span>et de</span>
          <input type="number" class="block-input" data-f="axisY" value="${p.axisY ?? 0}" title="+ = monte, − = descend" />
          <span>case(s) — <strong>+</strong> haut / <strong>−</strong> bas, en</span>
          <input type="number" class="block-input" step="0.1" data-f="duration" value="${p.duration ?? 0.5}" />
          <span>s</span>
        </div>`;
      break;
    case ACTION_TYPES.TELEPORT:
      body = `
        <div class="block-sentence">
          <span>Téléporter</span> ${targetChip} <span>à la case</span>
          <input type="number" class="block-input teleport-coord-input" data-f="x" value="${p.x ?? 0}" />
          <input type="number" class="block-input teleport-coord-input" data-f="y" value="${p.y ?? 0}" />
        </div>
        <p class="hint">Astuce : clique dans un des deux champs ci-dessus pour afficher les coordonnées (x,y) de chaque case sur la grille.</p>`;
      break;
    case ACTION_TYPES.SET_STATE:
      body = `
        <div class="block-sentence"><span>Changer l'état de</span> ${targetChip} <span>en :</span></div>
        <div class="toggle-list" style="margin-top:6px;">
          ${ENTITY_TOGGLES.map(t => `<label class="toggle-row"><input type="checkbox" data-f="${t}" ${p[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`).join('')}
        </div>
        ${optionalBlock('facing', 'Rotation (ex. pointes)',
          selectHtml('', FACING_LABELS, p.facing || 'up').replace('id=""', 'data-ws-value="facing"'),
          'facing' in p)}`;
      break;
    case ACTION_TYPES.SET_WORLD_STATE:
      body = `<div class="block-sentence"><span>Changer l'état du monde :</span></div>${renderWorldStateFields(p)}`;
      break;
    case ACTION_TYPES.SET_PLAYER_STATE:
      body = `<div class="block-sentence"><span>Changer l'état du joueur :</span></div>${renderPlayerStateFields(p)}`;
      break;
  }

  return `
    <div class="action-item action-block" data-action="${action.id}" style="${meta.color ? `--block-color:${meta.color};` : ''}">
      <div class="block-head">
        <span class="block-drag-handle" title="Glisser pour réordonner">⠿</span>
        <span class="block-emoji">${meta.emoji}</span>
        ${selectHtml('', ACTION_LABELS, action.type).replace('id=""', 'data-f="type"')}
        <span class="block-spacer"></span>
        <label class="block-delay">Délai <input type="number" class="block-input small" step="0.1" data-f="delay" value="${action.delay || 0}" /> s</label>
        <button type="button" class="btn small danger" data-remove-action="${action.id}">✕</button>
      </div>
      <div class="block-body">${body}</div>
    </div>`;
}

// Each of these three now returns { actions, activation } instead of one
// concatenated string — renderProps picks whichever half to show based on
// its own props-panel tab (see renderPropsTabBar/isTabbedType), instead of
// always stacking every card at once.
function renderTriggerEditor(ent) {
  return {
    actions: renderActionListEditor('Trigger', 'Se déclenche dès que le joueur entre dans la zone.', 'Actions déclenchées', ent),
    activation: renderAdvancedActivation(ent),
  };
}

// Shared "activation" card for TRIGGER/BUTTON/PLATE's own "⚡ Activation" tab
// — see engine.js's _activate/_canActivate/_graceOverlap/_fireTrigger for how
// each of these actually plays out at runtime. A plate can be activated by a
// resting crate as well as the player (it always could); trigger/button stay
// player-only unless explicitly opened up to crates here.
function renderAdvancedActivation(ent) {
  const props = ent.props;
  return fieldGroup('Réglages d\'activation', `
    <label>Comportement au relâchement</label>
    ${selectHtml('p-releasemode', RELEASE_MODE_LABELS, props.releaseMode || 'finish')}
    <p class="hint">Les actions déjà lancées vont de toute façon jusqu'au bout, que le joueur reste dessus ou non — « fermer » rend en plus l'élément définitivement inutilisable une fois cette activation terminée.</p>

    <label style="margin-top:10px;">Qui peut l'activer</label>
    ${selectHtml('p-activator', ACTIVATOR_LABELS, props.activator || 'player')}

    <label style="margin-top:10px;">Délai d'activation (secondes)</label>
    <input type="number" id="p-activationdelay" value="${props.activationDelay || 0}" min="0" step="0.1" />
    <p class="hint">Temps d'attente entre l'entrée dans la zone et le moment où les actions démarrent vraiment.</p>

    <label style="margin-top:10px;">Délai de grâce au relâchement (secondes)</label>
    <input type="number" id="p-releasegrace" value="${props.releaseGrace || 0}" min="0" step="0.1" />
    <p class="hint">Un relâchement plus court que ce délai est ignoré — pratique contre les à-coups au bord d'une zone.</p>

    <label class="toggle-row" style="margin-top:10px;"><input type="checkbox" id="p-sequential" ${props.sequential ? 'checked' : ''} />Exécuter les actions dans l'ordre (l'une après l'autre, pas toutes en même temps)</label>

    <label style="margin-top:10px;">Nombre max de répétitions</label>
    <input type="number" id="p-maxrepeats" value="${props.maxRepeats || 0}" min="0" step="1" />
    <p class="hint">0 = illimité. Une fois ce nombre atteint, l'élément se ferme définitivement.</p>

    <label style="margin-top:10px;">Délai de réarmement (secondes)</label>
    <input type="number" id="p-rearmcooldown" value="${props.rearmCooldown || 0}" min="0" step="0.1" />
    <p class="hint">0 = aucun. Temps d'attente supplémentaire, une fois les actions terminées, avant de pouvoir se réactiver.</p>`);
}

// Both button and plate can optionally alternate forward/reverse on
// successive activations — but only when "Inversement" is explicitly turned
// on. By default they always play their actions forward, every time.
function renderReversibleCheckbox(ent) {
  return `<label class="toggle-row" style="margin-top:8px;"><input type="checkbox" id="p-reversible" ${ent.props.reversible ? 'checked' : ''} />Inversement des actions (alterne : aller, puis retour, à chaque activation)</label>`;
}

function renderButtonEditor(ent) {
  const hint = ent.props.reversible
    ? 'À chaque pression, le bouton alterne : il joue les actions, puis au clic suivant il les rejoue à l\'envers (retour à l\'état initial), et ainsi de suite. Sans effet si « Boucle infinie » est cochée.'
    : 'À chaque pression, le bouton rejoue ses actions depuis le début (toujours dans le même sens). Active « Inversement des actions » ci-dessous pour qu\'il alterne aller/retour à chaque pression.';
  return {
    actions: renderActionListEditor('Bouton', hint, 'Actions déclenchées à chaque pression', ent, renderReversibleCheckbox(ent)),
    activation: renderAdvancedActivation(ent),
  };
}

function renderPlateEditor(ent) {
  const modeHint = {
    once: 'Un seul passage joue ces actions une fois — rester dessus plus longtemps ne les rejoue pas.',
    hold: 'Tant que le joueur (ou une caisse) reste dessus, ces actions se répètent automatiquement (elles s\'arrêtent dès qu\'il descend).',
    loop: 'Un seul passage suffit à lancer une répétition de ces actions qui ne s\'arrête plus, même après être descendu.',
  }[ent.props.pressMode || 'hold'];
  const reversibleHint = ent.props.reversible ? ' Elles alternent aller/retour à chaque nouveau déclenchement.' : '';
  return {
    actions: renderActionListEditor('Plaque de pression — à l\'appui', modeHint + reversibleHint, 'Actions à l\'appui', ent, renderReversibleCheckbox(ent))
      + renderPlateReleaseEditor(ent),
    activation: renderAdvancedActivation(ent),
  };
}

// A PLATE's second, independent action list: fires once, forward only, the
// moment the player (or crate) leaves it — completely separate from the
// press-side behavior above (see engine.js's _firePlateRelease). Both lists
// share the same "🧩 Assembler les actions" flow, just opening the Actions
// panel on a different sub-tab (see renderActionsPanel's actionsPanelTarget).
function renderPlateReleaseEditor(ent) {
  const count = (ent.props.releaseActions || []).length;
  const body = `
    <p class="hint" style="margin-top:0;">Se joue une fois quand le joueur (ou la caisse) quitte la plaque — indépendant des actions à l'appui ci-dessus.</p>
    <div class="row" style="align-items:center;margin-top:14px;">
      <label style="margin:0;flex:1;">Actions au relâchement</label>
      <span class="pill">${count} action${count === 1 ? '' : 's'}</span>
    </div>
    <button type="button" class="btn small primary" id="open-release-panel" style="width:100%;margin-top:8px;">🧩 Assembler les actions de relâchement</button>
    <label class="toggle-row" style="margin-top:10px;"><input type="checkbox" id="p-close-on-release" ${ent.props.closeOnRelease ? 'checked' : ''} />Fermer définitivement la plaque après (plus utilisable ensuite)</label>`;
  return fieldGroup('Au relâchement', body);
}

function defaultParamsFor(type) {
  switch (type) {
    case ACTION_TYPES.MOVE_ELEMENT: return { axisX: 1, axisY: 0, duration: 0.5 };
    case ACTION_TYPES.TELEPORT: return { x: 0, y: 0 };
    case ACTION_TYPES.SET_STATE: return { passable: false, invisible: false, harmless: false };
    default: return {}; // SET_WORLD_STATE / SET_PLAYER_STATE: every field starts unchecked/disabled
  }
}

// An "optional field" block: an enable checkbox plus the value input(s) it
// governs, used by SET_WORLD_STATE and SET_PLAYER_STATE — every field in
// those two action types is independently opt-in, since e.g. changing
// gravity shouldn't force you to also pick a background color.
function optionalBlock(key, label, innerHtml, enabled) {
  return `<div class="ws-block ${enabled ? 'is-on' : 'is-off'}" data-ws-block="${key}">
    <label class="toggle-row"><input type="checkbox" data-ws-enable="${key}" ${enabled ? 'checked' : ''} />${label}</label>
    <div data-ws-inner="${key}" style="margin:8px 0 2px 24px;${enabled ? '' : 'pointer-events:none;'}">${innerHtml}</div>
  </div>`;
}

function renderWorldStateFields(p) {
  const parts = [];
  parts.push(optionalBlock('gravityScale', 'Gravité du monde (x normal, négatif = inversée)',
    `<input type="number" step="0.1" min="-5" max="5" data-ws-value="gravityScale" value="${p.gravityScale ?? 1}" />`,
    'gravityScale' in p));
  parts.push(optionalBlock('background', "Fond d'écran",
    `<input type="color" data-ws-value="background" value="${p.background || '#1b1e2b'}" />`,
    'background' in p));
  return parts.join('');
}

function renderPlayerStateFields(p) {
  const parts = [];
  // Only shown once the level actually has a second player (playerStart2) —
  // on a single-player level this action always targets the one player that
  // exists, no selector needed. Not wrapped in optionalBlock: it's a plain
  // always-visible field, not an opt-in one (see engine.js's
  // _resolveStatePlayer, which defaults to player 1 when this is absent).
  if (level.playerStart2) {
    parts.push(`<label>Quel joueur ?</label>
      ${selectHtml('', { 1: 'Joueur 1', 2: 'Joueur 2' }, String(p.player || 1)).replace('id=""', 'data-ws-value="player"')}`);
  }
  parts.push(optionalBlock('gravity', 'Gravité du joueur',
    selectHtml('', GRAVITY_LABELS, p.gravity || 'down').replace('id=""', 'data-ws-value="gravity"'),
    'gravity' in p));
  parts.push(optionalBlock('invert', 'Touches inversées (troll)', `
    ${selectHtml('', { horizontal: 'Gauche / Droite', vertical: 'Haut / Bas', both: 'Les deux' }, p.invert || 'horizontal').replace('id=""', 'data-ws-value="invert"')}
    <label style="display:block;margin-top:6px;">Durée (s, 0 = permanent)</label>
    <input type="number" step="0.5" min="0" data-ws-value="invertDuration" value="${p.invertDuration ?? 0}" />`,
    'invert' in p));
  parts.push(optionalBlock('invisible', 'Visibilité du joueur',
    `<label class="toggle-row"><input type="checkbox" data-ws-value="invisible" ${p.invisible ? 'checked' : ''} />Joueur invisible</label>`,
    'invisible' in p));
  parts.push(optionalBlock('jumpMult', 'Puissance de saut (x normal)', `
    <input type="number" step="0.1" min="0" data-ws-value="jumpMult" value="${p.jumpMult ?? 1}" />
    <label style="display:block;margin-top:6px;">Durée (s, 0 = permanent)</label>
    <input type="number" step="0.5" min="0" data-ws-value="statDuration" value="${p.statDuration ?? 0}" />`,
    'jumpMult' in p));
  parts.push(optionalBlock('speedMult', 'Vitesse de déplacement (x normal)', `
    <input type="number" step="0.1" min="0" data-ws-value="speedMult" value="${p.speedMult ?? 1}" />
    <label style="display:block;margin-top:6px;">Durée (s, 0 = permanent)</label>
    <input type="number" step="0.5" min="0" data-ws-value="statDuration" value="${p.statDuration ?? 0}" />`,
    'speedMult' in p));
  return parts.join('');
}

// Keys that belong together inside one optional block, so unchecking the
// block's enable checkbox removes all of them from params at once.
const WS_BLOCK_KEYS = {
  gravityScale: ['gravityScale'],
  background: ['background'],
  gravity: ['gravity'],
  invert: ['invert', 'invertDuration'],
  invisible: ['invisible'],
  jumpMult: ['jumpMult'],
  speedMult: ['speedMult'],
  facing: ['facing'],
};

function setActionParamFromInput(action, el) {
  const field = el.dataset.wsValue;
  let val;
  if (el.type === 'checkbox') val = el.checked;
  else if (el.type === 'number') val = parseFloat(el.value);
  else if (field === 'player') val = parseInt(el.value, 10); // "Quel joueur ?" select: 1 or 2, not a string
  else val = el.value;
  action.params[field] = val;
  render();
}

function bindOptionalFields(action, row) {
  row.querySelectorAll('[data-ws-enable]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const key = chk.dataset.wsEnable;
      const inner = row.querySelector(`[data-ws-inner="${key}"]`);
      const block = row.querySelector(`[data-ws-block="${key}"]`);
      if (chk.checked) {
        if (inner) inner.style.pointerEvents = '';
        if (block) block.classList.replace('is-off', 'is-on');
        (inner ? inner.querySelectorAll('[data-ws-value]') : []).forEach((el) => setActionParamFromInput(action, el));
      } else {
        if (inner) inner.style.pointerEvents = 'none';
        if (block) block.classList.replace('is-on', 'is-off');
        for (const k of (WS_BLOCK_KEYS[key] || [key])) delete action.params[k];
        // statDuration is shared between jumpMult and speedMult: only drop it
        // once neither of those two is enabled anymore.
        if ((key === 'jumpMult' || key === 'speedMult') && !('jumpMult' in action.params) && !('speedMult' in action.params)) {
          delete action.params.statDuration;
        }
        render();
      }
    });
  });
  row.querySelectorAll('[data-ws-value]').forEach((el) => {
    el.addEventListener('change', () => setActionParamFromInput(action, el));
  });
}

function renderActionRow(ent, action) {
  const p = action.params || {};
  let fields = '';
  switch (action.type) {
    case ACTION_TYPES.MOVE_ELEMENT:
      fields = `
        <div class="row">
          <div><label>Axe X (largeur) : +1 droite / -1 gauche</label><input type="number" data-f="axisX" value="${p.axisX ?? 0}" /></div>
          <div><label>Axe Y (hauteur) : +1 monte / -1 descend</label><input type="number" data-f="axisY" value="${p.axisY ?? 0}" /></div>
        </div>
        <label>Durée (s)</label><input type="number" step="0.1" data-f="duration" value="${p.duration ?? 0.5}" />`;
      break;
    case ACTION_TYPES.TELEPORT:
      fields = `<div class="row">
          <div><label>x (case)</label><input type="number" data-f="x" class="teleport-coord-input" value="${p.x ?? 0}" /></div>
          <div><label>y (case)</label><input type="number" data-f="y" class="teleport-coord-input" value="${p.y ?? 0}" /></div>
        </div>
        <p class="hint" style="margin-top:2px;">Astuce : clique dans un des deux champs ci-dessus pour afficher les coordonnées (x,y) de chaque case sur la grille.</p>`;
      break;
    case ACTION_TYPES.SET_STATE:
      fields = `<label>Nouvel état de la cible</label><div class="toggle-list">
        ${ENTITY_TOGGLES.map(t => `<label class="toggle-row"><input type="checkbox" data-f="${t}" data-bool="1" ${p[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`).join('')}
      </div>
      ${optionalBlock('facing', 'Rotation (ex. pointes)',
        selectHtml('', FACING_LABELS, p.facing || 'up').replace('id=""', 'data-ws-value="facing"'),
        'facing' in p)}`;
      break;
    case ACTION_TYPES.SET_WORLD_STATE:
      fields = renderWorldStateFields(p);
      break;
    case ACTION_TYPES.SET_PLAYER_STATE:
      fields = renderPlayerStateFields(p);
      break;
  }
  const needsTarget = NEEDS_TARGET.has(action.type);
  const allowPlayer = ALLOWS_PLAYER_TARGET.has(action.type);
  const target = targetLabelFor(action.targetId) || '— aucune —';
  return `
    <div class="action-item" data-action="${action.id}">
      <div class="head">
        ${selectHtml('', ACTION_LABELS, action.type).replace('id=""', `data-f="type"`)}
        <button class="btn small danger" data-remove-action="${action.id}">✕</button>
      </div>
      ${needsTarget ? `<label>Cible</label>
      <div class="row" style="align-items:center;">
        <span class="pill" data-target-label>${target}</span>
        <button class="btn small" data-pick-target="${action.id}">Choisir sur la grille</button>
        ${playerTargetButtons(action, allowPlayer)}
      </div>` : ''}
      <label>Délai après déclenchement (s)</label>
      <input type="number" step="0.1" data-f="delay" value="${action.delay || 0}" />
      ${fields}
    </div>`;
}

function shortId(id) { return id ? id.split('_').slice(-2).join('_') : ''; }

// Shared by renderActionRow and renderActionBlock: an action's target can be
// a normal entity, the special 'player' id (always player 1), or — once the
// level has a second player (playerStart2) — 'player2'.
function targetLabelFor(targetId) {
  if (targetId === 'player') return level.playerStart2 ? 'Joueur 1' : 'Joueur';
  if (targetId === 'player2') return 'Joueur 2';
  return targetId ? shortId(targetId) : null;
}
function playerTargetButtons(action, allowPlayer) {
  if (!allowPlayer) return '';
  let html = `<button type="button" class="btn small" data-pick-player="${action.id}">= Joueur${level.playerStart2 ? ' 1' : ''}</button>`;
  if (level.playerStart2) html += `<button type="button" class="btn small" data-pick-player2="${action.id}">= Joueur 2</button>`;
  return html;
}

function bindActionRow(ent, action, container = propsEl, onRelease = false) {
  const row = container.querySelector(`.action-item[data-action="${action.id}"]`);
  if (!row) return;
  row.querySelectorAll('[data-f]').forEach((el) => {
    const field = el.dataset.f;
    const handler = () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') val = parseFloat(val);
      if (field === 'type') {
        action.type = val; action.targetId = null;
        action.params = defaultParamsFor(val);
        render();
        return;
      }
      if (field === 'delay') { action.delay = val; return; }
      action.params[field] = val;
      render();
    };
    el.addEventListener('change', handler);
  });
  row.querySelectorAll('.teleport-coord-input').forEach((el) => {
    el.addEventListener('focus', () => { showCoordOverlay = true; render(); });
    el.addEventListener('blur', () => { showCoordOverlay = false; render(); });
  });
  bindOptionalFields(action, row);
  const removeBtn = row.querySelector('[data-remove-action]');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    if (onRelease) ent.props.releaseActions = ent.props.releaseActions.filter((a) => a.id !== action.id);
    else ent.props.actions = ent.props.actions.filter((a) => a.id !== action.id);
    render();
  });
  const pickBtn = row.querySelector('[data-pick-target]');
  if (pickBtn) pickBtn.addEventListener('click', () => {
    pickingTargetFor = { onPick: (id) => { action.targetId = id; render(); } };
    pickBanner.classList.remove('hidden');
  });
  const pickPlayerBtn = row.querySelector('[data-pick-player]');
  if (pickPlayerBtn) pickPlayerBtn.addEventListener('click', () => { action.targetId = 'player'; render(); });
  const pickPlayer2Btn = row.querySelector('[data-pick-player2]');
  if (pickPlayer2Btn) pickPlayer2Btn.addEventListener('click', () => { action.targetId = 'player2'; render(); });
}

// ---------------------------------------------------------------- toolbar
function bindToolbar() {
  titleInput.addEventListener('change', () => { level.title = titleInput.value; });
  // authorInput is read-only: the author is always the signed-in account's
  // name (see syncAuthorField), never free text.
  colsInput.addEventListener('change', () => {
    level.cols = clampInt(parseInt(colsInput.value, 10) || level.cols, GRID_LIMITS.colsMin, GRID_LIMITS.colsMax);
    colsInput.value = level.cols;
    resizeCanvas(); render(); updateLevelSettingsLabel();
  });
  rowsInput.addEventListener('change', () => {
    level.rows = clampInt(parseInt(rowsInput.value, 10) || level.rows, GRID_LIMITS.rowsMin, GRID_LIMITS.rowsMax);
    rowsInput.value = level.rows;
    resizeCanvas(); render(); updateLevelSettingsLabel();
  });
  if (worldGravityInput) worldGravityInput.addEventListener('change', () => {
    const v = parseFloat(worldGravityInput.value);
    // Negative is intentional (inverts fall direction — see engine.js's
    // _effectiveGravityDir) — only reject NaN, not sign.
    level.gravityScale = Number.isFinite(v) ? Math.max(-5, Math.min(5, v)) : 1;
    worldGravityInput.value = level.gravityScale;
    updateLevelSettingsLabel();
  });
  if (worldBgInput) worldBgInput.addEventListener('input', () => {
    level.background = worldBgInput.value || '#1b1e2b';
    render();
  });
  if (ceilingGlitchInput) ceilingGlitchInput.addEventListener('change', () => {
    level.ceilingJumpGlitch = ceilingGlitchInput.checked;
  });

  document.getElementById('new-level').addEventListener('click', async () => {
    const ok = await confirmModal('Créer un nouveau niveau vide ? Le travail non sauvegardé sera perdu.', { title: 'Nouveau niveau', okLabel: 'Créer', danger: true });
    if (!ok) return;
    level = createEmptyLevel('Nouveau niveau');
    level.localKey = null;
    editingRemoteId = null;
    hiddenLayers.clear();
    syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
    initUndoHistory();
  });

  const loadDemoBtn = document.getElementById('load-demo');
  if (loadDemoBtn) loadDemoBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Charger le niveau de démonstration ? Le travail non sauvegardé sera perdu.', { title: 'Charger la démo', okLabel: 'Charger', danger: true });
    if (!ok) return;
    level = buildSampleLevel();
    level.localKey = null;
    editingRemoteId = null;
    hiddenLayers.clear();
    syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
    initUndoHistory();
  });

  document.getElementById('undo-btn').addEventListener('click', undo);
  document.getElementById('redo-btn').addEventListener('click', redo);

  document.getElementById('save-local').addEventListener('click', () => {
    const key = saveLocalDraft(level);
    history.replaceState(null, '', `editor.html?local=${key}`);
    setStatus('Brouillon enregistré dans ce navigateur ✓');
    showToast('Brouillon enregistré dans ce navigateur ✓', { type: 'success' });
  });

  document.getElementById('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(level, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // The downloaded filename follows the title as typed (spaces kept, e.g.
    // "Niveau 1" -> "Niveau 1.json") — only characters an OS actually
    // rejects in a filename get swapped out.
    const safeName = (level.title || 'niveau').trim().replace(/[\\/:*?"<>|]+/g, '_');
    a.download = `${safeName}.json`;
    a.click();
    showToast('Fichier JSON téléchargé ✓', { type: 'success' });
  });

  document.getElementById('import-json').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        level = normalizeLevel(JSON.parse(reader.result));
        level.localKey = null;
        editingRemoteId = null;
        hiddenLayers.clear();
        syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
        initUndoHistory();
        setStatus('Niveau importé ✓');
        showToast('Niveau importé ✓', { type: 'success' });
      } catch {
        setStatus('Fichier JSON invalide.', true);
        showToast('Fichier JSON invalide.', { type: 'error' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('publish-btn').addEventListener('click', async () => {
    const errors = validateLevel(level);
    if (errors.length) { setStatus(errors.join(' '), true); showToast(errors.join(' '), { type: 'error', duration: 5000 }); return; }
    const ready = await isBackendReady();
    if (!ready) { setStatus('Supabase non configuré : impossible de publier pour le moment.', true); showToast('Supabase non configuré : impossible de publier pour le moment.', { type: 'error' }); return; }
    if (!session) { setStatus('Connecte-toi (ou crée un compte) ci-dessus pour publier : le nom d’auteur vient de ton compte.', true); showToast('Connecte-toi (en haut) pour publier — le nom d’auteur vient de ton compte.', { type: 'error' }); return; }
    try {
      if (editingRemoteId) {
        setStatus('Enregistrement…');
        await updateOwnLevel(editingRemoteId, level);
        setStatus('Modifications enregistrées ✓');
        showToast('Modifications enregistrées ✓', { type: 'success' });
      } else {
        setStatus('Publication…');
        const res = await publishLevel(level);
        editingRemoteId = res.id;
        updatePublishButtonState();
        setStatus(`Publié ✓ (id ${res.id.slice(0, 8)}…)`);
        showToast('Niveau publié avec succès ✓', { type: 'success' });
      }
    } catch (err) {
      setStatus('Erreur lors de la publication : ' + (err.message || err), true);
      showToast('Erreur lors de la publication : ' + (err.message || err), { type: 'error' });
    }
  });

  document.getElementById('playtest-btn').addEventListener('click', togglePlaytest);
  const realViewBtnEl = document.getElementById('real-view-btn');
  if (realViewBtnEl) realViewBtnEl.addEventListener('click', toggleEditRealView);
  document.getElementById('debug-view-btn').addEventListener('click', () => {
    if (!testEngine) return;
    testEngine.debugTriggers = !testEngine.debugTriggers;
    updateDebugViewBtn();
  });
  document.getElementById('cancel-pick').addEventListener('click', () => {
    pickingTargetFor = null;
    pickBanner.classList.add('hidden');
  });

  bindLevelSettingsModal();
}

// The grid size + "condition du monde" fields (gravité, fond d'écran) live
// inside a small modal (kept out of the main toolbar so it doesn't compete
// for space with the far more frequently used buttons); the inputs
// themselves are the exact same long-lived elements referenced everywhere
// above (colsInput, worldGravityInput…) — this just shows/hides the panel.
function bindLevelSettingsModal() {
  const modal = document.getElementById('level-settings-modal');
  const openBtn = document.getElementById('level-settings-btn');
  const closeBtn = document.getElementById('level-settings-close');
  const doneBtn = document.getElementById('level-settings-done');
  const open = () => modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  doneBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
  bindGridShift();
}

// ---------------------------------------------------------------- grid-shift tool
// Growing/shrinking the grid (cols/rows, above) only ever adds/removes space
// at the bottom-right — everything already placed stays pinned to its old
// (x,y). This is the complement: move EVERY placed entity plus the player
// spawn(s) by the same (dx,dy) offset in one step, so an author who just grew
// the grid to make room at the top (say) can push their whole existing
// layout down into the new space instead of re-dragging every piece by hand.
// Deliberately does not clamp results to stay on-grid — a shift is often
// used together with a grid resize where the two together net out fine, and
// with undo/redo (task #74) now in place, an overshoot is one Ctrl+Z away.
function shiftGrid(dx, dy) {
  if (previewMode || (!dx && !dy)) return;
  for (const ent of level.entities) { ent.x += dx; ent.y += dy; }
  level.playerStart.x += dx; level.playerStart.y += dy;
  if (level.playerStart2) { level.playerStart2.x += dx; level.playerStart2.y += dy; }
  const outOfBounds = (x, y, w = 1, h = 1) => x < 0 || y < 0 || x + w > level.cols || y + h > level.rows;
  const wentOffGrid = level.entities.some((e) => outOfBounds(e.x, e.y, e.w, e.h))
    || outOfBounds(level.playerStart.x, level.playerStart.y)
    || (level.playerStart2 && outOfBounds(level.playerStart2.x, level.playerStart2.y));
  render();
  renderProps();
  if (wentOffGrid) setStatus('Au moins un élément est maintenant hors de la grille visible — ajuste la taille de la grille si besoin.', true);
}

function bindGridShift() {
  const stepInput = document.getElementById('shift-step');
  const step = () => Math.max(1, Math.round(parseFloat(stepInput.value)) || 1);
  document.getElementById('shift-up').addEventListener('click', () => shiftGrid(0, -step()));
  document.getElementById('shift-down').addEventListener('click', () => shiftGrid(0, step()));
  document.getElementById('shift-left').addEventListener('click', () => shiftGrid(-step(), 0));
  document.getElementById('shift-right').addEventListener('click', () => shiftGrid(step(), 0));
}

// While playtesting, lets you flip between the builder's "debug" view (grid,
// trigger zones, invisible entities all revealed) and the "real" view — the
// exact same rendering a player gets in game.html, with the grid, triggers
// and anything marked invisible hidden.
function updateDebugViewBtn() {
  const btn = document.getElementById('debug-view-btn');
  if (!playtesting || !testEngine) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = testEngine.debugTriggers ? '🎬 Voir la vraie partie' : '🐞 Revoir la vue debug';
}

function togglePlaytest() {
  playtesting = !playtesting;
  const btn = document.getElementById('playtest-btn');
  const realViewBtn = document.getElementById('real-view-btn');
  if (playtesting) {
    btn.textContent = '⏹ Arrêter le test';
    if (realViewBtn) realViewBtn.style.display = 'none'; // its own edit-canvas concept, meaningless mid-playtest
    canvas.width = Math.min(900, level.cols * CELL);
    canvas.height = Math.min(520, level.rows * CELL);
    testEngine = new Engine(canvas, cloneLevel(level));
    testEngine.debugTriggers = false; // starts in the real view by default — 🐞 debug view is the opt-in now
    testEngine.start();
  } else {
    btn.textContent = '▶ Tester le niveau';
    if (realViewBtn) realViewBtn.style.display = '';
    if (testEngine) { testEngine.destroy(); testEngine = null; }
    resizeCanvas();
    render();
  }
  updateDebugViewBtn();
  updateUndoRedoButtons();
}

// The edit-canvas counterpart to the playtest's own debug/real toggle above
// (updateDebugViewBtn) — same idea, but for the static builder view, and
// without needing to start an interactive playtest at all: a straight
// read-only preview of exactly what real play looks like (see render()).
function toggleEditRealView() {
  if (playtesting) return; // the button is hidden then anyway (see togglePlaytest)
  editRealView = !editRealView;
  const btn = document.getElementById('real-view-btn');
  if (btn) btn.textContent = editRealView ? '🛠️ Revenir à l\'édition' : '🎬 Voir le jeu';
  render();
}

init();
