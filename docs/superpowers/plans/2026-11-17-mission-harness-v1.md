# Mission « harness complet » — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (exécution en ligne). Chaque tâche : test qui échoue, code, `pnpm test` + `pnpm typecheck` verts, commit.

**Spec :** `docs/superpowers/specs/2026-11-17-mission-harness-v1-design.md` · **Branche :** `feat/mission-harness-v1`

## Contraintes globales
Règles 1–12 de `CLAUDE.md`. Aucun secret, aucune donnée réelle. Toute intégration externe testée contre un faux serveur HTTP local, jamais simulée dans le code de production.

## Points de revue
1. Deux traitements simultanés au dernier crédit → un seul débit, solde jamais négatif (`wallet › concurrency`).
2. Échec de génération de facture → solde inchangé (`documents › failure keeps balance`).
3. Webhook rejoué 5 fois → un seul crédit (`saspay › duplicate webhooks`).
4. Visite de l'URL de retour sans paiement → aucun crédit (`saspay › return url`).
5. Requête sortante vers le modèle sans identifiant de la fixture (`ai › pseudonymization`).
6. Organisation A ne voit rien de B, y compris RAG, MCP, connecteurs (`isolation`).

## Tâches
1. Socle : correction du test Windows ; image PostgreSQL avec `pgvector` (dev, CI, production) ; secrets chiffrés ; limitation de débit globale.
2. Économie de crédits : migration portefeuille + registre immuable + reprise ; fonction unique `applyCredit` ; débit atomique avec la facture ; remboursements, allocations, corrections (admin) ; statistiques d'usage ; alerte de solde bas.
3. Paquets + SasPay : administration des paquets ; client SasPay ; achats, webhook, rapprochement ; écrans Crédits et Administration.
4. Documents : nouveaux formats, OCR, extraction libre, revue, génération avec crédit, tests de bout en bout (100 crédits achetés → scan → 99).
5. Factures : factures manuelles, remise, statut de paiement, recherche, partage, historique.
6. IA : fournisseurs, routage, repli, cache, pseudonymisation, traces ; prompts versionnés ; assistant branché.
7. RAG : base de connaissances, ingestion, découpage, recherche hybride, sources.
8. MCP : serveurs, découverte, validation, permissions, approbations.
9. Connecteurs : Google OAuth (Gmail, Sheets), WhatsApp.
10. Observabilité : exécutions, coûts, évaluations, tableaux de bord.
11. Sécurité : revue, tests dédiés.
12. Documentation (technique + économie des crédits pour non-techniciens), version, étiquette.
