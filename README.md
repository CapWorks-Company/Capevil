# Level Devil — jeu + éditeur + niveaux communautaires

Un jeu de plateforme façon **Level Devil** : blocs, pointes orientables,
ressorts (haut/bas), ventilateurs (vent continu gauche/droite/haut/bas),
roues tournantes, téléporteurs liés par fréquence, plateformes mobiles, des
**triggers** invisibles et des **boutons** visibles/répétables qui
déclenchent des pièges (déplacements en série, boucles autonomes,
changement d'état d'un élément — traversable / invisible / inoffensif —,
inversion de la gravité, inversion des touches façon troll, changement de
puissance de saut...). Une mort remet tout le niveau à zéro (triggers,
positions, états) sauf le dernier checkpoint atteint.

Inclut un éditeur de niveaux complet (avec une zone d'édition verrouillable
pour protéger un cadre décoratif, et une bascule vue debug / vue réelle en
playtest), des **comptes joueurs** (Supabase Auth, via une **fenêtre modale**
de connexion/inscription) pour publier sous son vrai nom et gérer
(modifier/supprimer) ses propres niveaux, un système de **likes**, une file
de **demandes d'approbation** avec un espace **admin** pour promouvoir des
niveaux en « Parties officielles », et un **signalement** réservé à ces
niveaux officiels. Les touches (gauche/droite/haut/bas/saut) sont
**remappables** et sauvegardées dans le navigateur. Le site affiche un
panneau plein écran invitant à revenir sur ordinateur pour toute visite
mobile/tablette, car le jeu comme l'éditeur sont pensés clavier + souris.
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
editor.html      → éditeur de niveaux (?edit=<uuid> pour modifier un niveau publié)
admin.html       → espace admin : approbation des niveaux + signalements
js/engine.js      → moteur de jeu (physique, collisions, triggers/boutons, rendu)
js/editor.js      → logique de l'éditeur
js/level-model.js → format de données d'un niveau (JSON)
js/sample-level.js → niveau de démonstration
js/auth-ui.js     → bouton + fenêtre modale de connexion/inscription réutilisée partout
js/keybindings.js → touches par défaut + lecture/écriture dans le navigateur
js/keybind-ui.js  → fenêtre modale « ⌨ Touches » pour les remapper
js/mobile-guard.js → panneau plein écran "reviens sur ordinateur" (mobile/tablette)
js/config.js      → clés Supabase (voir ci-dessous)
js/supabase-client.js → comptes, publication / liste / likes / approbation / signalement
sql/schema.sql    → schéma de base de données à exécuter dans Supabase
wrangler.toml     → config pour déployer sur un Cloudflare Worker
```

## 1. Configurer Supabase (base de données)

1. Va sur [supabase.com](https://supabase.com) → ouvre ton projet (ou crées-en un).
2. Dans **SQL Editor**, colle le contenu de `sql/schema.sql` et exécute-le.
   Cela crée la table `levels`, les règles de sécurité (RLS) et la fonction
   qui incrémente les statistiques (parties jouées / victoires).
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
- Musique synchronisée et effets sonores.
- Meilleure hitbox circulaire pour la roue tournante.
- Undo/redo et copier-coller dans l'éditeur.
- Vérification automatique "ce niveau est-il faisable ?" avant publication.
