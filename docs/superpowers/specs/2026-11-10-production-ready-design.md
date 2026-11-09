# Préparer la production — design (court)

Date : 2026-11-10 · Demande du fondateur : retirer tout ce qui est « démo », passer à PostgreSQL avec un vrai schéma, empaqueter avec Docker, Caddyfile prêt à recevoir le domaine, connexion par SMTP (compte Gmail de test josephprods@gmail.com), tout brancher. Landing page et paiement : plus tard.

## Objectifs
- Plus aucun mode démo : pas de code affiché à l'écran, pas de données de démonstration, pas de libellé « démonstration ».
- PostgreSQL 16 : schéma complet, migrations versionnées, transactions et verrous corrects (crédits, numérotation, file de tâches).
- Envoi des codes de connexion par SMTP (Gmail pour l'instant, mot de passe d'application hors dépôt).
- Ce qu'il faut pour qu'une vraie entreprise travaille sans nous : gérer ses clients et contrats (grilles tarifaires) dans l'interface.
- Crédits : une entreprise ne peut plus se créditer elle-même. Crédits de bienvenue configurables ; recharges faites par un administrateur de la plateforme (nous) en attendant le paiement.
- Docker Compose (Caddy + application + PostgreSQL), Caddyfile piloté par variables : on tape le domaine dans `.env`, rien d'autre.

## Non-objectifs
Landing page, paiement, sauvegardes externes chiffrées (restic), RLS PostgreSQL (l'isolation reste dans le code et les tests ; RLS = étape suivante).

## Approches
1. **`pg` (node-postgres) avec une petite couche maison** (`?` → `$n`, transactions explicites) — **choisie** : pas d'ORM à apprendre, SQL lisible, contrôle des verrous.
2. ORM (Prisma/Drizzle) : migrations générées, mais réécriture complète des requêtes et dépendance lourde pour un gain faible aujourd'hui.
3. Garder SQLite : simple, mais un seul processus, pas de RLS, contraire à la directive 4.3.

## Choix de construction (les miens)
- Tests sur un vrai PostgreSQL (un schéma isolé par test), via `AKILI_TEST_DATABASE_URL`.
- E-mails : nodemailer ; en développement sans SMTP, le code s'écrit dans la console du serveur uniquement.
- Image Docker multi-étapes, serveur compilé en JavaScript, utilisateur non root.
- Développement local : `docker-compose.dev.yml` (PostgreSQL + Mailpit pour voir les e-mails).
