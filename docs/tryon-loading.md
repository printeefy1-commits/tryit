# Diagnostic du démarrage de l'essayage

Un flux caméra visible ne prouve pas que MediaPipe et le GLB sont chargés. L'ancien démarrage gardait le même texte « Chargement du suivi du visage… » pendant le chargement du suivi, de son masque puis du GLB, et attendait le GLB avant de lancer le suivi. La capture de l'utilisateur est compatible avec une de ces attentes ; la cause exacte sur EC2 n'a pas pu être inspectée directement (accès au domaine bloqué depuis l'environnement de développement).

## Comportement corrigé

Le statut distingue permission caméra, téléchargement du suivi (progression), initialisation du suivi, préparation du masque, affichage 3D, téléchargement de la monture (progression) et décodage des textures. Le texte invitant à activer la caméra est remplacé dès le démarrage et disparaît quand le suivi est prêt.

Le modèle MediaPipe est téléchargé explicitement puis initialisé depuis son buffer. Le suivi démarre dès que possible, sans attendre le gros GLB. L'image caméra n'est jamais envoyée au serveur. Une erreur de chargement reste visible ; le suivi ne l'écrase plus.

Les téléchargements ont une limite d'inactivité de 30 secondes, renouvelée à chaque bloc reçu (un transfert lent qui progresse n'est pas interrompu arbitrairement au bout de 30 secondes). Une initialisation du suivi qui ne répond pas est signalée après 60 secondes ; le décodage d'une monture après 45 secondes. Les GLB dépassant 25 MiB sont refusés avec un message explicite. Les HTTP 404/500 sont affichés comme erreurs de fichier au lieu d'une attente sans fin.

Fermer la fenêtre annule le téléchargement de monture et arrête la caméra. Les résultats d'une ancienne session sont ignorés et les objets 3D décodés après annulation sont libérés. Une initialisation MediaPipe en cours est partagée avec une éventuelle nouvelle tentative pour éviter plusieurs heaps WASM simultanés. Une erreur présente un bouton « Réessayer ».

## Mise à jour sur EC2

```bash
cd ~/tryit
git pull --ff-only origin main
sudo systemctl restart tryit
```

Aucune réimportation du produit ni réinstallation de dépendances n'est nécessaire. Recharger complètement le navigateur, ouvrir HEAD 12028 et activer la caméra. Si un échec persiste, relever le message exact affiché et les requêtes en échec dans les outils réseau du navigateur.

Pour vérifier les fichiers depuis le serveur sans afficher de secrets :

```bash
cd ~/tryit
node --input-type=module <<'JS'
import fs from 'node:fs/promises';
const products=JSON.parse(await fs.readFile('data/catalog.json','utf8'));
const model=products.find(p=>p.id==='head-12028-col400')?.model;
const paths=['public/models/face_landmarker.task','public/models/face-topology.json','node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'];
if(model?.startsWith('/uploads/'))paths.push('.'+model);
else console.log('HEAD 12028: no uploaded model is configured.');
for(const file of paths){try{const s=await fs.stat(file);console.log(file,s.size,'bytes')}catch{console.log(file,'MISSING')}}
JS
```

Si la dernière ligne de statut reste « Initialisation du suivi du visage… », examiner les requêtes `/vendor/vision/wasm/` et la console du navigateur. Si elle indique « Téléchargement de la monture… », vérifier l'URL publique du fichier et la taille de l'upload. Un test réussi dans Chromium de développement ne constitue pas une validation du navigateur ou du réseau du propriétaire.

## Tests

- `npm test` : transferts HTTP réels avec réponse 404, taille excessive, connexion bloquée, transfert lent qui progresse, annulation et initialisation dépassant son délai.
- `CAMERA_FIXTURE=/chemin/visage.y4m TRYON_PRODUCT_ID=head-12028-col400 node scripts/loading-smoke.mjs` : vrai Chromium et vraie initialisation MediaPipe, fichier de suivi absent puis nouvelle tentative réussie, GLB volontairement retardé, fermeture pendant le transfert puis réouverture réussie.
- Test caméra standard : vrai GLB texturé, visage détecté, capture et arrêt du flux ; les erreurs de textures sont vérifiées.
