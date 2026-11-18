# 008 — Le harness d'agents IA est écrit dans l'application

Date : 2026-11-17 · Statut : appliqué (version 0.3.0) · Prolonge l'ADR 005

## Contexte
`DIRECTIVES.md` §3 demande un vrai harness d'agents : prompts configurables, base de connaissances, MCP,
connecteurs Google et WhatsApp, garde-fous, routage de modèles avec repli, observabilité — pour plusieurs
organisations isolées les unes des autres, sur un serveur partagé.

## Options
1. **Modules TypeScript dans `apps/server`** (fournisseurs, routage, RAG, MCP, garde-fous, traces), sur PostgreSQL.
2. Faire tourner DeepSeek Harness comme moteur par session : dsh est mono-utilisateur (stockage, bac à sable et
   shell locaux) et en préversion ; l'isolation entre organisations serait à reconstruire autour.
3. Bibliothèque d'agents tierce (LangChain…) : dépendance lourde, peu de contrôle sur ce qui part vers les fournisseurs.

## Choix
Option 1. Le cœur dsh reste figé et non modifié (règle 1) ; il sert au parcours local `pnpm dsh`.

## Conséquences
- Rien ne part vers un fournisseur sans activation et consentement de l'organisation (règle 5) ; pseudonymisation
  avant tout envoi externe ; montants toujours calculés par le code (règle 6) ; actions sortantes validées par une
  personne (règle 7) ; contenus reçus traités comme des données (règle 9).
- Fournisseurs : Anthropic (SDK officiel), DeepSeek (API compatible OpenAI), modèle local (Ollama ou compatible).
- MCP en HTTP distant seulement : pas de processus lancé sur notre serveur pour un client.
- Nous maintenons ce code nous-mêmes : chaque intégration est testée contre un faux serveur HTTP local.
- Description : [`docs/architecture.md`](../architecture.md).
