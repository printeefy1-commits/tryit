# Lunette Caba

Prototype de plateforme d’essayage de lunettes, en français. Node.js 24, Express, Three.js et MediaPipe. Client sans compte ; un administrateur. Aucun paiement ni sélecteur de couleurs.

## Développement

```bash
npm ci
bash scripts/setup-model.sh
# Définir ADMIN_PASSWORD dans l’environnement (12 caractères minimum).
# Ne jamais versionner de mot de passe.
npm start
```

Port par défaut : 3000. `/admin.html` : administration. `npm test` : intégration API (authentification, protection des écritures, visibilité et cycle CRUD). Le modèle de suivi du visage est téléchargé depuis le dépôt officiel Google ; autoriser `storage.googleapis.com` si nécessaire. Les fichiers WASM, le modèle et les bibliothèques sont ensuite servis localement : aucune image caméra n’est transmise au serveur.

## Produits et 3D

Le modèle Éclipse est une géométrie de démonstration générée dans le navigateur. Il ne représente pas un produit réel. Ajouter les photos et fichiers **GLB autonomes** via l’administration ; sans GLB, un produit réel n’a pas d’essayage. Axes : X largeur, Y haut, +Z avant, modèle centré. Ajuster échelle et hauteur dans l’administration puis contrôler sur le site. Les matériaux transparents, l’occlusion par le visage et le calibrage physique restent des limites du prototype : aucun ajustement réel n’est garanti.

`data/catalog.json`, `data/sessions/` et `uploads/` sont des données persistantes, exclues de Git. Sauvegarder `data/` et `uploads/` ensemble. Les fichiers remplacés/supprimés ne sont pas automatiquement purgés pour éviter de supprimer un fichier encore utilisé ; prévoir un nettoyage contrôlé. Le stockage JSON convient à une instance unique, pas à plusieurs processus ou serveurs.

## Ubuntu / EC2

1. Installer Node.js 24 LTS et Nginx depuis leurs sources officielles. Copier le projet dans `/opt/atelier-vision`, installer avec `npm ci --omit=dev`, exécuter `bash scripts/setup-model.sh`.
2. Créer un utilisateur système non privilégié `atelier`. Lui donner la propriété de `data/` et `uploads/`, et la lecture du projet.
3. Créer `/etc/atelier-vision.env` (permissions 600), avec `ADMIN_PASSWORD` (unique et fort), `SESSION_SECRET` (aléatoire, au moins 32 caractères), `NODE_ENV=production`, `PORT=3000`. Ne pas partager ces valeurs dans le chat. Aucun mot de passe par défaut.
4. Installer l’unité ci-dessous, puis `sudo systemctl enable --now atelier-vision`.
5. Configurer Nginx pour le domaine et obtenir un certificat HTTPS (par exemple Certbot). Le navigateur exige HTTPS pour la caméra hors localhost. Tester la configuration avec `sudo nginx -t` avant rechargement.
6. Dans AWS, n’exposer que 80/443 au public et 22 à votre adresse IP. Ne pas ouvrir 3000. Nginx doit être le seul accès public à l’application ; la confiance proxy suppose ce réseau.
7. Vérifier le catalogue, la connexion admin, le CRUD, le refus de caméra, le téléchargement de photo et le suivi sur un vrai iPhone/Android et ordinateur. Aucune validation caméra physique ni aucun déploiement EC2 n’est encore affirmé.

`/etc/systemd/system/atelier-vision.service` :

```ini
[Unit]
Description=Lunette Caba
After=network.target
[Service]
User=atelier
Group=atelier
WorkingDirectory=/opt/atelier-vision
EnvironmentFile=/etc/atelier-vision.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/atelier-vision/data /opt/atelier-vision/uploads
[Install]
WantedBy=multi-user.target
```

Extrait Nginx à intégrer au serveur HTTPS de votre domaine :

```nginx
client_max_body_size 52m;
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Nom de marque : Lunette Caba. Logo original fourni par le propriétaire : `public/assets/lunette-caba-logo.png`, intégré dans les en-têtes public et administrateur. Pour les futurs travaux cloud, utiliser le checkout existant ; ne pas créer de worktree sans demande explicite.

## Validation du modèle de suivi

Le modèle officiel `float16/1` a été téléchargé avec succès. SHA-256 observé : `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.

Le test `CAMERA_FIXTURE=/chemin/vers/visage.y4m node scripts/camera-smoke.mjs` utilise une caméra simulée dans Chromium : chargement réel de MediaPipe, détection d’un visage, téléchargement PNG et arrêt de la caméra à la fermeture. Il a réussi avec le portrait de test officiel de MediaPipe (`https://storage.googleapis.com/mediapipe-assets/portrait.jpg`), converti en Y4M avec FFmpeg. Les fichiers de test sont locaux, non inclus dans le catalogue. Aucun résultat de ce test ne remplace la validation sur un téléphone et une webcam physiques.

## Sauvegardes

La sauvegarde quotidienne vers S3 (sans clés d'accès statiques), son installation sur EC2 et la restauration sont décrites dans [deploy/BACKUP.md](deploy/BACKUP.md). Le script `scripts/backup.py` archive le catalogue et les fichiers référencés, exclut les sessions, vérifie le SHA-256 et vérifie par relecture les archives transférées sur S3. Le bucket, le rôle IAM et le timer doivent être configurés sur le serveur avant activation.

## Premier produit photo-référencé

Le prototype 3D **HEAD 12028 Col.400** et sa photo sont fournis dans `public/products/head-12028/`. [Fidélité, régénération et import sur EC2](docs/head-12028.md). L'import est additif et conserve les produits existants. Ce modèle a des dimensions estimées ; il n'est pas une reproduction mesurée.

Pour remplacer le prototype par une reconstruction photogrammétrique : [workflow RealityScan et capture des photos](docs/realityscan-workflow.md). Le suivi applique un ajustement basé sur les iris, une rotation 3D et un masque de profondeur facial local ; ces corrections ne garantissent ni une géométrie produit fidèle ni une mesure physique.
