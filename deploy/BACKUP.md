# Sauvegarde S3 — Lunette Caba

Ces instructions ciblent le déploiement actuel : `/home/ubuntu/tryit`, service `tryit`, secrets dans `/etc/tryit.env`, site Nginx `tryit-elastic`.

## Contenu et cohérence

La sauvegarde lit une seule version de `data/catalog.json`, écrit atomiquement par l'application, puis copie uniquement les photos et GLB référencés. Les fichiers uploadés sont immuables et ne sont pas supprimés par l'application. Cette hypothèse permet de sauvegarder sans interrompre le site. Si une purge de fichiers ou une modification en place est introduite, revoir cette stratégie. Les sessions et fichiers orphelins sont exclus. L'archive contient aussi le fichier d'environnement, l'unité systemd et la configuration Nginx, ainsi que le commit Git du code à réinstaller. Elle ne contient ni `node_modules`, ni les clés TLS (réémettre les certificats avec Certbot en cas de reconstruction).

Les archives contiennent des secrets. Elles restent privées (répertoire local 700, archive 600), et sont chiffrées côté S3 avec SSE-S3. Ne jamais les joindre à un ticket, au chat ou à Git. Aucun chiffrement client n'est prétendu. Les archives dont le transfert échoue restent localement pour diagnostic ; surveiller l'espace disque.

## Prérequis AWS (administrateur du compte)

1. Créer un bucket S3 **dédié**, type General purpose, dans `eu-north-1` (Stockholm). Garder **Block all public access**, Object Ownership **Bucket owner enforced**, chiffrement **SSE-S3**. Cette procédure suppose que le versionnement est désactivé : les clés d'archive sont uniques. Si le versionnement est activé, prévoir aussi une règle pour les versions non courantes.
2. Créer une stratégie IAM depuis `backup-iam-policy.json` en remplaçant `YOUR_BACKUP_BUCKET`. Elle autorise l'écriture, la lecture nécessaire à la vérification et l'abandon multipart uniquement sous `daily/`, sans suppression d'objets.
3. Attacher cette stratégie au rôle IAM existant de l'instance, ou créer un rôle de confiance **AWS service → EC2** et l'attacher via EC2 → Actions → Security → Modify IAM role. Préserver les autres permissions nécessaires au serveur. Ne pas utiliser de clés d'accès statiques ni `aws configure`.
4. Dans S3 → Management → Lifecycle, créer une règle limitée au préfixe `daily/`, avec expiration à 30 jours et abandon des transferts multipart incomplets après un jour. Équivalent JSON : `backup-lifecycle.json`. Ne pas remplacer une configuration de cycle de vie existante sans la préserver. Le tarif S3 dépend du volume et des requêtes.

## Installation sur EC2

Après avoir configuré le bucket et le rôle IAM, depuis le compte Ubuntu :

```bash
cd ~/tryit
git pull --ff-only origin main
sudo apt update
sudo apt install -y python3-venv
sudo python3 -m venv /opt/tryit-backup-tools
sudo /opt/tryit-backup-tools/bin/pip install awscli
sudo install -m 0644 scripts/backup.py /usr/local/lib/tryit-backup.py
sudo install -d -m 0700 /var/lib/tryit-backup
sudo install -m 0644 deploy/tryit-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/tryit-backup.timer /etc/systemd/system/
```

Créer `/etc/tryit-backup.env` (root, permissions 600) avec **uniquement** :

```text
BACKUP_BUCKET=YOUR_BACKUP_BUCKET
AWS_DEFAULT_REGION=eu-north-1
```

Le CLI officiel AWS est installé dans un environnement Python isolé. Les identifiants temporaires proviennent automatiquement du rôle EC2. Si IMDS a été désactivé, le réactiver avec **IMDSv2 required** pour permettre cette authentification.

Tester d'abord une sauvegarde complète (upload puis lecture de l'objet S3 pour en vérifier le SHA-256) :

```bash
sudo systemctl daemon-reload
sudo systemctl start tryit-backup.service
sudo journalctl -u tryit-backup.service -n 30 --no-pager
```

N'activer le planning qu'après le message `S3 backup uploaded and verified` et une sortie réussie :

```bash
sudo systemctl enable --now tryit-backup.timer
systemctl list-timers tryit-backup.timer --all
```

Exécution à 02:00 UTC (03:00 Africa/Lagos), avec délai aléatoire jusqu'à 15 minutes. `Persistent=true` rattrape une exécution manquée quand le serveur redémarre. Consulter régulièrement `systemctl status tryit-backup.service` et les objets S3 : aucune alerte email n'est configurée. Ce timer n'allume pas une instance EC2 arrêtée.

## Vérification et restauration

Les tests locaux utilisent des données factices, restaurent une archive et comparent les fichiers ; ils vérifient aussi le rejet d'une archive altérée, des fichiers manquants et des chemins dangereux :

```bash
python3 -m unittest discover -s test -p 'test_backup.py' -v
```

Pour une restauration réelle, travailler d'abord dans un répertoire neuf et privé :

1. Télécharger l'archive choisie et son fichier `.sha256` depuis S3 avec le rôle autorisé. Utiliser le CLI `/opt/tryit-backup-tools/bin/aws` sur cette instance. Ne pas afficher le contenu du fichier d'environnement.
2. Exécuter `sudo python3 /usr/local/lib/tryit-backup.py verify /chemin/nom.tar.gz`. Si la vérification échoue, ne pas extraire.
3. Extraire dans un répertoire vide, privé, avec Python `tarfile.extractall(..., filter='data')` après vérification. Le contenu est sous `snapshot/`, et `manifest.json` indique le commit et les chemins d'origine des paramètres.
4. Vérifier les fichiers sur une instance de test avant de toucher au site. En cas de bascule : conserver la situation actuelle, arrêter `tryit`, restaurer `data/catalog.json` et les fichiers `uploads/` ensemble ; rétablir les propriétaires/permissions pour l'utilisateur Ubuntu. Restaurer les paramètres seulement si nécessaire et protéger `/etc/tryit.env` en 600 root.
5. Réinstaller le commit enregistré et ses dépendances, adapter Nginx au domaine/IP actuel, réémettre HTTPS si nécessaire, puis redémarrer. Contrôler `/api/products`, la connexion admin et un produit avec fichiers. Ne jamais restaurer les anciennes sessions.

L'upload, la politique IAM, le timer et la restauration sur EC2 ne sont pas validés par les tests locaux. Il faut une première exécution S3 réussie avant de déclarer la sauvegarde active.
