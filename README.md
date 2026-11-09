# [NOM_MARQUE] — harness d'agents IA souverain (prototype)

Plateforme d'agents IA pour les entreprises africaines (RDC d'abord), construite sur
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) **sans modifier son cœur**.
Directives complètes : [`PROMPT_ULTIME_HARNESS.md`](PROMPT_ULTIME_HARNESS.md). Règles : [`CLAUDE.md`](CLAUDE.md).

## L'application

`apps/server` (API, PostgreSQL) et `apps/web` (interface du design) : connexion par code e-mail, inscription d'une entreprise, clients et contrats, agents, dépôt des rapports d'activité, factures calculées par le code et validées par un humain (PDF « Document non fiscal »), crédits (1 crédit = 1 document), administration de la plateforme.

**Mettre en ligne :** [`docs/guides/deploiement.md`](docs/guides/deploiement.md) — `docker compose up -d --build`, le domaine se règle dans `.env`.

**Développer en local :**

```bash
pnpm install
```

```bash
pnpm dev:db
```

```bash
DATABASE_URL=postgresql://akili:akili@127.0.0.1:5432/akili pnpm dev
```

Sans SMTP en développement, le code de connexion s'affiche dans la console du serveur.

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
| `pnpm test` | serveur (auth, isolation, crédits, extraction, factures, SMTP) sur PostgreSQL, et plugin — base : `pnpm dev:db` |
| `pnpm typecheck` | types TypeScript |
| `pnpm smoke` | le plugin dans le vrai DeepSeek Harness, sans clé (à lancer après chaque montée de version de dsh) |

## Arborescence

```
apps/server/               API : auth, organisations, crédits, documents, factures (Fastify, PostgreSQL)
deploy/                    Caddyfile, sauvegarde
docker-compose.yml         production : caddy + app + db
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
