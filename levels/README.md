# Niveaux d'aventure

Ce dossier contient les niveaux JSON de la campagne officielle « 🗺️ Aventure »
(voir `js/campaign.js`).

## Ajouter un niveau

1. Construis le niveau dans l'éditeur (`editor.html`), en le titrant
   `Niveau N` (champ « Titre du niveau » en haut, avec un espace — pas de
   tiret bas) — N étant sa place dans la campagne : `Niveau 1`, `Niveau 2`,
   `Niveau 3`, …
2. Bouton **⭳ Exporter JSON** — le fichier téléchargé s'appelle automatiquement
   `Niveau N.json` (le nom suit le titre).
3. Dépose ce fichier directement dans ce dossier.

C'est tout — rien d'autre à modifier. Au chargement, le site cherche tout
seul `levels/Niveau 1.json`, puis `levels/Niveau 2.json`, etc., dans l'ordre,
et s'arrête au premier numéro manquant. La section Aventure de la page
d'accueil et `game.html?campaign=N` lisent cette même liste.

Les niveaux doivent former une suite sans trou (1, 2, 3, …) : si `Niveau 3.json`
manque, `Niveau 4.json` ne sera jamais détecté même s'il est bien présent.
