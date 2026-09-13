# Level Devil — jeu + éditeur + niveaux communautaires

Un jeu de plateforme façon **Level Devil** : blocs (posés case par case et
assemblés sans jointure visible, y compris à la verticale) avec leurs
propres bascules **traversable / invisible / tueur** (un bloc « tueur » tue
le joueur au contact au lieu d'être un simple obstacle), pointes orientables
et dont l'état peut aussi **changer leur rotation en jeu** (« inoffensif » =
on peut les toucher sans mourir, « traversable » = on les traverse
carrément), ressorts (haut/bas), ventilateurs à **portée réglable** (nombre
de cases touchées par l'air, avec une diminution optionnelle de la force
selon la distance) qui, tant qu'ils sont visibles, soufflent un flux
**constant** de particules de vent le long de tout leur couloir de poussée
(plus ou moins dense selon leur puissance, jamais par intermittence, et pas
seulement quand le joueur les traverse), roues tournantes, téléporteurs
liés par fréquence (le « sens unique » s'applique à toute la fréquence d'un
coup, sans possibilité de faire demi-tour), plateformes mobiles (même
gabarit qu'un bloc solide par défaut, mais toujours librement
redimensionnables, avec les mêmes bascules **traversable / invisible /
tueur** que le bloc, et une **apparence au choix** : couleur personnalisée
ou rendue à l'identique d'un bloc solide, pratique pour la camoufler parmi
de vrais blocs), une **plaque de pression** (répète ses actions tant que le
joueur reste dessus) et des **triggers** invisibles (se déclenchent en
entrant dans leur zone). L'arrivée est elle aussi **traversable** en option
(on la franchit alors sans gagner, comme un pur décor). Les **boutons** et
**plaques** peuvent en option être rendus **« inversables »** (case à cocher
« Inversement des actions », désactivée par défaut) : une fois activée,
chaque pression rejoue leurs actions, et la pression suivante les rejoue
automatiquement à l'envers (un élément déplacé revient à son point de
départ, un joueur rendu invisible redevient visible, etc.) — « comme si on
inversait le sens du temps ». Par défaut (case décochée), un bouton/plaque
rejoue toujours ses actions dans le même sens, à chaque pression. Trigger,
bouton et plaque peuvent tous les trois être mis en **boucle infinie**. Une
mort remet tout le niveau à zéro (triggers, positions, états) sauf le
dernier checkpoint atteint, dont le drapeau garde toujours la même taille.

Un **cube poussable** (📦) est un objet physique (pas un élément
scriptable — il ne peut jamais être la cible d'une action) : il tombe avec
la gravité, se pose sur les blocs/plateformes/autres cubes comme n'importe
quel solide, et le joueur peut le pousser latéralement simplement en
marchant dedans (bloqué net s'il n'y a pas la place). Un cube posé sur une
**plaque de pression** l'actionne exactement comme le ferait le joueur — de
quoi bâtir des casse-têtes de poids/pression sans avoir besoin du joueur
lui-même sur la plaque.

Pendant l'édition d'une action **« Téléporter un élément »**, cliquer dans
l'un des champs x/y affiche les coordonnées **(x, y) de chaque case** de la
grille en surimpression, pour repérer précisément où téléporter sans avoir à
compter les cases à l'œil.

Chaque trigger/bouton/plaque déclenche une liste d'actions parmi exactement
cinq types : **déplacer un élément** (Axe X : +1 droite / -1 gauche, Axe Y :
+1 monte / -1 descend — jamais le joueur, c'est le rôle du téléporteur),
**téléporter un élément** (ou le joueur), **changer l'état du monde**
(gravité, fond d'écran — jamais la taille de la grille), **changer l'état
d'un élément** (traversable / invisible / inoffensif / tueur / **rotation**,
pour faire pivoter des pointes par exemple) et **changer l'état du joueur**
(gravité, touches inversées façon troll, visibilité, puissance de
saut/déplacement). Ces changements d'état du joueur ont aussi un rendu
soigné : la gravité inversée **retourne visuellement le joueur** dans le
sens de sa nouvelle chute (fini le recolorage violet façon troll quand les
touches sont inversées — plus rien ne change visuellement dans ce cas), et
devenir invisible ou réapparaître déclenche un petit **effet de particules
et de son**. Le point de départ du joueur a lui-même un état configurable :
centre de gravité au spawn et visibilité (même invisible, le son et les
particules restent actifs).

L'arrivée est désormais une **porte bleue** : le joueur y est « aspiré » à
l'intérieur, la porte se referme en une courte animation, puis le niveau
est gagné. La roue tournante (spinner) a une **hitbox circulaire** (et non
plus son simple carré englobant), et chaque action de jeu a un petit
**effet sonore synthétisé** (saut, atterrissage, mort, victoire, checkpoint,
téléporteur, ressort, bouton, apparition/disparition — aucun fichier audio
externe, tout est généré à la volée avec la Web Audio API) accompagné de
**particules** (poussière aux pieds, explosion à la mort, confettis à la
victoire, vent du ventilateur, dissolution/matérialisation) et d'un léger
**tremblement de caméra** à la mort. La caméra reste centrée sur le joueur
en permanence (elle ne dérive jamais vers le centre du niveau). Le son est
réglable (muet + volume) et sauvegardé dans le navigateur.

Inclut un éditeur de niveaux complet (grille dont seules les colonnes
9-80 et les lignes 9-30 sont modifiables — toute la zone est toujours
éditable, plus de bornes séparées à gérer —, et une bascule vue debug / vue
réelle en playtest), avec un panneau de propriétés organisé en **sections
bien distinctes** (état, réglages spécifiques à l'élément, actions…) plutôt
qu'une longue liste plate de champs, des **comptes joueurs** (Supabase
Auth, via une **fenêtre modale** de connexion/inscription) pour publier
sous son vrai nom et gérer (modifier/supprimer) ses propres niveaux, un
système de **likes** limité à **un like par compte et par niveau** (le
bouton se grise définitivement une fois liké), une **demande d'approbation**
réservée au **créateur du niveau** (seul son propre auteur peut demander sa
mise en avant), un **espace admin** pour promouvoir des niveaux en « Parties
officielles », et un **signalement** ouvert à **tout le monde** (pas
seulement le créateur) mais réservé aux niveaux déjà officiels. Dans le
panneau admin, chaque niveau en attente d'approbation, signalé, ou déjà
officiel a un lien **« 👁️ Aperçu complet »** qui ouvre l'éditeur en mode
lecture seule (rien n'est modifiable ni publiable) montrant tout exactement
comme dans l'éditeur — y compris les éléments invisibles/traversables — au
lieu de la simple vue de jeu normale. Les touches
(gauche/droite/haut/bas/saut) sont **remappables** et sauvegardées dans le
navigateur. Le site affiche un panneau plein écran invitant à revenir sur
ordinateur pour toute visite mobile/tablette, car le jeu comme l'éditeur
sont pensés clavier + souris.

Toute l'interface passe par de petits **panels et fenêtres modales** plutôt
que par les popups natives du navigateur : confirmations, saisies (raison
d'un signalement…) et **notifications toast** discrètes en bas à droite
remplacent partout `alert()` / `confirm()` / `prompt()`. La page d'accueil
présente les niveaux sous forme de **cartes** (au lieu de tableaux) avec
leurs stats en un coup d'œil, et l'éditeur regroupe la taille de la grille
et la « condition du monde » (gravité, fond d'écran) dans un petit panneau
« 🌍 Condition du monde » séparé, pour garder la barre d'outils dégagée. Les
liens entre un trigger/bouton/plaque et ses cibles ne s'affichent sur la
grille que lorsque cet élément est sélectionné.
Aucune étape de build : ce sont des fichiers HTML/CSS/JS statiques. Ce
dépôt est prêt à être hébergé à la fois sur **GitHub Pages** et sur un
**Cloudflare Worker** (Static Assets) — les deux servent exactement les
mêmes fichiers, **Supabase est le seul vrai "backend"** (base de données +
authentification + API).

## Structure du projet

```
index.html      → accueil : parties officielles + niveaux publiés + brouillons + mes niveaux
game.html        → écran de jeu (?id=<uuid> pour un niveau publié,
                    ?local=<clé> pour un brouillon local, sinon niveau démo)
editor.html      → éditeur de niveaux (?edit=<uuid> pour modifier un niveau publié,
                    ?preview=<uuid> pour l'aperçu admin en lecture seule)
admin.html       → espace admin : approbation des niveaux + signalements
js/engine.js      → moteur de jeu (physique, collisions, triggers/boutons, rendu, son/particules/tremblement)
js/editor.js      → logique de l'éditeur
js/level-model.js → format de données d'un niveau (JSON)
js/sample-level.js → niveau de démonstration
js/auth-ui.js     → bouton + fenêtre modale de connexion/inscription réutilisée partout
js/keybindings.js → touches par défaut + lecture/écriture dans le navigateur
js/keybind-ui.js  → fenêtre modale « ⌨ Touches » pour les remapper
js/audio-fx.js    → effets sonores synthétisés (Web Audio API) + réglage muet/volume (localStorage)
js/audio-ui.js    → bouton muet + curseur de volume, réutilisé dans le jeu et l'éditeur
js/particles.js   → système de particules (poussière, explosion de mort, confettis de victoire)
js/ui-kit.js      → notifications toast + modales confirm/prompt réutilisables (remplace alert/confirm/prompt)
js/mobile-guard.js → panneau plein écran "reviens sur ordinateur" (mobile/tablette)
js/config.js      → clés Supabase (voir ci-dessous)
js/supabase-client.js → comptes, publication / liste / likes / approbation / signalement
sql/schema.sql    → schéma de base de données à exécuter dans Supabase
wrangler.toml     → config pour déployer sur un Cloudflare Worker
```

## 1. Configurer Supabase (base de données)

1. Va sur [supabase.com](https://supabase.com) → ouvre ton projet (ou crées-en un).
2. Dans **SQL Editor**, colle le contenu de `sql/schema.sql` et exécute-le.
   Cela crée les tables `levels`, `reports` et `level_likes` (un like par
   compte et par niveau, imposé par sa clé primaire composite), les règles
   de sécurité (RLS) et les fonctions qui incrémentent les statistiques
   (parties jouées / victoires / likes).
3. Dans **Project Settings → API**, récupère :
   - **Project URL** (ex : `https://abcdefgh.supabase.co`)
   - **anon public key** (⚠️ pas la `service_role` key !)
4. Ouvre `js/config.js` et remplace les deux valeurs par les tiennes.

La clé "anon" est faite pour être publique : la sécurité vient des règles
RLS définies dans `schema.sql` (lecture publique, écriture limitée aux
propriétaires, jamais de suppression/modification par un autre compte), pas
du secret de cette clé.

### Comptes joueurs

Publier un niveau nécessite un compte (créé directement dans le site, pas
besoin d'aller sur Supabase) : le nom d'auteur affiché est toujours celui du
compte connecté, jamais un texte libre. Un compte peut modifier ou
supprimer ses propres niveaux depuis la page d'accueil ("Mes niveaux
publiés") ou avec `editor.html?edit=<id>`.

### Devenir admin

Ce projet n'a pas d'inscription "admin" séparée : n'importe qui peut créer
un compte joueur normal. Le statut admin (qui permet d'approuver des
niveaux en "Parties officielles" et de traiter les signalements) se donne
à la main, une seule fois, dans **Supabase Dashboard → SQL Editor** :

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'ton-email@exemple.com');
```

Connecte-toi ensuite avec ce compte sur `admin.html`.

**Limite connue** : il n'y a que deux niveaux de droits (joueur / admin), pas
de modération plus fine (plusieurs admins avec des permissions différentes,
bannissement de comptes, etc.).

## 2. Tester en local

Comme ce sont des fichiers statiques, il suffit d'un petit serveur local
(l'ouverture directe du fichier `index.html` avec `file://` ne fonctionne
pas à cause des modules JS) :

```bash
npx serve .
# ou
python3 -m http.server 8080
```

Puis ouvre `http://localhost:8080`.

## 3. Déployer sur GitHub Pages (sans Git, depuis le navigateur)

1. Crée un dépôt sur [github.com/new](https://github.com/new) (public, sans
   README ni licence).
2. Sur la page du dépôt vide, clique **uploading an existing file** (ou
   **Add file → Upload files**), puis glisse **le contenu** de ce dossier
   (pas le dossier `level-devil` lui-même) dans la zone d'upload. GitHub
   garde l'arborescence des sous-dossiers (`css/`, `js/`, `sql/`).
3. Écris un message de commit et clique **Commit changes**.
4. **Settings → Pages → Build and deployment → Source : Deploy from a
   branch → Branch : `main` / `(root)` → Save**.
5. Ton site est en ligne quelques instants après, à l'adresse
   `https://<ton-pseudo>.github.io/<nom-du-repo>/`.

*(Alternative en ligne de commande : `git init && git add . && git commit
-m "init" && git push`, si tu préfères.)*

## 4. Déployer sur un Cloudflare Worker (sans Wrangler, depuis le dashboard)

Ce projet contient déjà un `wrangler.toml` configuré pour un Worker nommé
`leveldevil` (à adapter si le tien porte un autre nom) avec
`[assets] directory = "."` : Cloudflare sert simplement les fichiers du
dépôt tels quels, sans code serveur.

1. Sur [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers &
   Pages** → clique sur ton Worker existant.
2. **Settings → Builds** → à côté de **Git Repository**, clique
   **Connect / Manage** → autorise GitHub → choisis ce dépôt.
3. Laisse les réglages par défaut (branche `main`, build command vide,
   deploy command `npx wrangler deploy`) → **Save and Deploy**.

Cloudflare relance automatiquement un déploiement à chaque nouveau commit
sur GitHub (visible dans l'onglet **Deployments**) — y compris quand tu
modifies un fichier directement dans l'éditeur web de GitHub.

*(Alternative en ligne de commande : `npm install -g wrangler && wrangler
login && wrangler deploy`, si tu préfères.)*

## Prochaines améliorations possibles
- Rôles admin plus fins (plusieurs admins, permissions différentes) et modération de comptes.
- Commentaires sur les niveaux publiés.
- Musique de fond synchronisée (au-delà des effets sonores déjà présents).
- Undo/redo et copier-coller dans l'éditeur.
- Vérification automatique "ce niveau est-il faisable ?" avant publication.
