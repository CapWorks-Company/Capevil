import {
  CELL, ENTITY_TYPES, ENTITY_STATES, ACTION_TYPES, TRIGGER_MODES, GRAVITY_DIRS,
} from './constants.js';
import {
  createEmptyLevel, createEntity, createAction, cloneLevel, findEntity,
  removeEntity, validateLevel, uid, normalizeLevel,
} from './level-model.js';
import { buildSampleLevel } from './sample-level.js';
import { Engine } from './engine.js';
import { saveLocalDraft, loadLocalDraft } from './local-storage.js';
import { publishLevel, isBackendReady } from './supabase-client.js';

// ---------------------------------------------------------------- palette
const PALETTE = [
  { type: ENTITY_TYPES.BLOCK, label: 'Bloc solide', color: '#111319' },
  { type: ENTITY_TYPES.SPIKE, label: 'Pointes', color: '#e63946' },
  { type: ENTITY_TYPES.SPRING, label: 'Ressort', color: '#ffd166' },
  { type: ENTITY_TYPES.SPINNER, label: 'Roue tournante', color: '#c9184a' },
  { type: ENTITY_TYPES.PLATFORM, label: 'Plateforme mobile', color: '#2d6cdf' },
  { type: ENTITY_TYPES.CHECKPOINT, label: 'Checkpoint', color: '#118ab2' },
  { type: ENTITY_TYPES.GOAL, label: 'Arrivée (but)', color: '#2ec4b6' },
  { type: ENTITY_TYPES.TRIGGER, label: 'Zone de trigger', color: '#f4d35e' },
  { type: ENTITY_TYPES.DECOR, label: 'Décor', color: '#4a4e69' },
];

const STATE_LABELS = {
  [ENTITY_STATES.NORMAL]: 'Normal',
  [ENTITY_STATES.PASSABLE]: 'Traversable',
  [ENTITY_STATES.INVISIBLE]: 'Invisible',
  [ENTITY_STATES.HARMLESS]: 'Inoffensif',
};
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
let pickingTargetFor = null; // { actionId } while armed to pick a target on canvas
let playtesting = false;
let testEngine = null;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const toolboxEl = document.getElementById('toolbox');
const propsEl = document.getElementById('props');
const titleInput = document.getElementById('level-title-input');
const authorInput = document.getElementById('level-author-input');
const colsInput = document.getElementById('cols-input');
const rowsInput = document.getElementById('rows-input');
const statusEl = document.getElementById('status-msg');
const pickBanner = document.getElementById('pick-banner');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff8a8a' : 'var(--muted)';
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}

// ---------------------------------------------------------------- init
function init() {
  const params = new URLSearchParams(location.search);
  const localKey = params.get('local');
  if (localKey) {
    const draft = loadLocalDraft(localKey);
    level = draft ? { ...normalizeLevel(draft), localKey } : buildSampleLevel();
  } else {
    level = buildSampleLevel();
    level.localKey = null;
  }
  syncHeaderInputs();
  buildPalette();
  resizeCanvas();
  render();
  renderProps();
  bindToolbar();
  bindCanvas();
}

function syncHeaderInputs() {
  titleInput.value = level.title || '';
  authorInput.value = level.author || '';
  colsInput.value = level.cols;
  rowsInput.value = level.rows;
}

function resizeCanvas() {
  canvas.width = level.cols * CELL;
  canvas.height = level.rows * CELL;
}

// ---------------------------------------------------------------- palette UI
function buildPalette() {
  toolboxEl.innerHTML = '<h3 style="margin-top:0;">Outils</h3>';
  const selectBtn = paletteButton('select', 'Sélection / déplacer', '#888');
  const eraseBtn = paletteButton('erase', 'Gomme', '#555');
  const startBtn = paletteButton('playerstart', 'Départ joueur', '#f77f00');
  toolboxEl.append(selectBtn, startBtn, eraseBtn);
  const hr = document.createElement('hr');
  hr.style.borderColor = 'var(--border)';
  toolboxEl.appendChild(hr);
  for (const p of PALETTE) toolboxEl.appendChild(paletteButton(p.type, p.label, p.color));
}

function paletteButton(toolId, label, color) {
  const btn = document.createElement('button');
  btn.className = 'palette-btn' + (tool === toolId ? ' active' : '');
  btn.dataset.tool = toolId;
  btn.innerHTML = `<span class="palette-swatch" style="background:${color}"></span>${label}`;
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

function drawEntity(ent) {
  const x = ent.x * CELL, y = ent.y * CELL, w = ent.w * CELL, h = ent.h * CELL;
  ctx.save();
  if (ent.state !== ENTITY_STATES.NORMAL) ctx.globalAlpha = 0.55;
  switch (ent.type) {
    case ENTITY_TYPES.BLOCK: ctx.fillStyle = '#111319'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#3a3f52'; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); break;
    case ENTITY_TYPES.PLATFORM: ctx.fillStyle = '#2d6cdf'; ctx.fillRect(x, y, w, h); break;
    case ENTITY_TYPES.SPIKE:
      ctx.fillStyle = '#e63946';
      for (let i = 0; i < ent.w; i++) {
        ctx.beginPath(); ctx.moveTo(x + i * CELL, y + h); ctx.lineTo(x + i * CELL + CELL / 2, y); ctx.lineTo(x + i * CELL + CELL, y + h); ctx.closePath(); ctx.fill();
      }
      break;
    case ENTITY_TYPES.SPRING:
      ctx.fillStyle = '#ffd166'; ctx.fillRect(x + 4, y + h * 0.4, w - 8, h * 0.6);
      ctx.fillStyle = '#8a6d1a'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText({ up: '↑', down: '↓', left: '←', right: '→' }[ent.props.direction || 'up'], x + w / 2, y + h * 0.35);
      break;
    case ENTITY_TYPES.SPINNER:
      ctx.fillStyle = '#c9184a'; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, CELL * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
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
    level.playerStart = { x: cx, y: cy };
    render();
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
      // second click: move the selected entity here
      const ent = findEntity(level, selectedId);
      const clicked = entityAt(cx, cy);
      if (clicked && clicked.id !== selectedId) {
        selectedId = clicked.id; // switch selection instead
      } else if (ent) {
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
  const ent = createEntity(tool, cx, cy);
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

  if (ent.type !== ENTITY_TYPES.TRIGGER && ent.type !== ENTITY_TYPES.DECOR) {
    html.push('<label>État</label>');
    html.push(selectHtml('p-state', STATE_LABELS, ent.state));
  }

  if (ent.type === ENTITY_TYPES.SPRING) {
    html.push('<label>Direction</label>');
    html.push(selectHtml('p-dir', GRAVITY_LABELS, ent.props.direction || 'up'));
    html.push('<label>Puissance (x saut normal)</label>');
    html.push(`<input type="number" id="p-power" value="${ent.props.power ?? 1.6}" step="0.1" min="0.2" max="5" />`);
  }
  if (ent.type === ENTITY_TYPES.SPINNER) {
    html.push('<label>Vitesse de rotation</label>');
    html.push(`<input type="number" id="p-speed" value="${ent.props.speed ?? 2}" step="0.1" min="0.1" max="10" />`);
  }

  html.push('<button class="btn danger small" id="delete-ent" style="margin-top:14px;width:100%;">Supprimer cet élément</button>');
  html.push('</div>');

  if (ent.type === ENTITY_TYPES.TRIGGER) {
    html.push(renderTriggerEditor(ent));
  }

  propsEl.innerHTML = html.join('');
  bindPropsInputs(ent);
}

function paletteLabel(type) {
  const found = PALETTE.find(p => p.type === type);
  return found ? found.label : type;
}
function selectHtml(id, labelsMap, current) {
  return `<select id="${id}">${Object.entries(labelsMap).map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function bindPropsInputs(ent) {
  const num = (id, cb) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => cb(parseFloat(el.value))); };
  num('p-x', (v) => { ent.x = clampInt(v, 0, level.cols - 1); render(); });
  num('p-y', (v) => { ent.y = clampInt(v, 0, level.rows - 1); render(); });
  num('p-w', (v) => { ent.w = Math.max(1, Math.round(v)); render(); });
  num('p-h', (v) => { ent.h = Math.max(1, Math.round(v)); render(); });
  const stateSel = document.getElementById('p-state');
  if (stateSel) stateSel.addEventListener('change', () => { ent.state = stateSel.value; render(); });
  const dirSel = document.getElementById('p-dir');
  if (dirSel) dirSel.addEventListener('change', () => { ent.props.direction = dirSel.value; render(); });
  num('p-power', (v) => { ent.props.power = v; });
  num('p-speed', (v) => { ent.props.speed = v; });
  const delBtn = document.getElementById('delete-ent');
  if (delBtn) delBtn.addEventListener('click', () => { removeEntity(level, ent.id); selectedId = null; render(); renderProps(); });

  // trigger-specific bindings
  const modeSel = document.getElementById('t-mode');
  if (modeSel) modeSel.addEventListener('change', () => { ent.props.mode = modeSel.value; });
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
  html.push('<hr style="border-color:var(--border);margin:16px 0;">');
  html.push('<h4 style="margin:0 0 6px;">Trigger</h4>');
  html.push('<label>Mode de déclenchement</label>');
  html.push(selectHtml('t-mode', {
    [TRIGGER_MODES.ONCE]: 'Une seule fois (entrée)',
    [TRIGGER_MODES.REPEAT]: 'À chaque entrée',
    [TRIGGER_MODES.ON_EXIT]: 'À la sortie de la zone',
  }, ent.props.mode));
  html.push('<label style="margin-top:14px;">Actions déclenchées</label>');
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
      fields = `<label>Nouvel état</label>${selectHtml('', STATE_LABELS, p.state || ENTITY_STATES.NORMAL).replace('id=""', 'data-f="state"')}`;
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
      if (field === 'type') { action.type = val; action.params = {}; action.targetId = null; renderProps(); return; }
      if (field === 'delay') { action.delay = val; return; }
      action.params[field] = val;
    };
    el.addEventListener('change', handler);
  });
  const removeBtn = row.querySelector('[data-remove-action]');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    ent.props.actions = ent.props.actions.filter((a) => a.id !== action.id);
    renderProps();
  });
  const pickBtn = row.querySelector('[data-pick-target]');
  if (pickBtn) pickBtn.addEventListener('click', () => {
    pickingTargetFor = { onPick: (id) => { action.targetId = id; renderProps(); } };
    pickBanner.classList.remove('hidden');
  });
  const pickPlayerBtn = row.querySelector('[data-pick-player]');
  if (pickPlayerBtn) pickPlayerBtn.addEventListener('click', () => { action.targetId = 'player'; renderProps(); });
}

// ---------------------------------------------------------------- toolbar
function bindToolbar() {
  titleInput.addEventListener('change', () => { level.title = titleInput.value; });
  authorInput.addEventListener('change', () => { level.author = authorInput.value; });
  colsInput.addEventListener('change', () => { level.cols = Math.max(8, parseInt(colsInput.value) || 20); resizeCanvas(); render(); });
  rowsInput.addEventListener('change', () => { level.rows = Math.max(6, parseInt(rowsInput.value) || 12); resizeCanvas(); render(); });

  document.getElementById('new-level').addEventListener('click', () => {
    if (!confirm('Créer un nouveau niveau vide ? Le travail non sauvegardé sera perdu.')) return;
    level = createEmptyLevel('Nouveau niveau');
    level.localKey = null;
    syncHeaderInputs(); resizeCanvas(); selectedId = null; render(); renderProps();
  });

  document.getElementById('save-local').addEventListener('click', () => {
    const key = saveLocalDraft(level);
    history.replaceState(null, '', `editor.html?local=${key}`);
    setStatus('Brouillon enregistré dans ce navigateur ✓');
  });

  document.getElementById('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(level, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(level.title || 'niveau').replace(/\s+/g, '_')}.json`;
    a.click();
  });

  document.getElementById('import-json').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        level = normalizeLevel(JSON.parse(reader.result));
        level.localKey = null;
        syncHeaderInputs(); resizeCanvas(); selectedId = null; render(); renderProps();
        setStatus('Niveau importé ✓');
      } catch { setStatus('Fichier JSON invalide.', true); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('publish-btn').addEventListener('click', async () => {
    const errors = validateLevel(level);
    if (errors.length) { setStatus(errors.join(' '), true); return; }
    const ready = await isBackendReady();
    if (!ready) { setStatus('Supabase non configuré : impossible de publier pour le moment.', true); return; }
    try {
      setStatus('Publication…');
      const res = await publishLevel(level);
      setStatus(`Publié ✓ (id ${res.id.slice(0, 8)}…)`);
    } catch (err) {
      setStatus('Erreur lors de la publication : ' + (err.message || err), true);
    }
  });

  document.getElementById('playtest-btn').addEventListener('click', togglePlaytest);
  document.getElementById('cancel-pick').addEventListener('click', () => {
    pickingTargetFor = null;
    pickBanner.classList.add('hidden');
  });
}

function togglePlaytest() {
  playtesting = !playtesting;
  const btn = document.getElementById('playtest-btn');
  if (playtesting) {
    btn.textContent = '⏹ Arrêter le test';
    canvas.width = Math.min(900, level.cols * CELL);
    canvas.height = Math.min(520, level.rows * CELL);
    testEngine = new Engine(canvas, cloneLevel(level));
    testEngine.debugTriggers = true;
    testEngine.start();
  } else {
    btn.textContent = '▶ Tester le niveau';
    if (testEngine) { testEngine.destroy(); testEngine = null; }
    resizeCanvas();
    render();
  }
}

init();
