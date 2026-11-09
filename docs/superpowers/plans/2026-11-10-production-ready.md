# Préparer la production — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Application sans mode démo, sur PostgreSQL, e-mails SMTP, déployable par `docker compose up -d` derrière Caddy.
**Architecture:** `apps/server` passe de `node:sqlite` (synchrone) à `pg` (asynchrone) derrière l'interface `Db` ; toutes les routes deviennent `await`. Docker Compose : `caddy` → `app` → `db`.
**Tech Stack:** PostgreSQL 16, pg 8, nodemailer 7, Caddy 2, Node 24, Docker Compose.
**Spec:** `docs/superpowers/specs/2026-11-10-production-ready-design.md`

## Global Constraints
- Règles 1–12 de `CLAUDE.md`. Aucun secret dans le dépôt (`.env` ignoré, `.env.example` sans valeur secrète).
- Production refuse de démarrer sans : `DATABASE_URL`, `AKILI_MASTER_KEY` (32 octets base64), `AKILI_PUBLIC_ORIGIN` en https, `AKILI_HOSTING_LABEL`, SMTP complet.

## Review Focus
1. Deux validations simultanées de la même facture → une seule, un seul numéro. Test : `invoicing › concurrent validate`.
2. Deux traitements simultanés au dernier crédit → un seul débité. Test : `credits › last credit race`.
3. Une entreprise appelle la recharge de crédits → refusé. Test : `credits › owners cannot top up`.
4. SMTP indisponible → message clair, aucun code en clair dans la réponse. Test : `auth › mail failure`.
5. Bon de commande en double pour une même entreprise → refusé. Test : `clients › duplicate PO`.

---
### Task 1: Couche `Db` PostgreSQL + schéma + migrations — `src/db.ts`, `src/migrations.ts`, `tests/helpers.ts`, `tests/db.test.ts`
### Task 2: Conversion de tous les modules en asynchrone sur `pg` (suite existante verte)
### Task 3: SMTP (nodemailer), suppression du mode démo, crédits de bienvenue, administration plateforme — `tests/auth.test.ts`, `tests/credits.test.ts`, `tests/platform.test.ts`
### Task 4: Clients et contrats (API + interface) — `tests/clients.test.ts`
### Task 5: Interface sans démo, page Administration — vérification navigateur
### Task 6: Docker, Compose, Caddyfile, `.env.example`, CI, guide de déploiement — `docker build` + démarrage réel
