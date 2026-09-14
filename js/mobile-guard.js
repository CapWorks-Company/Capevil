// Blocks phone/tablet visitors behind a full-screen "use a computer" panel.
// Capevil is keyboard-first (arrows/WASD + space to play, mouse+keyboard
// to build) — that's not usable on a touch device, so every page shows this
// instead of a broken experience. Deliberately a classic (non-module) script
// so it runs immediately as the body starts parsing, before anything else
// has a chance to flash on screen.
(function () {
  var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var narrow = Math.min(window.innerWidth, window.innerHeight) < 560;
  if (!(coarsePointer && narrow)) return;

  var overlay = document.createElement('div');
  overlay.id = 'mobile-guard';
  overlay.innerHTML =
    '<div class="mobile-guard-box">' +
      '<div class="mobile-guard-emoji">💻</div>' +
      '<h2>Un ordinateur, s’il te plaît !</h2>' +
      '<p>Capevil se joue et se construit au clavier (flèches, espace…) : ça ne fonctionne pas sur mobile ou tablette.</p>' +
      '<p class="muted">Reviens depuis un ordinateur pour jouer ou créer des niveaux.</p>' +
    '</div>';

  function mount() { document.body.appendChild(overlay); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
