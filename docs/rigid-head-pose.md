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
