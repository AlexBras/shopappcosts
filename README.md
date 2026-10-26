# ShopAppCosts — site statique

Comparateur des coûts réels des apps Shopify (anglais, marché US). Aucun framework, aucune dépendance : un script Node lit les fichiers de `data/` et génère le site complet dans `dist/`.

## Ce que le build produit (32 pages)

| URL | Contenu | Requête visée |
|---|---|---|
| `/` | Accueil, ticket d'exemple, price tracker, liens | shopify app costs |
| `/calculator/` | Calculateur (lien partageable, l'URL garde les valeurs) | shopify app cost calculator |
| `/shopify-review-apps/` (+ email, subscription, translation) | 4 pages catégorie : coût à 4-5 volumes types, plans, comparatifs | best shopify review apps cost |
| `/apps/<app>/` | 11 pages app : plans, coût par volume, alternatives, historique | judge.me pricing, loox pricing… |
| `/compare/<a>-vs-<b>/` | 10 comparatifs (toutes les paires d'une même catégorie) | judge.me vs loox… |
| `/compare/`, `/price-changes/`, `/methodology/`, `/disclosure/`, `404.html` | Pages support | — |

Plus : `sitemap.xml`, `robots.txt`, `_redirects`, `_headers`, favicon, données structurées (BreadcrumbList, SoftwareApplication, ItemList), balises canonical et Open Graph.

## Tester en local

```bash
node build.js
npx serve dist        # puis http://localhost:3000
```

## Mise en ligne, pas à pas

Tout se fait avec deux comptes gratuits : **GitHub** (le code et les automatisations) et **Cloudflare** (le domaine, l'hébergement, l'e-mail). Le seul coût est le domaine.

### 1. Le nom
Mettre le nom et le domaine choisis dans `data/site.json` (`name`, `nameParts`, `baseUrl`, `contactEmail`). Rien d'autre à toucher.
Ne pas mettre « shopify » dans le domaine : les règles de marque de Shopify l'interdisent pour un nom générique.

### 2. GitHub
1. Créer un compte sur github.com, puis un dépôt **privé** vide (ex. `shopappcosts`).
2. Y envoyer le contenu de ce dossier, y compris le dossier caché `.github` (c'est lui qui contient les automatisations).
3. Settings → Actions → General → *Workflow permissions* : cocher **Read and write permissions** et **Allow GitHub Actions to create and approve pull requests**. Enregistrer.
4. Settings → Secrets and variables → Actions → onglet *Variables* → New variable : `SITE_URL` = `https://votredomaine.com`.

### 3. Cloudflare : domaine et hébergement
1. Créer un compte sur cloudflare.com.
2. *Domain Registration → Register Domains* : acheter le domaine (Cloudflare le vend à prix coûtant, DNS et HTTPS inclus).
3. *Workers & Pages → Create → Pages → Connect to Git* : choisir le dépôt.
   - Build command : `node build.js`
   - Build output directory : `dist`
   - Variable d'environnement : `SITE_URL` = `https://votredomaine.com`
4. Une fois le premier déploiement terminé : *Custom domains* → ajouter `votredomaine.com`, puis `www.votredomaine.com`.
5. *Email Routing* sur le domaine : créer `hello@votredomaine.com` qui renvoie vers ta boîte Gmail (gratuit). C'est l'adresse de contact du site, utile aussi pour les programmes d'affiliation.

À partir de là, **chaque modification du dépôt met le site en ligne toute seule** (1 à 2 minutes).

### 4. Lancer les automatisations
1. GitHub → onglet *Actions* → *Daily price check* → **Run workflow**. Le premier passage enregistre une référence pour chaque fiche. Ouvrir le résumé du run et vérifier que chaque bloc montre bien les plans et les prix.
2. *Weekly report* → **Run workflow** : tu dois recevoir le rapport par e-mail.

### 5. Référencement
Google Search Console : ajouter le domaine (la vérification passe par le DNS Cloudflare), puis soumettre `https://votredomaine.com/sitemap.xml`. Même chose sur Bing Webmaster Tools (il peut importer depuis Search Console).

Alternative à Cloudflare : `netlify.toml` est prêt pour Netlify (même build, même variable `SITE_URL`).

## Automatisations

| Quoi | Quand | Ce que tu fais |
|---|---|---|
| **Relevé des prix** (`price-check.yml`) | Tous les jours, 22 h 17 à Nouméa | Rien s'il n'y a pas de changement : la date « Last checked » du site avance toute seule. |
| **Mise à jour des prix** | Quand seul un prix change sur une fiche (mêmes plans, mêmes limites, nouveau prix plausible) | Rien : le prix, le calculateur, les comparatifs, les textes qui citaient l'ancien prix et le journal sont mis à jour et publiés le soir même. |
| **Changement de structure** | Nouveau plan, plan supprimé, nouvelle limite ou nouveaux frais, prix aberrant | Une *pull request* s'ouvre (tu reçois un e-mail) avec l'avant/après et la raison. Ajuster `data/apps.json` (et la règle dans `src/costs.js` si besoin), puis **Merge**. |
| **Mise en ligne** | À chaque modification du dépôt | Rien. |
| **Rapport hebdo** (`weekly-report.yml`) | Lundi 6 h 43 à Nouméa | Le lire : changements de la semaine, validations en attente, fiches illisibles, état du site en ligne. |

Pourquoi une validation humaine pour les changements de structure : un nouveau palier ou de nouveaux frais changent la règle de calcul elle-même, et publier un calcul faux coûterait plus cher que 2 minutes de relecture. Les prix, eux, ne sont écrits qu'à un seul endroit (`data/apps.json`) : le calculateur les y lit.

Si une fiche ne se lit plus (Shopify qui change sa page ou bloque le robot), elle apparaît dans le rapport hebdo et sa date « checked » cesse d'avancer : le site n'affiche jamais une vérification qui n'a pas eu lieu.

## Mettre à jour un prix

1. Modifier le plan dans `data/apps.json` et la date `checked` de l'app.
2. Si la règle de calcul change (seuil, palier, frais), modifier la règle correspondante dans `src/costs.js`. Les prix eux-mêmes ne sont jamais écrits dans `src/costs.js` : il les lit dans `data/apps.json`.
3. Ajouter une entrée datée dans `data/changelog.json` (avec `app` = id de l'app pour qu'elle apparaisse aussi sur sa page).
4. Mettre `lastChecked` à jour dans `data/site.json`, rebuild, déployer (automatique si Git).

## Intégrer un lien affilié

Tous les boutons « Visit » passent par `/go/<app>/`, qui redirige (302) vers la fiche officielle tant qu'il n'y a pas de lien affilié.

Pour activer l'affiliation d'une app, renseigner `affiliate.url` dans `data/apps.json`, puis rebuild. La redirection pointe alors vers votre lien, et les boutons de cette app prennent automatiquement `rel="sponsored"`. Aucune page à modifier. `/go/` est exclu de l'indexation.

État actuel (`affiliate.status`) : Omnisend (Impact, 20 % récurrent 24 mois), Klaviyo, Loox, Weglot = programme existant ; Judge.me, Yotpo, Recharge, Seal, langify = à contacter ; Shopify Email, Translate & Adapt = pas de programme.

## Ajouter une app

1. Ajouter l'objet dans `data/apps.json` (même structure, `cat` = id de catégorie).
2. Ajouter sa règle de coût dans `src/costs.js`, dans la catégorie concernée, avec le même `id`.
3. Rebuild : sa page, ses comparatifs avec les autres apps de la catégorie, le sitemap et les redirections sont générés.

Nouvelle catégorie : ajouter un objet dans `data/categories.json` (slug, titres, scénarios) et le bloc correspondant dans `costs.js`.
