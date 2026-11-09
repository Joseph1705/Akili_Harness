# 006 — PostgreSQL, Docker Compose et Caddy pour la production

Date : 2026-11-10 · Statut : appliqué

## Choix
- **PostgreSQL 16** remplace SQLite : plusieurs processus, transactions et verrous (crédits, numérotation, file de tâches avec `SKIP LOCKED`), RLS possible ensuite. Accès par `pg` et une couche fine (`?` → `$n`), sans ORM. Migrations versionnées dans `schema_migrations`, sous verrou consultatif.
- **Docker Compose** : `caddy` (seul exposé, 80/443), `app` (image compilée, utilisateur non root, contrôle de santé qui interroge la base), `db`. Aucune fonction propre à Hostinger : migrable chez n'importe quel hébergeur (directive 4.4).
- **Caddy** : HTTPS automatique. Le domaine vient de `.env` (`APP_DOMAIN`) ; `:80` permet un premier test par IP, autorisé seulement avec `AKILI_ALLOW_HTTP=1`.
- **SMTP** : nodemailer, Gmail (mot de passe d'application) en attendant un fournisseur transactionnel.
- **Plus de mode démo.** Les entreprises ne se créditent plus elles-mêmes : crédits de bienvenue, puis recharges par les administrateurs de la plateforme jusqu'au paiement intégré.

## Vérifié
Suite de tests sur un vrai PostgreSQL 16 ; serveur compilé lancé en mode production ; image construite ; pile complète démarrée (Caddy → app → base, 21 tables créées) ; Caddyfile validé (domaine et IP) ; sauvegarde produite et relisible.

## Reste à faire
RLS PostgreSQL, sauvegardes externes chiffrées (restic), service d'envoi transactionnel, supervision de disponibilité, landing page.
