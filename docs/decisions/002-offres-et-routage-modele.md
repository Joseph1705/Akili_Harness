# 002 — Deux offres, deux modèles : routage par l'API des fournisseurs

Date : 2026-11-09 · Statut : proposé

## Contexte
Demande du fondateur : offre **Entrepreneur individuel** (solo) sur DeepSeek, offre **Entreprise** sur Claude Opus 5.5. Question posée : faut-il un MCP ou une API ?

## Réponse : API, pas MCP
MCP sert à donner des **outils** à un agent (connecteurs, sources de données). Le choix du **modèle** passe par les adaptateurs LLM de dsh, qui appellent l'API de chaque fournisseur. dsh en fournit déjà deux, utilisables par configuration seule (règle 1) :

| Offre | Route dsh | Adaptateur (déjà dans dsh) | Modèle |
|---|---|---|---|
| solo | `deepseek-official` | `@deepseek-ai/dsh-llm-deepseek-api-key` | `deepseek-flash`, `deepseek-v4-pro` |
| entreprise | `anthropic` | `@deepseek-ai/dsh-llm-pi-ai` (bibliothèque pi-ai 1.3.0) | `claude-opus-5-5` |

Le catalogue pi-ai 1.3.0 décrit déjà `claude-opus-5-5` (réflexion adaptative forcée, 1 M de contexte, 128 k en sortie), ce qui couvre les changements d'API propres à ce modèle.

## Application de la règle
Le plugin `akili-credits` écoute l'événement `llm/stream` (tout appel de modèle y passe : agent, titres, compactage, sous-agents) et refuse avant tout envoi un appel dont la route n'appartient pas à l'offre (`PLAN_ROUTE_FORBIDDEN`). La route « compte DeepSeek personnel » (`llm-deepseek-account`) est désactivée : elle facturerait hors de nos crédits.

## Conséquences et points ouverts
- L'offre est lue dans la config (`AKILI_PLAN`) pour le prototype ; en phase 1 elle viendra de la licence de l'organisation.
- Le sélecteur de modèle de l'interface propose encore tous les modèles ; l'utilisateur Entreprise doit choisir Claude Opus 5.5. À masquer par plugin d'interface plus tard.
- Pas encore testé contre les vraies API (pas de clés dans cet environnement).
- Repli en cas de refus du modèle (`stop_reason: refusal`) : non géré par pi-ai à vérifier ; un adaptateur Anthropic à nous (SDK officiel) reste possible si besoin.
- **Pseudonymisation (section 4.6) absente du prototype** : en l'état, l'offre Entreprise envoie les documents en clair à Anthropic. Le consentement doit le dire tant que la phase 3 n'est pas faite.
- Lien avec les offres Standard / Souverain de la directive (mode de données) : à clarifier, voir questions ouvertes.
