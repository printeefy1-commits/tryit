# Pose de tête et occlusion lors des rotations

## Problème observé

Le propriétaire a confirmé que le rendu frontal fonctionne mais que les lunettes se réduisent ou glissent lors des rotations, et que les branches apparaissent au-dessus du front quand la tête se baisse. Le calcul précédent reposait sur les iris et le z normalisé des landmarks, y compris lorsque l'œil éloigné était caché. Les tests sur des points rigidement transformés n'exerçaient pas cet échec des estimations de l'iris. Le masque couvrait seulement la surface faciale et ne pouvait pas masquer le scalp ou l'arrière de la tête.

## Correction

- Demander `outputFacialTransformationMatrixes` à MediaPipe, vérifier le format colonne par colonne avec une sortie réelle, extraire sa rotation et la lisser.
- Ajuster l'échelle et la translation écran par moindres carrés sur des repères répartis du visage canonique, en pondérant les canthi et le pont nasal. Aucun iris n'intervient dans ce nouveau calcul.
- Placer le plan des verres dans ce repère rigide, pour que son déplacement lors d'un mouvement vertical suive la rotation de la tête. La largeur nominale de 14 cm reste une hypothèse esthétique, pas une mesure commerciale du produit.
- Employer la même référence de profondeur rigide pour le masque facial, tout en conservant ses contours écran observés. Réserver une marge latérale dans le proxy de profondeur des tempes, afin que la branche proche ne soit pas enterrée dans un template canonique plus large que la monture ; la profondeur des yeux et du nez est conservée.
- Ajouter un volume crânien invisible, derrière les verres et plus haut que le front, pour masquer les branches éloignées au niveau du scalp et de l'arrière de la tête. Sa largeur est réduite au niveau des tempes pour laisser visible la branche proche.
- Si MediaPipe ne fournit pas de pose exploitable, inviter à tourner légèrement le visage vers la caméra au lieu de réutiliser une taille qui s'effondre à partir d'un iris caché.

Le visage canonique et sa topologie proviennent de Google AI Edge / MediaPipe (Apache-2.0), voir `public/models/MEDIAPIPE-NOTICE.txt` et le fichier de licence associé. Tous les calculs et images restent dans le navigateur.

## Validation et limites

Tests numériques : yaw jusqu'à ±75°, inclinaison d'environ 57°, roulis, affichage portrait, iris artificiellement confondus et z des landmarks volontairement erroné. La largeur est conservée et le plan des verres suit la pose rigide connue. Tests du masque : référence de profondeur commune, couverture au-dessus de la surface faciale et arrière du crâne. Vérification visuelle sur mannequin rendu avec le vrai GLB aux vues frontale, oblique, profil et tête baissée, ainsi qu'un essai MediaPipe sur visage de test avec caméra simulée.

Ces tests n'établissent pas le résultat exact sur les mouvements du propriétaire. Le volume crânien est une approximation sans segmentation précise des cheveux ni oreilles. Les profils presque complets, occultations et éclairages difficiles peuvent rester moins fiables. Le modèle est également généré et non mesuré ; forme, longueur des branches et taille réelle demandent une validation avec le produit.

## Déploiement

```bash
cd ~/tryit
git pull --ff-only origin main
sudo systemctl restart tryit
```

Recharger complètement la page, réactiver la caméra, puis contrôler lentement droite/gauche et haut/bas. Il n'est pas nécessaire de réimporter ou régénérer le GLB. Les modifications des contrôles de chargement sont incluses et leurs tests de fermeture/réouverture et nouvelle tentative restent exécutés.

## Deuxième correction : pont, branches proches et perte de suivi

Les retours suivants montraient un pont coupé en baissant la tête, une branche proche tronquée de chaque côté, et une disparition en levant fortement le visage. Un proxy anatomique moyen peut croiser une monture générée qui n'a pas été mesurée. L'ajustement frontal, la géométrie GLB et les réglages du catalogue sont conservés.

Le masque facial dispose maintenant d'une marge en profondeur caméra, renforcée autour de la racine du nez et lors des vues latérales. Cette marge ne déplace pas la monture et ne désactive pas son test de profondeur. Le volume crânien couvre davantage l'arrière du crâne ; son retrait en profondeur dépend du mouvement latéral, afin de préserver la branche proche tout en cachant celle du côté opposé. Ces marges sont des compromis visuels, pas des mesures du visage.

Les seuils de détection, présence et suivi MediaPipe sont respectivement 0,4 / 0,35 / 0,35. Une interruption inférieure à 220 ms conserve la dernière pose et désactive la photo. Au-delà, la monture disparaît avec une indication explicite ; une détection valide rétablit automatiquement l'essai. La pose conservée est effacée à la fermeture. Cela évite un clignotement bref, mais ne permet pas de suivre indéfiniment un visage dont les yeux et le nez sont cachés par une inclinaison extrême. Sur un appareil très lent, l'intervalle entre deux images peut déjà dépasser cette marge.

Validation reproductible :

```bash
npm test
node scripts/occlusion-smoke.mjs
CAMERA_FIXTURE=/chemin/visage.y4m TRYON_PRODUCT_ID=head-12028-col400 TRACKING_DROPOUTS=1 node scripts/camera-smoke.mjs
```

Le test d'occlusion rend le véritable GLB livré et mesure séparément les pixels du pont, de la face avant et de chaque branche, par comparaison avec le même objet sans masques. Dix positions couvrent les deux côtés à 57°, une inclinaison vers le bas de 57°, vers le haut de 69°, des rotations combinées et une variation de forme nasale. Les branches proches restent entièrement visibles dans les vues latérales de référence, les branches opposées sont masquées, et le pont reste entier dans les deux cas tête baissée. La version précédente échoue au contrôle des branches proches (~73 % conservés contre 100 % après correction). Le test caméra utilise un vrai moteur MediaPipe et une horloge contrôlée uniquement dans la réponse servie au test pour vérifier rétention, expiration, effacement de l'image et récupération, indépendamment de la lenteur du rendu logiciel.

Ces rendus restent synthétiques ; ils n'établissent pas une précision personnelle sur les images du propriétaire. Le rendu tête levée ne doit pas disparaître à cause du masque tant qu'une pose valide existe, mais la visibilité de la monture ne prouve pas que MediaPipe saura produire cette pose à une inclinaison extrême. Une validation avec la webcam réelle reste nécessaire.
