# Modèle fourni par le propriétaire — release model-v1

## Origine vérifiée

- Release : https://github.com/printeefy1-commits/tryit/releases/tag/model-v1
- Asset : `b15280ade5ee4236c8457d326fa8e8a8.1.glb`
- Taille originale : 65 724 500 octets (62,7 MiB).
- SHA-256 original, vérifié contre la page GitHub : `20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055`.

L'original n'est pas modifié et reste disponible dans la release. Le fichier adapté pour le site est `public/products/head-12028/head-12028-generated.glb`. Ce modèle généré n'est pas un relevé mesuré de HEAD 12028 : sa fidélité, ses inscriptions, ses dimensions et ses reflets doivent être comparés au produit réel par le propriétaire.

## Optimisation

- 1 500 000 triangles → 75 000.
- Trois textures PBR intégrées : couleur, normal et metallic/roughness, 4096² → 2048².
- Tangentes exportées explicitement pour le rendu des normal maps ; 15 tangentes nulles sur UV dégénérés ont reçu une direction stable perpendiculaire à la normale.
- Taille finale : 12 371 160 octets (11,8 MiB), sous la limite d'upload de 25 MiB.
- GLB autonome, sans fichiers de texture externes ni décodeur Draco requis.
- Axes X=largeur, Y=haut, +Z=avant conservés. Ancrage au centre des verres `[-0.00085, 0.14, 0.2114]` et largeur frontale de référence `0.9078`, dans les unités arbitraires du modèle. Ces valeurs règlent la pose esthétique, sans fournir de mesure physique.

La comparaison visuelle avant/après a été faite avec le même éclairage et les mêmes angles dans Chromium. Les réflexions et détails déjà présents dans la texture fournie sont conservés ; ils ne suivent pas nécessairement la lumière réelle de la caméra. Les verres font partie d'un maillage opaque unique, pas d'une simulation optique de lentilles séparées.

Mise à jour du rendu : le binaire source reste inchangé. Le profil navigateur `tryon-materials.js`, limité à cette empreinte de source, sépare maintenant les triangles des verres et remplace les reflets peints par des matériaux estimés distincts pour l'acétate et les verres transparents. Leurs paramètres ne sont pas des propriétés optiques mesurées. Voir [la comparaison et les limites de la nouvelle version](rayban-comparison-ar.md). Aucune nouvelle migration du catalogue n'est nécessaire pour ce changement.

## Reproduction du traitement (machine d'authoring)

Nécessite Blender 4.3, pas sur EC2 pour le simple déploiement :

```bash
blender --background --threads 2 --python scripts/optimize-generated-head.py -- \
  --input /chemin/vers/le-modele-original.glb \
  --output public/products/head-12028/head-12028-generated.glb
```

Le script vérifie le SHA-256 original avant d'appliquer ce profil de pose, qui est propre à cet actif.

## Mise à jour sur EC2

Le produit initial `head-12028-col400` doit déjà exister. L'upgrade remplace uniquement sa référence de modèle et les métadonnées de provenance. Nom, marque, photo, visibilité, échelle, décalage et autres produits sont conservés. Les fichiers d'upload précédents ne sont pas supprimés ; leur chemin est également conservé dans `previousModel`. Une seconde exécution ne réécrit pas le catalogue.

Faire d'abord une sauvegarde et attendre son succès :

```bash
cd ~/tryit
git pull --ff-only origin main
sudo systemctl start tryit-backup.service
```

Puis arrêter le service pour éviter une écriture concurrente, appliquer et redémarrer :

```bash
sudo systemctl stop tryit
node scripts/upgrade-head-12028.mjs
sudo systemctl start tryit
```

Redémarrer `tryit` même si le script signale une erreur, puis diagnostiquer avant de recommencer. Le nouveau GLB est copié sous un nom basé sur son contenu dans `uploads/`, donc la sauvegarde S3 existante le prend en compte. Pour revenir à l'ancienne référence, travailler hors ligne avec le service arrêté et rétablir `previousModel`, ou restaurer le catalogue sauvegardé. L'ancien prototype versionné reste aussi disponible.

Recharger complètement la page. La politique CSP du serveur autorise désormais `blob:` dans `connect-src` : GLTFLoader en a besoin pour les bitmaps intégrés. Les connexions externes ne sont pas ajoutées à cette directive. Sans ce changement, le modèle peut apparaître gris sans ses textures.

## Vérifications

- Validateur Khronos : aucune erreur, aucun avertissement.
- Import dans Three.js, textures intégrées et rendu frontal/oblique/latéral.
- Caméra simulée avec visage de test issu de l'exemple OpenCV `samples/data/lena.jpg`, suivi, modèle généré sélectionné, capture PNG et arrêt du flux. Le test échoue désormais aussi sur les erreurs de console (dont les textures refusées par CSP) ; seul le message informatif XNNPACK envoyé sur stderr par WebAssembly est ignoré explicitement.
- Test d'upgrade isolé : préservation des réglages personnalisés et des autres produits, archive GLB autonome, taille compatible et seconde exécution sans effet.
- Suite API/pose et interface ordinateur/mobile.

La vérification physique sur le téléphone/ordinateur du propriétaire et le déploiement sur EC2 restent à faire après les commandes ci-dessus.
