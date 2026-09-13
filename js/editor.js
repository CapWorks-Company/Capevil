import {
  CELL, ENTITY_TYPES, ACTION_TYPES, GRAVITY_DIRS, GRID_LIMITS,
  ENTITY_TOGGLES, TOGGLE_LABELS, togglesForType, FACING_LABELS,
  TELEPORTER_MAX_PER_FREQUENCY, TELEPORTER_FREQUENCIES,
} from './constants.js';
import {
  createEmptyLevel, createEntity, createAction, cloneLevel, findEntity,
  removeEntity, validateLevel, uid, normalizeLevel, nextTeleporterFrequency,
} from './level-model.js';
import { buildSampleLevel } from './sample-level.js';
import { Engine } from './engine.js';
import { saveLocalDraft, loadLocalDraft } from './local-storage.js';
import { publishLevel, updateOwnLevel, getLevel, isBackendReady, getSession, getMyProfile } from './supabase-client.js';
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
  { type: ENTITY_TYPES.PLATFORM, label: 'Plateforme mobile', color: '#2d6cdf', icon: '▬' },
  { type: ENTITY_TYPES.TELEPORTER, label: 'Téléporteur', color: '#9d4edd', icon: '🌀' },
  { type: ENTITY_TYPES.CHECKPOINT, label: 'Checkpoint', color: '#118ab2', icon: '🚩' },
  { type: ENTITY_TYPES.GOAL, label: 'Arrivée (but)', color: '#2ec4b6', icon: '🏁' },
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
let showCoordOverlay = false; // true while a "Téléporter un élément" action's x/y field has focus

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const toolboxEl = document.getElementById('toolbox');
const propsEl = document.getElementById('props');
const titleInput = document.getElementById('level-title-input');
const authorInput = document.getElementById('level-author-input');
const colsInput = document.getElementById('cols-input');
const rowsInput = document.getElementById('rows-input');
const worldGravityInput = document.getElementById('ws-gravity');
const worldBgInput = document.getElementById('ws-bg');
const statusEl = document.getElementById('status-msg');
const pickBanner = document.getElementById('pick-banner');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff8a8a' : 'var(--muted)';
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}

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
  bindToolbar();
  bindCanvas();
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
      },
    });
  } else {
    session = await getSession();
    await syncAuthorField();
  }
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
  ['new-level', 'load-demo', 'save-local', 'export-json', 'publish-btn', 'level-settings-btn']
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
  toolboxEl.append(selectBtn, startBtn, eraseBtn);
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

// ---------------------------------------------------------------- rendering (static edit view)
function render() {
  if (playtesting) return;
  ctx.fillStyle = level.background || '#1b1e2b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let c = 0; c <= level.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke(); }
  for (let r = 0; r <= level.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke(); }

  for (const ent of level.entities) drawEntity(ent);
  drawTriggerLinks();
  if (showCoordOverlay) drawCoordOverlay();

  // player start marker
  const ps = level.playerStart;
  ctx.fillStyle = 'rgba(247,127,0,0.85)';
  ctx.fillRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);
  ctx.strokeStyle = '#fff'; ctx.strokeRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);
  if (ps.invisible) { ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('👻', ps.x * CELL + CELL / 2, ps.y * CELL + CELL / 2 + 4); }

  if (selectedId === 'playerstart') {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.strokeRect(ps.x * CELL - 2, ps.y * CELL - 2, CELL + 4, CELL + 4);
  } else if (selectedId) {
    const ent = findEntity(level, selectedId);
    if (ent) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(ent.x * CELL - 2, ent.y * CELL - 2, ent.w * CELL + 4, ent.h * CELL + 4);
    }
  }
}

// Draws a dashed "string" from the currently-selected trigger/button/plate to
// every entity its actions target — only while it's selected, so the grid
// doesn't get cluttered with every link in the level at once.
function drawTriggerLinks() {
  if (!selectedId || selectedId === 'playerstart') return;
  const trig = findEntity(level, selectedId);
  if (!trig || !hasActionListType(trig.type)) return;
  const actions = (trig.props && trig.props.actions) || [];
  if (!actions.length) return;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = ctx.strokeStyle;
  const fromX = trig.x * CELL + (trig.w * CELL) / 2;
  const fromY = trig.y * CELL + (trig.h * CELL) / 2;
  const seen = new Set();
  for (const action of actions) {
    if (!action.targetId || seen.has(action.targetId)) continue;
    seen.add(action.targetId);
    if (action.targetId === 'player') {
      const ps = level.playerStart;
      drawLink(fromX, fromY, ps.x * CELL + CELL / 2, ps.y * CELL + CELL / 2);
      continue;
    }
    const target = findEntity(level, action.targetId);
    if (!target) continue;
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
  if (ent.passable || ent.invisible) ctx.globalAlpha = 0.55;
  switch (ent.type) {
    case ENTITY_TYPES.BLOCK: ctx.fillStyle = '#111319'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#3a3f52'; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); break;
    case ENTITY_TYPES.PLATFORM:
      if (ent.props && ent.props.style === 'block') {
        ctx.fillStyle = '#111319'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#3a3f52'; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      } else {
        ctx.fillStyle = (ent.props && ent.props.color) || '#2d6cdf'; ctx.fillRect(x, y, w, h);
      }
      break;
    case ENTITY_TYPES.CRATE:
      ctx.fillStyle = '#8a5a34'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#5c3a1e'; ctx.lineWidth = 2; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + w - 4, y + h - 4);
      ctx.moveTo(x + w - 4, y + 4); ctx.lineTo(x + 4, y + h - 4);
      ctx.stroke();
      break;
    case ENTITY_TYPES.SPIKE: {
      ctx.fillStyle = ent.harmless ? '#5b6b7a' : '#e63946';
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
      ctx.fillStyle = ent.harmless ? '#5b6b7a' : '#c9184a'; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, CELL * 0.4, 0, Math.PI * 2); ctx.fill();
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
      ctx.fillStyle = '#2b2d3d'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#5b5f7a'; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.fillStyle = '#06d6a0'; ctx.fillRect(x + w * 0.18, y + h * 0.56, w * 0.64, h * 0.32);
      if (ent.props.loop) { ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('∞', x + w / 2, y + h * 0.32); }
      break;
    case ENTITY_TYPES.PLATE:
      ctx.fillStyle = '#5c3d13'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#c98a2b'; ctx.fillRect(x + 3, y + h * 0.55, w - 6, h * 0.35);
      ctx.strokeStyle = '#7a531a'; ctx.strokeRect(x + 3, y + h * 0.55, w - 6, h * 0.35);
      if (ent.props.loop) { ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('∞', x + w / 2, y + h * 0.32); }
      break;
  }
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
  // topmost (last placed) entity whose box contains the cell
  for (let i = level.entities.length - 1; i >= 0; i--) {
    const e = level.entities[i];
    if (cx >= e.x && cx < e.x + e.w && cy >= e.y && cy < e.y + e.h) return e;
  }
  return null;
}

function handleCellClick(cx, cy) {
  if (previewMode) {
    // View-only: clicking only ever selects (to inspect props), never
    // moves/places/erases anything.
    const clicked = entityAt(cx, cy);
    selectedId = clicked ? clicked.id : (cx === level.playerStart.x && cy === level.playerStart.y ? 'playerstart' : null);
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
      } else {
        const ent = findEntity(level, selectedId);
        if (ent) { ent.x = cx; ent.y = cy; }
      }
    } else {
      const clicked = entityAt(cx, cy);
      if (clicked) selectedId = clicked.id;
      else if (cx === level.playerStart.x && cy === level.playerStart.y) selectedId = 'playerstart';
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
  if (selectedId === 'playerstart') { renderPlayerStartProps(); return; }
  const ent = findEntity(level, selectedId);
  if (!ent) { selectedId = null; return renderProps(); }

  const html = [];
  html.push(`<div class="props-header"><h3>Propriétés</h3><div class="pill type-badge">${paletteLabel(ent.type)}</div></div>`);
  html.push('<div class="props-panel">');
  html.push(`<label>Position (colonne / ligne)</label>
    <div class="row">
      <input type="number" id="p-x" value="${ent.x}" min="0" max="${level.cols - 1}" />
      <input type="number" id="p-y" value="${ent.y}" min="0" max="${level.rows - 1}" />
    </div>`);

  // Solid blocks are placed one cell at a time and never resized (they
  // assemble seamlessly instead), and a checkpoint's flag is always drawn at
  // the same fixed size — so the size fields simply don't apply to either.
  if (ent.type !== ENTITY_TYPES.BLOCK && ent.type !== ENTITY_TYPES.CHECKPOINT) {
    html.push(`<label>Taille (largeur / hauteur en cases)</label>
      <div class="row">
        <input type="number" id="p-w" value="${ent.w}" min="1" max="${level.cols}" />
        <input type="number" id="p-h" value="${ent.h}" min="1" max="${level.rows}" />
      </div>`);
  }

  const toggles = togglesForType(ent.type);
  if (toggles.length) {
    const rows = toggles.map(t => `<label class="toggle-row"><input type="checkbox" data-toggle="${t}" ${ent[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`).join('');
    html.push(fieldGroup('État', `<div class="toggle-list">${rows}</div>`));
  }

  if (ent.type === ENTITY_TYPES.SPIKE) {
    html.push(fieldGroup('Orientation', `
      ${selectHtml('p-facing', FACING_LABELS, ent.props.facing || 'up')}`));
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
      <input type="number" id="p-speed" value="${ent.props.speed ?? 2}" step="0.1" min="0.1" max="10" />`));
  }
  if (ent.type === ENTITY_TYPES.PLATFORM) {
    const style = ent.props.style === 'block' ? 'block' : 'color';
    const colorRow = style === 'color' ? `
      <label>Couleur</label>
      <div class="row" style="align-items:center;gap:8px;">
        <input type="color" id="p-color" value="${ent.props.color || '#2d6cdf'}" style="width:52px;height:32px;padding:2px;flex:none;" />
        <button class="btn small" id="p-color-reset" type="button">Couleur par défaut</button>
      </div>` : `
      <p class="hint" style="margin-top:0;">La plateforme est rendue exactement comme un bloc solide (même couleur, même style) — pratique pour la camoufler parmi de vrais blocs.</p>`;
    html.push(fieldGroup('Apparence', `
      <label>Style</label>
      ${selectHtml('p-platform-style', { color: 'Couleur personnalisée', block: 'Bloc solide' }, style)}
      ${colorRow}`));
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

  html.push('<button class="btn danger small" id="delete-ent" style="margin-top:4px;width:100%;">Supprimer cet élément</button>');
  html.push('</div>');

  if (ent.type === ENTITY_TYPES.TRIGGER) html.push(renderTriggerEditor(ent));
  if (ent.type === ENTITY_TYPES.BUTTON) html.push(renderButtonEditor(ent));
  if (ent.type === ENTITY_TYPES.PLATE) html.push(renderPlateEditor(ent));

  propsEl.innerHTML = html.join('');
  bindPropsInputs(ent);
  if (previewMode) {
    // Bindings above still get attached (harmless — they'd just mutate an
    // in-memory level nothing ever saves), but disable every control so
    // there's nothing to accidentally click/type into in the first place.
    propsEl.querySelectorAll('input, select, button, textarea').forEach((el) => { el.disabled = true; });
  }
}

function renderPlayerStartProps() {
  const ps = level.playerStart;
  const html = [];
  html.push('<div class="props-header"><h3>Propriétés</h3><div class="pill type-badge">🧍 Départ joueur</div></div>');
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
  html.push('</div>');
  propsEl.innerHTML = html.join('');

  const num = (id, cb) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => cb(parseFloat(el.value))); };
  num('p-x', (v) => { ps.x = clampInt(v, 0, level.cols - 1); render(); });
  num('p-y', (v) => { ps.y = clampInt(v, 0, level.rows - 1); render(); });
  const gravSel = document.getElementById('p-ps-gravity');
  if (gravSel) gravSel.addEventListener('change', () => { ps.gravityDir = gravSel.value; });
  const invChk = document.getElementById('p-ps-invisible');
  if (invChk) invChk.addEventListener('change', () => { ps.invisible = invChk.checked; render(); });
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

  const colorInput = document.getElementById('p-color');
  if (colorInput) colorInput.addEventListener('input', () => { ent.props.color = colorInput.value; render(); });
  const colorResetBtn = document.getElementById('p-color-reset');
  if (colorResetBtn) colorResetBtn.addEventListener('click', () => { ent.props.color = null; render(); renderProps(); });
  const platformStyleSel = document.getElementById('p-platform-style');
  if (platformStyleSel) platformStyleSel.addEventListener('change', () => { ent.props.style = platformStyleSel.value; render(); renderProps(); });

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

  // trigger/button/plate-specific bindings
  const loopChk = document.getElementById('p-loop');
  if (loopChk) loopChk.addEventListener('change', () => { ent.props.loop = loopChk.checked; render(); renderProps(); });
  const reversibleChk = document.getElementById('p-reversible');
  if (reversibleChk) reversibleChk.addEventListener('change', () => { ent.props.reversible = reversibleChk.checked; render(); renderProps(); });
  const addActionBtn = document.getElementById('add-action');
  if (addActionBtn) addActionBtn.addEventListener('click', () => {
    ent.props.actions.push(createAction(ACTION_TYPES.MOVE_ELEMENT, { params: defaultParamsFor(ACTION_TYPES.MOVE_ELEMENT) }));
    renderProps();
  });
  ent.props.actions && ent.props.actions.forEach((action) => bindActionRow(ent, action));
}

function clampInt(v, min, max) { return Math.max(min, Math.min(max, Math.round(v))); }

// ------------------------------------------------------- trigger/button/plate UI
function renderLoopCheckbox(ent) {
  return `<label class="toggle-row" style="margin-top:8px;"><input type="checkbox" id="p-loop" ${ent.props.loop ? 'checked' : ''} />Boucle infinie (une fois déclenché, répète les actions pour toujours)</label>`;
}

// Shared shape for TRIGGER/BUTTON/PLATE: a titled card explaining how it
// fires, an optional extra toggle (e.g. "reversible" for button/plate), the
// loop checkbox, then its list of actions with an "add" button.
function renderActionListEditor(title, hintHtml, actionsLabel, ent, extraHtml = '') {
  const body = `
    <p class="hint" style="margin-top:0;">${hintHtml}</p>
    ${extraHtml}
    ${renderLoopCheckbox(ent)}
    <label style="margin-top:14px;">${actionsLabel}</label>
    <div id="actions-list">${(ent.props.actions || []).map((a) => renderActionRow(ent, a)).join('')}</div>
    <button class="btn small" id="add-action" style="width:100%;margin-top:6px;">+ Ajouter une action</button>`;
  return fieldGroup(title, body);
}

function renderTriggerEditor(ent) {
  return renderActionListEditor('Trigger', 'Se déclenche dès que le joueur entre dans la zone.', 'Actions déclenchées', ent);
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
  return renderActionListEditor('Bouton', hint, 'Actions déclenchées à chaque pression', ent, renderReversibleCheckbox(ent));
}

function renderPlateEditor(ent) {
  const hint = ent.props.reversible
    ? 'Tant que le joueur reste dessus, les actions se répètent automatiquement en alternant aller/retour à chaque cycle (elles s\'arrêtent dès qu\'il descend) — sauf si « Boucle infinie » est cochée, auquel cas un seul passage suffit à lancer une répétition qui ne s\'arrête plus.'
    : 'Tant que le joueur reste dessus, les actions se répètent automatiquement dans le même sens (elles s\'arrêtent dès qu\'il descend) — sauf si « Boucle infinie » est cochée, auquel cas un seul passage suffit à lancer une répétition qui ne s\'arrête plus. Active « Inversement des actions » ci-dessous pour alterner aller/retour à chaque cycle.';
  return renderActionListEditor('Plaque de pression', hint, 'Actions déclenchées', ent, renderReversibleCheckbox(ent));
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
  parts.push(optionalBlock('gravityScale', 'Gravité du monde (x normal)',
    `<input type="number" step="0.1" min="0.1" max="5" data-ws-value="gravityScale" value="${p.gravityScale ?? 1}" />`,
    'gravityScale' in p));
  parts.push(optionalBlock('background', "Fond d'écran",
    `<input type="color" data-ws-value="background" value="${p.background || '#1b1e2b'}" />`,
    'background' in p));
  return parts.join('');
}

function renderPlayerStateFields(p) {
  const parts = [];
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
  const target = action.targetId === 'player' ? 'Joueur' : (action.targetId ? shortId(action.targetId) : '— aucune —');
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
        ${allowPlayer ? `<button class="btn small" data-pick-player="${action.id}">= Joueur</button>` : ''}
      </div>` : ''}
      <label>Délai après déclenchement (s)</label>
      <input type="number" step="0.1" data-f="delay" value="${action.delay || 0}" />
      ${fields}
    </div>`;
}

function shortId(id) { return id ? id.split('_').slice(-2).join('_') : ''; }

function bindActionRow(ent, action) {
  const row = propsEl.querySelector(`.action-item[data-action="${action.id}"]`);
  if (!row) return;
  row.querySelectorAll('[data-f]').forEach((el) => {
    const field = el.dataset.f;
    const handler = () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') val = parseFloat(val);
      if (field === 'type') {
        action.type = val; action.targetId = null;
        action.params = defaultParamsFor(val);
        renderProps(); render();
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
    ent.props.actions = ent.props.actions.filter((a) => a.id !== action.id);
    renderProps(); render();
  });
  const pickBtn = row.querySelector('[data-pick-target]');
  if (pickBtn) pickBtn.addEventListener('click', () => {
    pickingTargetFor = { onPick: (id) => { action.targetId = id; renderProps(); render(); } };
    pickBanner.classList.remove('hidden');
  });
  const pickPlayerBtn = row.querySelector('[data-pick-player]');
  if (pickPlayerBtn) pickPlayerBtn.addEventListener('click', () => { action.targetId = 'player'; renderProps(); render(); });
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
    level.gravityScale = Number.isFinite(v) && v > 0 ? v : 1;
    worldGravityInput.value = level.gravityScale;
    updateLevelSettingsLabel();
  });
  if (worldBgInput) worldBgInput.addEventListener('input', () => {
    level.background = worldBgInput.value || '#1b1e2b';
    render();
  });

  document.getElementById('new-level').addEventListener('click', async () => {
    const ok = await confirmModal('Créer un nouveau niveau vide ? Le travail non sauvegardé sera perdu.', { title: 'Nouveau niveau', okLabel: 'Créer', danger: true });
    if (!ok) return;
    level = createEmptyLevel('Nouveau niveau');
    level.localKey = null;
    editingRemoteId = null;
    syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
  });

  const loadDemoBtn = document.getElementById('load-demo');
  if (loadDemoBtn) loadDemoBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Charger le niveau de démonstration ? Le travail non sauvegardé sera perdu.', { title: 'Charger la démo', okLabel: 'Charger', danger: true });
    if (!ok) return;
    level = buildSampleLevel();
    level.localKey = null;
    editingRemoteId = null;
    syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
  });

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
    a.download = `${(level.title || 'niveau').replace(/\s+/g, '_')}.json`;
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
        syncHeaderInputs(); syncAuthorField(); resizeCanvas(); selectedId = null; render(); renderProps();
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
  if (playtesting) {
    btn.textContent = '⏹ Arrêter le test';
    canvas.width = Math.min(900, level.cols * CELL);
    canvas.height = Math.min(520, level.rows * CELL);
    testEngine = new Engine(canvas, cloneLevel(level));
    testEngine.debugTriggers = true; // start in debug view: easiest to build with
    testEngine.start();
  } else {
    btn.textContent = '▶ Tester le niveau';
    if (testEngine) { testEngine.destroy(); testEngine = null; }
    resizeCanvas();
    render();
  }
  updateDebugViewBtn();
}

init();
