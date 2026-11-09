# [NOM_MARQUE] — harness d'agents IA souverain (prototype)

Plateforme d'agents IA pour les entreprises africaines (RDC d'abord), construite sur
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) **sans modifier son cœur**.
Directives complètes : [`PROMPT_ULTIME_HARNESS.md`](PROMPT_ULTIME_HARNESS.md). Règles : [`CLAUDE.md`](CLAUDE.md).

## Démonstration en une commande

```bash
pnpm demo --build
```

Puis http://localhost:3000, connexion avec `mireille.kabange@kibala.example` (le code s'affiche à l'écran en mode démo). Déroulé de présentation : [`docs/guides/presentation-demo.md`](docs/guides/presentation-demo.md).

L'application (`apps/server` + `apps/web`) suit le design fourni : connexion par code e-mail, onboarding, activité du jour, sessions, validation des factures, packs, crédits, paramètres, à propos — en clair et en sombre. Les rapports d'activité fictifs (`fixtures/`) deviennent des projets de facture calculés par le code, contrôlés, validés par un humain, exportés en PDF « Document non fiscal ».

## Ce que fait le prototype

| Offre | Modèle | Route |
|---|---|---|
| Entrepreneur individuel (`solo`) | DeepSeek (`deepseek-flash`, `deepseek-v4-pro`) | API DeepSeek officielle |
| Entreprise (`entreprise`) | Claude Opus 5.5 (`claude-opus-5-5`) | API Anthropic |

Facturation par **crédits prépayés** : chaque appel de modèle est débité selon les jetons consommés,
le prix publié du fournisseur et la marge ; à solde épuisé, les appels sont refusés jusqu'à la recharge.
Aucun appel ne part sans consentement de l'organisation. Détails : [`docs/decisions/`](docs/decisions/).

## Installation

Node ≥ 24.9 et pnpm.

```bash
git submodule update --init
```

```bash
cd vendor/deepseek-harness && CI=true pnpm install --frozen-lockfile && pnpm run build && cd ../..
```

```bash
pnpm install
```

## Utilisation

```bash
pnpm credits topup org-demo 100 --ref PAIEMENT-0001
```

```bash
AKILI_ORG_ID=org-demo AKILI_PLAN=solo AKILI_EXTERNAL_MODEL_CONSENT=oui DEEPSEEK_API_KEY=... pnpm dsh web
```

Offre Entreprise : `AKILI_PLAN=entreprise` et `ANTHROPIC_API_KEY`, puis choisir Claude Opus 5.5 dans le sélecteur de modèle.
Solde et historique : `pnpm credits balance org-demo`, `pnpm credits history org-demo`.

## Vérifications

| Commande | Ce qu'elle vérifie |
|---|---|
| `pnpm test` | serveur (auth, isolation, crédits, extraction, factures) et plugin, sans réseau |
| `pnpm typecheck` | types TypeScript |
| `pnpm smoke` | le plugin dans le vrai DeepSeek Harness, sans clé (à lancer après chaque montée de version de dsh) |

## Arborescence

```
apps/server/               API : auth, organisations, crédits, documents, factures (Fastify, SQLite)
apps/web/                  interface React selon le design
fixtures/                  données fictives : contrats et rapports d'activité
vendor/deepseek-harness/   cœur dsh, sous-module figé (0.2.2-rc.1)
plugins/credits/           plugin akili-credits : offres, crédits, consentement
config/akili.patch.yml     surcouche de configuration de dsh
scripts/                   lanceur dsh, test de bout en bout
docs/decisions/            décisions d'architecture (ADR)
.claude/skills/            skills Superpowers (MIT) pour Claude Code
```

## Licences

DeepSeek Harness : MIT, © DeepSeek (voir `vendor/deepseek-harness/LICENSE`).
Superpowers : MIT, © Jesse Vincent (voir `.claude/skills/SUPERPOWERS-LICENSE`).
