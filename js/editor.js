import {
  CELL, ENTITY_TYPES, ACTION_TYPES, TRIGGER_MODES, GRAVITY_DIRS,
  ENTITY_TOGGLES, TOGGLE_LABELS, togglesForType, SPIKE_FACINGS, FACING_LABELS,
  TELEPORTER_MAX_PER_FREQUENCY, TELEPORTER_FREQUENCIES,
} from './constants.js';
import {
  createEmptyLevel, createEntity, createAction, cloneLevel, findEntity,
  removeEntity, validateLevel, uid, normalizeLevel, nextTeleporterFrequency,
  normalizeEditBounds,
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
  { type: ENTITY_TYPES.DECOR, label: 'Décor', color: '#4a4e69', icon: '🌿' },
];

const ACTION_LABELS = {
  [ACTION_TYPES.MOVE_ELEMENT]: 'Déplacer un élément',
  [ACTION_TYPES.SET_STATE]: "Changer l'état d'un élément",
  [ACTION_TYPES.SET_GRAVITY]: 'Changer la gravité du joueur',
  [ACTION_TYPES.INVERT_CONTROLS]: 'Inverser les touches (troll)',
  [ACTION_TYPES.SET_JUMP_POWER]: 'Changer la puissance de saut',
  [ACTION_TYPES.SET_SPEED]: 'Changer la vitesse du joueur',
  [ACTION_TYPES.TELEPORT]: 'Téléporter un élément',
};
const GRAVITY_LABELS = { down: 'Bas (normal)', up: 'Haut', left: 'Gauche', right: 'Droite' };

// ---------------------------------------------------------------- state
let level = null;
let tool = 'select';
let selectedId = null;
let pickingTargetFor = null; // { onPick } while armed to pick a target on canvas
let playtesting = false;
let testEngine = null;
let session = null;       // current Supabase Auth session, kept in sync via onAuthChange
let editingRemoteId = null; // set when this editor session is editing an already-published level

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const toolboxEl = document.getElementById('toolbox');
const propsEl = document.getElementById('props');
const titleInput = document.getElementById('level-title-input');
const authorInput = document.getElementById('level-author-input');
const colsInput = document.getElementById('cols-input');
const rowsInput = document.getElementById('rows-input');
const ebColMin = document.getElementById('eb-colmin');
const ebColMax = document.getElementById('eb-colmax');
const ebRowMin = document.getElementById('eb-rowmin');
const ebRowMax = document.getElementById('eb-rowmax');
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
  if (editId) {
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
  syncEditBoundsInputs();
  updatePublishButtonState();
}

function resizeCanvas() {
  canvas.width = level.cols * CELL;
  canvas.height = level.rows * CELL;
}

// ---------------------------------------------------------- editable zone
// The 4 fields always define exactly which cells can be edited (placed,
// moved, erased, player-start) — no separate on/off toggle. By default
// they span the whole grid, i.e. nothing is restricted; narrowing them
// protects a decorative border from being edited. Purely an editor-time
// convenience — never read by the engine.
function syncEditBoundsInputs() {
  const eb = level.editBounds;
  ebColMin.value = eb.colMin;
  ebColMax.value = eb.colMax;
  ebRowMin.value = eb.rowMin;
  ebRowMax.value = eb.rowMax;
  updateLevelSettingsLabel();
}

// Small glanceable summary on the "⚙ Niveau" toolbar button, so the grid
// size and editable zone are visible without opening the settings panel —
// showing the zone only once it's actually narrower than the full grid,
// since "the whole grid" isn't information worth a badge.
function updateLevelSettingsLabel() {
  const label = document.getElementById('level-settings-label');
  if (!label) return;
  const eb = level.editBounds;
  const restricted = eb.colMin > 0 || eb.rowMin > 0 || eb.colMax < level.cols - 1 || eb.rowMax < level.rows - 1;
  label.textContent = `(${level.cols}×${level.rows}${restricted ? ' 🔒' : ''})`;
}

function applyEditBoundsFromInputs() {
  const wantColMax = parseInt(ebColMax.value, 10);
  const wantRowMax = parseInt(ebRowMax.value, 10);
  // The zone can only ever be as big as the grid — rather than silently
  // cutting the requested max down to fit (confusing: "why won't it take
  // 30?"), grow the grid itself so the requested zone always fits.
  if (Number.isFinite(wantColMax) && wantColMax >= level.cols) {
    level.cols = wantColMax + 1;
    colsInput.value = level.cols;
  }
  if (Number.isFinite(wantRowMax) && wantRowMax >= level.rows) {
    level.rows = wantRowMax + 1;
    rowsInput.value = level.rows;
  }
  resizeCanvas();
  level.editBounds = normalizeEditBounds({
    colMin: parseInt(ebColMin.value, 10),
    colMax: wantColMax,
    rowMin: parseInt(ebRowMin.value, 10),
    rowMax: wantRowMax,
  }, level.cols, level.rows);
  syncEditBoundsInputs();
  render();
}

function inEditBounds(cx, cy) {
  const eb = level.editBounds;
  return cx >= eb.colMin && cx <= eb.colMax && cy >= eb.rowMin && cy <= eb.rowMax;
}

function editBoundsMsg() {
  const eb = level.editBounds;
  return `Hors zone éditable : tu ne peux modifier que les colonnes ${eb.colMin}-${eb.colMax}, lignes ${eb.rowMin}-${eb.rowMax}.`;
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
  ctx.fillStyle = '#1b1e2b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let c = 0; c <= level.cols; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, canvas.height); ctx.stroke(); }
  for (let r = 0; r <= level.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(canvas.width, r * CELL); ctx.stroke(); }

  for (const ent of level.entities) drawEntity(ent);
  drawTriggerLinks();
  drawEditBoundsOverlay();

  // player start marker
  const ps = level.playerStart;
  ctx.fillStyle = 'rgba(247,127,0,0.85)';
  ctx.fillRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);
  ctx.strokeStyle = '#fff'; ctx.strokeRect(ps.x * CELL + 6, ps.y * CELL + 6, CELL - 12, CELL - 12);

  if (selectedId) {
    const ent = findEntity(level, selectedId);
    if (ent) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(ent.x * CELL - 2, ent.y * CELL - 2, ent.w * CELL + 4, ent.h * CELL + 4);
    }
  }
}

// Draws a dashed "string" from each trigger to every entity its actions
// target, so the connection between cause and effect is visible at a glance
// while editing. A special marker is drawn when a trigger targets the player.
function drawTriggerLinks() {
  const triggers = level.entities.filter(e => (e.type === ENTITY_TYPES.TRIGGER || e.type === ENTITY_TYPES.BUTTON) && e.props && e.props.actions && e.props.actions.length);
  if (!triggers.length) return;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  for (const trig of triggers) {
    const actions = (trig.props && trig.props.actions) || [];
    if (!actions.length) continue;
    const highlighted = trig.id === selectedId;
    const fromX = trig.x * CELL + (trig.w * CELL) / 2;
    const fromY = trig.y * CELL + (trig.h * CELL) / 2;
    ctx.strokeStyle = highlighted ? 'rgba(255,255,255,0.85)' : 'rgba(244,211,94,0.55)';
    ctx.fillStyle = ctx.strokeStyle;
    const seen = new Set();
    for (const action of actions) {
      if (!action.targetId || seen.has(action.targetId)) continue;
      seen.add(action.targetId);
      if (action.targetId === 'player') {
        const ps = level.playerStart;
        const tx = ps.x * CELL + CELL / 2, ty = ps.y * CELL + CELL / 2;
        drawLink(fromX, fromY, tx, ty);
        continue;
      }
      const target = findEntity(level, action.targetId);
      if (!target) continue;
      const tx = target.x * CELL + (target.w * CELL) / 2;
      const ty = target.y * CELL + (target.h * CELL) / 2;
      drawLink(fromX, fromY, tx, ty);
    }
  }
  ctx.restore();
}

// Dims everything outside the locked editable zone (if one is set) and draws
// a border around it, so it's obvious at a glance what can and can't be
// touched right now.
function drawEditBoundsOverlay() {
  const eb = level.editBounds;
  const isFullGrid = eb.colMin === 0 && eb.colMax === level.cols - 1 && eb.rowMin === 0 && eb.rowMax === level.rows - 1;
  if (isFullGrid) return;
  const left = eb.colMin * CELL, top = eb.rowMin * CELL;
  const right = (eb.colMax + 1) * CELL, bottom = (eb.rowMax + 1) * CELL;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  if (left > 0) ctx.fillRect(0, 0, left, canvas.height);
  if (right < canvas.width) ctx.fillRect(right, 0, canvas.width - right, canvas.height);
  if (top > 0) ctx.fillRect(left, 0, right - left, top);
  if (bottom < canvas.height) ctx.fillRect(left, bottom, right - left, canvas.height - bottom);
  ctx.strokeStyle = '#f4d35e';
  ctx.lineWidth = 2;
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.restore();
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
    case ENTITY_TYPES.PLATFORM: ctx.fillStyle = '#2d6cdf'; ctx.fillRect(x, y, w, h); break;
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
    case ENTITY_TYPES.CHECKPOINT:
      ctx.fillStyle = '#118ab2'; ctx.fillRect(x + w * 0.4, y, w * 0.1, h);
      ctx.beginPath(); ctx.moveTo(x + w * 0.5, y + h * 0.1); ctx.lineTo(x + w * 0.9, y + h * 0.3); ctx.lineTo(x + w * 0.5, y + h * 0.5); ctx.fill();
      break;
    case ENTITY_TYPES.GOAL:
      ctx.fillStyle = '#2ec4b6'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('⚑', x + w / 2, y + h / 2 + 5);
      break;
    case ENTITY_TYPES.TRIGGER:
      ctx.fillStyle = 'rgba(244,211,94,0.25)'; ctx.strokeStyle = '#f4d35e';
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#f4d35e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('T', x + w / 2, y + h / 2 + 3);
      break;
    case ENTITY_TYPES.BUTTON:
      ctx.fillStyle = '#2b2d3d'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#5b5f7a'; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.fillStyle = '#06d6a0'; ctx.fillRect(x + w * 0.18, y + h * 0.56, w * 0.64, h * 0.32);
      break;
    case ENTITY_TYPES.DECOR: ctx.fillStyle = '#4a4e69'; ctx.fillRect(x, y, w, h); break;
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
  if (pickingTargetFor) {
    const ent = entityAt(cx, cy);
    pickingTargetFor.onPick(ent ? ent.id : null);
    pickingTargetFor = null;
    pickBanner.classList.add('hidden');
    render(); renderProps();
    return;
  }
  if (tool === 'playerstart') {
    if (!inEditBounds(cx, cy)) { setStatus(editBoundsMsg(), true); return; }
    level.playerStart = { x: cx, y: cy };
    render();
    return;
  }
  if (tool === 'erase') {
    const ent = entityAt(cx, cy);
    if (ent) {
      if (!inEditBounds(ent.x, ent.y)) { setStatus(editBoundsMsg(), true); return; }
      removeEntity(level, ent.id); if (selectedId === ent.id) selectedId = null;
    }
    render(); renderProps();
    return;
  }
  if (tool === 'select') {
    if (selectedId) {
      // second click: move the selected entity here
      const ent = findEntity(level, selectedId);
      const clicked = entityAt(cx, cy);
      if (clicked && clicked.id !== selectedId) {
        selectedId = clicked.id; // switch selection instead
      } else if (ent) {
        if (!inEditBounds(cx, cy)) { setStatus(editBoundsMsg(), true); return; }
        ent.x = cx; ent.y = cy;
      }
    } else {
      const ent = entityAt(cx, cy);
      selectedId = ent ? ent.id : null;
    }
    render(); renderProps();
    return;
  }
  // placing a new entity of type == tool
  if (!inEditBounds(cx, cy)) { setStatus(editBoundsMsg(), true); return; }
  const ent = createEntity(tool, cx, cy, {}, level);
  level.entities.push(ent);
  selectedId = ent.id;
  tool = 'select';
  buildPalette();
  render(); renderProps();
}

// ---------------------------------------------------------------- properties panel
function renderProps() {
  if (!selectedId) {
    propsEl.innerHTML = '<h3 style="margin-top:0;">Propriétés</h3><p class="muted">Sélectionne un élément sur la grille (outil « Sélection ») pour l\'éditer.</p>';
    return;
  }
  const ent = findEntity(level, selectedId);
  if (!ent) { selectedId = null; return renderProps(); }

  const html = [];
  html.push('<h3 style="margin-top:0;">Propriétés</h3>');
  html.push(`<div class="pill">${paletteLabel(ent.type)}</div>`);
  html.push('<div class="props-panel">');
  html.push(`<label>Position (colonne / ligne)</label>
    <div class="row">
      <input type="number" id="p-x" value="${ent.x}" min="0" max="${level.cols - 1}" />
      <input type="number" id="p-y" value="${ent.y}" min="0" max="${level.rows - 1}" />
    </div>`);
  html.push(`<label>Taille (largeur / hauteur en cases)</label>
    <div class="row">
      <input type="number" id="p-w" value="${ent.w}" min="1" max="${level.cols}" />
      <input type="number" id="p-h" value="${ent.h}" min="1" max="${level.rows}" />
    </div>`);

  const toggles = togglesForType(ent.type);
  if (toggles.length) {
    html.push('<label>État</label>');
    html.push('<div class="toggle-list">');
    for (const t of toggles) {
      html.push(`<label class="toggle-row"><input type="checkbox" data-toggle="${t}" ${ent[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`);
    }
    html.push('</div>');
  }

  if (ent.type === ENTITY_TYPES.SPIKE) {
    html.push('<label>Orientation</label>');
    html.push(selectHtml('p-facing', FACING_LABELS, ent.props.facing || 'up'));
  }
  if (ent.type === ENTITY_TYPES.SPRING) {
    html.push('<label>Direction (haut / bas uniquement)</label>');
    html.push(selectHtml('p-dir', { up: GRAVITY_LABELS.up, down: GRAVITY_LABELS.down }, ent.props.direction || 'up'));
    html.push('<label>Puissance (x saut normal)</label>');
    html.push(`<input type="number" id="p-power" value="${ent.props.power ?? 1.6}" step="0.1" min="0.2" max="5" />`);
  }
  if (ent.type === ENTITY_TYPES.FAN) {
    html.push('<label>Direction du vent</label>');
    html.push(selectHtml('p-fandir', GRAVITY_LABELS, ent.props.direction || 'right'));
    html.push('<label>Force du vent</label>');
    html.push(`<input type="number" id="p-force" value="${ent.props.force ?? 1}" step="0.1" min="0.1" max="4" />`);
  }
  if (ent.type === ENTITY_TYPES.SPINNER) {
    html.push('<label>Vitesse de rotation</label>');
    html.push(`<input type="number" id="p-speed" value="${ent.props.speed ?? 2}" step="0.1" min="0.1" max="10" />`);
  }
  if (ent.type === ENTITY_TYPES.BUTTON) {
    html.push('<label>Durée de réinitialisation (s)</label>');
    html.push(`<input type="number" id="p-cooldown" value="${ent.props.cooldown ?? 1}" step="0.1" min="0.05" />`);
    html.push('<p class="muted" style="font-size:12px;margin:4px 0 0;">Contrairement à un trigger (invisible, une seule fois), le bouton est visible et peut être pressé encore et encore, une fois ce délai écoulé.</p>');
  }
  if (ent.type === ENTITY_TYPES.TELEPORTER) {
    html.push('<label>Fréquence (relie les téléporteurs, max 3 par fréquence)</label>');
    const freqLabels = {};
    for (const f of TELEPORTER_FREQUENCIES) freqLabels[f] = `Fréquence ${f} (${teleporterGroupCount(f, ent.id)}/${TELEPORTER_MAX_PER_FREQUENCY})`;
    html.push(selectHtml('p-freq', freqLabels, ent.props.frequency || 1));
    html.push(`<label style="margin-top:10px;"><input type="checkbox" id="p-oneuse" ${ent.props.oneUse ? 'checked' : ''} style="width:auto;margin-right:6px;" />Sens unique (utilisable une seule fois)</label>`);
  }

  html.push('<button class="btn danger small" id="delete-ent" style="margin-top:14px;width:100%;">Supprimer cet élément</button>');
  html.push('</div>');

  if (ent.type === ENTITY_TYPES.TRIGGER) {
    html.push(renderTriggerEditor(ent));
  }
  if (ent.type === ENTITY_TYPES.BUTTON) {
    html.push(renderButtonEditor(ent));
  }

  propsEl.innerHTML = html.join('');
  bindPropsInputs(ent);
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
  num('p-x', (v) => {
    const nx = clampInt(v, 0, level.cols - 1);
    if (!inEditBounds(nx, ent.y)) { setStatus(editBoundsMsg(), true); renderProps(); return; }
    ent.x = nx; render();
  });
  num('p-y', (v) => {
    const ny = clampInt(v, 0, level.rows - 1);
    if (!inEditBounds(ent.x, ny)) { setStatus(editBoundsMsg(), true); renderProps(); return; }
    ent.y = ny; render();
  });
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
  num('p-speed', (v) => { ent.props.speed = v; });
  num('p-cooldown', (v) => { ent.props.cooldown = Math.max(0.05, v); });

  const freqSel = document.getElementById('p-freq');
  if (freqSel) freqSel.addEventListener('change', () => {
    const newFreq = parseInt(freqSel.value, 10);
    if (teleporterGroupCount(newFreq, ent.id) >= TELEPORTER_MAX_PER_FREQUENCY) {
      setStatus(`Impossible : la fréquence ${newFreq} a déjà ${TELEPORTER_MAX_PER_FREQUENCY} téléporteurs.`, true);
      freqSel.value = ent.props.frequency || 1;
      return;
    }
    ent.props.frequency = newFreq;
    render(); renderProps();
  });
  const oneUseChk = document.getElementById('p-oneuse');
  if (oneUseChk) oneUseChk.addEventListener('change', () => { ent.props.oneUse = oneUseChk.checked; render(); });

  const delBtn = document.getElementById('delete-ent');
  if (delBtn) delBtn.addEventListener('click', () => { removeEntity(level, ent.id); selectedId = null; render(); renderProps(); });

  // trigger-specific bindings
  const modeSel = document.getElementById('t-mode');
  if (modeSel) modeSel.addEventListener('change', () => { ent.props.mode = modeSel.value; renderProps(); });
  const loopInput = document.getElementById('t-loop-interval');
  if (loopInput) loopInput.addEventListener('change', () => { ent.props.loopInterval = parseFloat(loopInput.value) || 2; });
  const addActionBtn = document.getElementById('add-action');
  if (addActionBtn) addActionBtn.addEventListener('click', () => {
    ent.props.actions.push(createAction(ACTION_TYPES.MOVE_ELEMENT, { params: { dx: 1, dy: 0, duration: 0.5 } }));
    renderProps();
  });
  ent.props.actions && ent.props.actions.forEach((action) => bindActionRow(ent, action));
}

function clampInt(v, min, max) { return Math.max(min, Math.min(max, Math.round(v))); }

// ------------------------------------------------------- trigger/action UI
function renderTriggerEditor(ent) {
  const html = [];
  html.push('<hr class="props-sep">');
  html.push('<h4 style="margin:0 0 6px;">Trigger</h4>');
  html.push('<label>Mode de déclenchement</label>');
  html.push(selectHtml('t-mode', {
    [TRIGGER_MODES.ONCE]: 'Une seule fois (entrée)',
    [TRIGGER_MODES.REPEAT]: 'À chaque entrée',
    [TRIGGER_MODES.ON_EXIT]: 'À la sortie de la zone',
    [TRIGGER_MODES.LOOP]: 'Boucle (se répète tout seul)',
  }, ent.props.mode));
  if (ent.props.mode === TRIGGER_MODES.LOOP) {
    html.push('<label>Durée totale du cycle avant de recommencer (s)</label>');
    html.push(`<input type="number" id="t-loop-interval" value="${ent.props.loopInterval ?? 2}" step="0.1" min="0.2" />`);
    html.push('<p class="muted" style="font-size:12px;margin:4px 0 0;">La liste d\'actions se déclenche une première fois en entrant dans la zone, puis se répète toute seule (utilise le délai de chaque action pour rythmer la séquence : ex. déplacer, attendre via le délai de l\'action suivante, revenir…).</p>');
  }
  html.push('<label style="margin-top:14px;">Actions déclenchées</label>');
  html.push('<div id="actions-list">' + (ent.props.actions || []).map((a) => renderActionRow(ent, a)).join('') + '</div>');
  html.push('<button class="btn small" id="add-action" style="width:100%;margin-top:6px;">+ Ajouter une action</button>');
  return html.join('');
}

function renderButtonEditor(ent) {
  const html = [];
  html.push('<hr class="props-sep">');
  html.push('<h4 style="margin:0 0 6px;">Bouton</h4>');
  html.push('<label>Actions déclenchées à chaque pression</label>');
  html.push('<div id="actions-list">' + (ent.props.actions || []).map((a) => renderActionRow(ent, a)).join('') + '</div>');
  html.push('<button class="btn small" id="add-action" style="width:100%;margin-top:6px;">+ Ajouter une action</button>');
  return html.join('');
}

function renderActionRow(ent, action) {
  const target = action.targetId === 'player' ? 'Joueur' : (action.targetId ? shortId(action.targetId) : '— aucune —');
  const p = action.params || {};
  let fields = '';
  switch (action.type) {
    case ACTION_TYPES.MOVE_ELEMENT:
      fields = `
        <div class="row">
          <div><label>dx (cases)</label><input type="number" data-f="dx" value="${p.dx ?? 0}" /></div>
          <div><label>dy (cases)</label><input type="number" data-f="dy" value="${p.dy ?? 0}" /></div>
        </div>
        <label>Durée (s)</label><input type="number" step="0.1" data-f="duration" value="${p.duration ?? 0.5}" />`;
      break;
    case ACTION_TYPES.TELEPORT:
      fields = `<div class="row">
          <div><label>x (case)</label><input type="number" data-f="x" value="${p.x ?? 0}" /></div>
          <div><label>y (case)</label><input type="number" data-f="y" value="${p.y ?? 0}" /></div>
        </div>`;
      break;
    case ACTION_TYPES.SET_STATE:
      fields = `<label>Nouvel état de la cible</label><div class="toggle-list">
        ${ENTITY_TOGGLES.map(t => `<label class="toggle-row"><input type="checkbox" data-f="${t}" data-bool="1" ${p[t] ? 'checked' : ''} />${TOGGLE_LABELS[t]}</label>`).join('')}
      </div>`;
      break;
    case ACTION_TYPES.SET_GRAVITY:
      fields = `<label>Nouvelle direction</label>${selectHtml('', GRAVITY_LABELS, p.direction || 'down').replace('id=""', 'data-f="direction"')}`;
      break;
    case ACTION_TYPES.INVERT_CONTROLS:
      fields = `<label>Axe inversé</label>${selectHtml('', { horizontal: 'Gauche / Droite', vertical: 'Haut / Bas', both: 'Les deux' }, p.axis || 'horizontal').replace('id=""', 'data-f="axis"')}
        <label style="margin-top:8px;"><input type="checkbox" data-f="enabled" ${p.enabled !== false ? 'checked' : ''} style="width:auto;margin-right:6px;" />Activer (décoche pour désactiver)</label>
        <label>Durée avant retour à la normale (s, 0 = permanent)</label><input type="number" step="0.5" data-f="duration" value="${p.duration ?? 0}" />`;
      break;
    case ACTION_TYPES.SET_JUMP_POWER:
    case ACTION_TYPES.SET_SPEED:
      fields = `<label>Valeur (x normal, 1 = inchangé)</label><input type="number" step="0.1" data-f="value" value="${p.value ?? 1}" />
        <label>Durée avant retour à la normale (s, 0 = permanent)</label><input type="number" step="0.5" data-f="duration" value="${p.duration ?? 0}" />`;
      break;
  }
  const needsTarget = action.type !== ACTION_TYPES.SET_GRAVITY && action.type !== ACTION_TYPES.INVERT_CONTROLS && action.type !== ACTION_TYPES.SET_JUMP_POWER && action.type !== ACTION_TYPES.SET_SPEED;
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
        <button class="btn small" data-pick-player="${action.id}">= Joueur</button>
      </div>` : `<input type="hidden" data-f="__player_target" />`}
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
        action.params = val === ACTION_TYPES.SET_STATE ? { passable: false, invisible: false, harmless: false } : {};
        renderProps(); render();
        return;
      }
      if (field === 'delay') { action.delay = val; return; }
      action.params[field] = val;
      render();
    };
    el.addEventListener('change', handler);
  });
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
    // If the editable zone's right edge was tracking the grid's own edge
    // (the common/default case: no border reserved), keep tracking it as
    // the grid is resized — resizing shouldn't silently introduce a lock.
    const wasFullWidth = level.editBounds.colMax >= level.cols - 1;
    level.cols = Math.max(8, parseInt(colsInput.value) || 20);
    if (wasFullWidth) level.editBounds.colMax = level.cols - 1;
    level.editBounds = normalizeEditBounds(level.editBounds, level.cols, level.rows);
    syncEditBoundsInputs(); resizeCanvas(); render();
  });
  rowsInput.addEventListener('change', () => {
    const wasFullHeight = level.editBounds.rowMax >= level.rows - 1;
    level.rows = Math.max(6, parseInt(rowsInput.value) || 12);
    if (wasFullHeight) level.editBounds.rowMax = level.rows - 1;
    level.editBounds = normalizeEditBounds(level.editBounds, level.cols, level.rows);
    syncEditBoundsInputs(); resizeCanvas(); render();
  });

  for (const el of [ebColMin, ebColMax, ebRowMin, ebRowMax]) el.addEventListener('change', applyEditBoundsFromInputs);

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

// The grid-size + editable-zone fields live inside a small modal (kept out
// of the main toolbar so it doesn't compete for space with the far more
// frequently used buttons); the inputs themselves are the exact same
// long-lived elements referenced everywhere above (colsInput, ebColMin…) —
// this just shows/hides the panel around them.
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
