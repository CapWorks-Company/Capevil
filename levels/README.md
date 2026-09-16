# Niveaux d'aventure

Ce dossier contient les niveaux JSON de la campagne officielle « 🗺️ Aventure »
(voir `js/campaign.js`).

## Ajouter un niveau

1. Construis le niveau dans l'éditeur (`editor.html`), en le titrant
   `Niveau_N` (champ « Titre du niveau » en haut) — N étant sa place dans la
   campagne : `Niveau_1`, `Niveau_2`, `Niveau_3`, …
2. Bouton **⭳ Exporter JSON** — le fichier téléchargé s'appelle automatiquement
   `Niveau_N.json` (le nom suit le titre).
3. Dépose ce fichier directement dans ce dossier.

C'est tout — rien d'autre à modifier. Au chargement, le site cherche tout
seul `levels/Niveau_1.json`, puis `levels/Niveau_2.json`, etc., dans l'ordre,
et s'arrête au premier numéro manquant. La section Aventure de la page
d'accueil et `game.html?campaign=N` lisent cette même liste.

Les niveaux doivent former une suite sans trou (1, 2, 3, …) : si `Niveau_3.json`
manque, `Niveau_4.json` ne sera jamais détecté même s'il est bien présent.
