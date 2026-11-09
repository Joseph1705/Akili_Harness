# 005 — Application à nous au-dessus de DeepSeek Harness

Date : 2026-11-09 · Statut : appliqué pour la démonstration, à valider

## Contexte
Le fondateur présente le produit demain. Il faut le design fourni (6 écrans), une vraie connexion, l'isolation par organisation et le flux du client 1 (rapport → facture validée).

## Options
1. Retoucher l'interface web de dsh par plugins client : conforme à la règle 1, mais l'interface dsh est pensée pour le code ; impossible d'obtenir les écrans du design en un jour.
2. **Application à nous** (`apps/server` + `apps/web`), structure prévue par la directive 4.2, dsh restant le moteur d'agent (assistant via son SDK, étape suivante).
3. Maquette statique : ne prouve rien.

## Choix
Option 2. Le cœur dsh n'est pas modifié. Le calcul des factures est fait par du code déterministe (règle 6) : la démonstration marche sans clé API ni réseau.

## Conséquences
- SQLite (`node:sqlite`) derrière un module unique, PostgreSQL + RLS en phase 1.
- Fichiers chiffrés AES-256-GCM, clé par organisation dérivée d'une clé maître (`AKILI_MASTER_KEY`).
- L'assistant répond aux commandes ; les questions libres passeront par dsh (DeepSeek ou Claude Opus 5.5 selon l'offre) quand une clé et le consentement seront présents.
- Numérotation officielle FAC-AAAA-NNNN attribuée à la validation (pas de trou), brouillons P-AAAA-NNNN.
