# Notes sur DeepSeek Harness (dsh 0.2.2-rc.1)

Pages lues dans `vendor/deepseek-harness` (commit `fcc0ad4621`) :
`README.md`, `AGENTS.md`, `docs/cordis-tutorial/07-into-the-harness.md`, `docs/user/develop/basic/index.md`,
`docs/cli-help.md`, `docs/cookbook/adding-an-llm-adapter.md`, `packages/llm/README.md`,
`packages/llm/llm-pi-ai/README.md`, `packages/llm/llm-deepseek-api-key/README.md`,
`packages/llm/llm/src/types.ts`, `packages/bundle/base/cordis.patch.yml`, `packages/boot/app-boot/src/profile-context.ts`.

## Modèle de plugin
- Tout est un plugin Cordis : un module qui exporte `name`, `inject` (services attendus) et `apply(ctx, config)`.
- Tout ce qu'un plugin enregistre via `ctx.on()` / `ctx.effect()` est retiré automatiquement au déchargement.
- Composition : une pile de « patches » YAML (bundle de base → profil web/headless → surcouches `--patch`). Une ligne de patch remplace **toute** la `config` de la ligne ciblée (`id`). `!!js` est permis dans `config` et `disabled`.
- Plugin local : `- insert: [{ id, name: '/chemin/absolu/plugin.ts', config }]`. Le chemin doit être absolu. Les sources `.ts` sont chargées par tsx quand dsh tourne depuis les sources.
- Lancement : `dsh <profil> --patch <fichier> [arguments de l'app]` ; `--dump-config` affiche la composition finale.

## Modèles (LLM)
- Service `ctx.llm` ; chaque adaptateur s'enregistre sur une ou plusieurs **routes** (`deepseek-official`, `deepseek-account`, routes pi-ai comme `anthropic`).
- Toute requête passe par l'événement waterfall `llm/stream(options, next)` : un écouteur peut observer, compléter ou court-circuiter le flux. **Il doit appeler `next()`** pour laisser passer l'appel.
- Flux : blocs, puis `usage` (comptes de jetons disjoints : entrée non cachée, sortie, cache lu, cache écrit), puis `finish`. Une erreur se signale par `finish { kind: 'error', failure: { code, message } }` ; le CLI l'affiche `dsh: CODE: message`.
- Clés : par référence d'environnement (`apiKeyEnv`) ou magasin de credentials dsh ; jamais dans le YAML.

## Ce que nous utilisons
- `config/akili.patch.yml` : routes DeepSeek et Anthropic, plugin `akili-credits`, désactivations (ADR 004).
- `plugins/credits` : écouteur `llm/stream` (offre, consentement, prix, solde, débit).

## Pièges rencontrés
- Node ≥ 24.9 exigé (ADR 001).
- `pnpm install` échoue sans accès à `cdn.sheetjs.com`, et l'installation des hooks lefthook échoue dans un sous-module : utiliser `CI=true`.
- `--patch` se place après le nom du profil, avant les arguments de l'app.
- `DSH_TELEMETRY_DISABLED` est appliqué au démarrage, pas visible dans `--dump-config`.
