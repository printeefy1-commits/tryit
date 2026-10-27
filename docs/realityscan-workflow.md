# RealityScan : préparer un actif pour l'essayage

RealityScan est une piste de reconstruction photogrammétrique, distincte du suivi de visage. Le propriétaire dispose d'un ordinateur Windows. Le logiciel n'est pas installé ni exécuté dans notre environnement Linux sans GPU NVIDIA. Aucun résultat RealityScan n'a été généré et aucun abonnement n'a été souscrit. L'accès aux pages officielles était bloqué par le proxy au moment de l'étude : vérifier les exigences matérielles et les conditions de licence dans la version téléchargée depuis https://www.realityscan.com/download.

## Les cinq photos actuelles

Les cinq images HEIC du propriétaire ont été converties en JPEG, avec suppression des métadonnées EXIF sans modification des pixels décodés. Une archive de transfert a été préparée hors du dépôt pour l'import dans RealityScan sur Windows. Ces cinq vues ne constituent pas une acquisition photogrammétrique complète : recouvrement et vues latérales insuffisants, surfaces foncées peu texturées et verres réfléchissants. Une tentative d'alignement peut échouer ou produire une géométrie incomplète. Ne pas présenter un tel résultat comme un scan fidèle.

## Acquisition à compléter

- Garder les lunettes ouvertes et immobiles ; déplacer l'appareil autour d'elles.
- Photographier plusieurs tours à différentes hauteurs ; viser environ 60 à 100 photos nettes avec un recouvrement important (environ 70–80 %) entre vues voisines.
- Garder une lumière douce, stable, sans surexposition, et une mise au point constante sur l'objet.
- Inclure dessus, côtés, branches et dessous accessibles. Un environnement statique avec des repères peut aider l'alignement ; il faudra isoler l'objet du support à la reconstruction.
- Relever séparément une dimension réelle, par exemple la largeur totale de la monture : la photogrammétrie seule n'établit pas l'échelle physique.

Les reflets et la transparence restent difficiles même avec davantage d'images. Le cadre reconstruit pourra servir de base ; les verres et certaines parties fines devront éventuellement être remodélisés et recevoir des matériaux adaptés au rendu temps réel.

## Échange et intégration

Importer les JPEG dans un projet RealityScan, essayer l'alignement et vérifier qu'un composant cohérent contient les vues de l'objet. Si l'alignement est fragmenté, compléter la capture plutôt que forcer une géométrie inventée. Après reconstruction, isoler les lunettes et simplifier le maillage. Exporter en OBJ avec MTL/textures (dans une même archive) ou en GLB si la version utilisée le propose. Conserver les textures avec le modèle.

À réception du résultat, contrôler la fidélité visuelle, nettoyer les surfaces parasites, reprendre si nécessaire les verres et les branches, réduire le poids, centrer le modèle, puis exporter un GLB autonome. Garder X=largeur, Y=haut, +Z=avant. Définir un ancrage au centre des verres et une largeur frontale dans `asset.extras.lunetteCaba`, comme décrit dans head-12028.md. Ne pas réutiliser l'ancienne géométrie par erreur : pour un produit déjà importé, modifier son fichier 3D via l'administration, car le script d'import initial est volontairement idempotent.

## Corrections du moteur, indépendantes de RealityScan

L'application utilise désormais les centres des iris (ou le milieu des canthi en repli), une base 3D orthonormale pour la rotation, une projection orthographique commune aux landmarks et à l'actif, un lissage temporel, et un masque de profondeur animé pour cacher les parties situées derrière le visage. Ce sont des corrections du suivi, pas une amélioration automatique de la géométrie ou une garantie de taille réelle.

Validation : tests de pose connus (inclinaison, rotation latérale, roulis, format portrait), conservation de la largeur intrinsèque, test de masquage réel WebGL (objet derrière invisible, objet devant visible), et essai du GLB HEAD via caméra simulée. Les mouvements sur un visage réel restent à recontrôler par le propriétaire après mise à jour.
