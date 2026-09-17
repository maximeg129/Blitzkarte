# Karteikasten — version Firebase indépendante

App de révision : photo d'exercice → fiches, quiz et écriture générés par Claude, correction automatique, tout stocké sur Firestore avec compte Google.

## Structure du repo

```
public/index.html        → toute l'app frontend (design + logique)
functions/index.js        → proxy sécurisé vers l'API Anthropic (2 endpoints)
firestore.rules           → chaque utilisateur ne voit que ses propres données
firebase.json              → config Hosting + Functions
.github/workflows/deploy.yml → déploiement auto sur push vers main
```

## Mise en place (une seule fois)

### 1. Créer le projet Firebase
1. https://console.firebase.google.com → **Ajouter un projet**
2. Passer sur le plan **Blaze** (pay-as-you-go) — nécessaire car les Cloud Functions appellent un service externe (l'API Anthropic). Pour un usage familial, ça reste quasi gratuit (2M invocations offertes/mois).
3. **Authentication** → Sign-in method → activer **Google**
4. **Firestore Database** → créer une base, mode production, région `europe-west1` (proche d'Amsterdam)

### 2. Récupérer la config web
Project settings → General → "Your apps" → ajouter une app Web → copier le `firebaseConfig` et le coller dans `public/index.html` (remplace les `REPLACE_ME`). Ces valeurs ne sont pas secrètes — c'est normal qu'elles soient dans le code client.

### 3. Mettre `.firebaserc`
Remplace `REPLACE_WITH_YOUR_PROJECT_ID` par l'ID de ton projet Firebase.

### 4. Stocker la clé API Anthropic comme secret
En local, avec [firebase-tools](https://firebase.google.com/docs/cli) installé (`npm install -g firebase-tools`, puis `firebase login`) :
```
firebase functions:secrets:set ANTHROPIC_API_KEY
```
Colle ta clé quand demandé. Elle reste côté serveur — jamais exposée au navigateur.

### 5. GitHub Actions
1. Crée le repo sur GitHub, pousse ce dossier
2. Génère un token de déploiement : `firebase login:ci`
3. Dans GitHub → Settings → Secrets and variables → Actions → ajoute un secret `FIREBASE_TOKEN` avec ce token
4. Chaque push sur `main` déploie automatiquement Hosting + Functions + les règles Firestore

### 6. Premier déploiement manuel (optionnel, pour tester avant de pousser sur GitHub)
```
firebase deploy --only hosting,functions,firestore:rules
```

## Verrouiller l'accès à vous deux uniquement

Par défaut, n'importe quel compte Google peut se connecter. Pour restreindre à toi et Ruben, dans `functions/index.js`, décommente et complète la vérification d'email dans `requireAuth()` :
```js
if (!["maxime@...", "ruben@..."].includes(decoded.email)) {
  res.status(403).json({ ok:false, msg:"Accès non autorisé." });
  return null;
}
```

## Limites connues
- Les `sets` sont stockés comme un seul document Firestore par utilisateur (simple, rapide à porter depuis la version précédente). Si la boîte grossit beaucoup (des centaines d'exercices), il vaudra mieux passer à une sous-collection `users/{uid}/sets/{id}` — pas urgent pour un usage scolaire normal.
- Pas de mode hors-ligne pour l'instant (Firestore le permet nativement si besoin plus tard).
