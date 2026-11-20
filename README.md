# [NOM_MARQUE] — harness d'agents IA souverain

Plateforme d'agents IA pour les entreprises et les cabinets comptables africains (RDC d'abord), construite sur
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) **sans modifier son cœur**.
Mission : [`DIRECTIVES.md`](DIRECTIVES.md). Directives d'origine : [`PROMPT_ULTIME_HARNESS.md`](PROMPT_ULTIME_HARNESS.md).
Règles : [`CLAUDE.md`](CLAUDE.md). Versions : [`CHANGELOG.md`](CHANGELOG.md) (actuelle : 0.4.0).

## Ce que fait le produit

Un document arrive (PDF, scan, photo, Word, texte, Excel, CSV). L'application le lit (OCR sur notre serveur),
propose les données d'une facture, **une personne vérifie**, **le code calcule** tout, et la facture est produite
(PDF « Document non fiscal » tant que l'intégration DGI n'est pas validée).

- **Crédits prépayés** : un crédit = une facture générée à partir d'un document ; un échec ou un doublon ne coûte
  rien. Achat en ligne par SasPay (mobile money ou carte). Explication simple : [`docs/guides/credits.md`](docs/guides/credits.md).
- **Factures** : à partir de rapports d'activité et de contrats, de tout document commercial, ou à la main ;
  remise, statut de paiement, recherche, partage par lien expirant, historique.
- **Harness d'agents** : instructions versionnées, base de connaissances avec sources, outils MCP, Gmail,
  Google Sheets, WhatsApp, validation humaine de toute action sortante, routage de modèles avec repli,
  pseudonymisation avant tout envoi externe, suivi de chaque exécution.
- **Organisations isolées** : rôles (propriétaire, admin, opérateur, lecteur, comptable externe), fichiers et
  secrets chiffrés, journal d'audit, export des données.

| Offre | Modèle | Route |
|---|---|---|
| Entrepreneur individuel (`solo`) | DeepSeek (`deepseek-flash`, `deepseek-v4-pro`) | API DeepSeek officielle |
| Entreprise (`entreprise`) | Claude (`claude-haiku-5-5`, `claude-opus-5-5`) | API Anthropic |

Aucun appel ne part vers un fournisseur de modèle sans activation de l'IA et consentement de l'organisation.
Un modèle local (Ollama) est possible : aucune donnée ne sort.

Fonctionnement technique : [`docs/architecture.md`](docs/architecture.md). Crédits et paiements (tables, routes,
exemples) : [`docs/credits-technique.md`](docs/credits-technique.md). Décisions : [`docs/decisions/`](docs/decisions/).

## Mettre en ligne

[`docs/guides/deploiement.md`](docs/guides/deploiement.md) : `cp .env.example .env`, remplir, puis
`docker compose up -d --build` (Caddy + application + PostgreSQL avec pgvector). Les clés des services (IA, SasPay,
Google, WhatsApp) se collent ensuite dans le navigateur : **Administration › Clés API et services**.

## Développer en local

Node ≥ 24.9, Docker, et **pnpm 11.28.5** (version fixée par ce dépôt et par dsh) :

```bash
npm install -g pnpm@11.28.5
```

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
Pour essayer l'application complète sur son ordinateur : `docker-compose.local.yml` et `.env.local.example`.

## Vérifications

| Commande | Ce qu'elle vérifie |
|---|---|
| `pnpm test` | serveur et plugin sur PostgreSQL (base : `pnpm dev:db`) ; intégrations testées contre de faux serveurs locaux |
| `pnpm typecheck` | types TypeScript du serveur, du plugin et de l'interface |
| `pnpm smoke` | le plugin `akili-credits` dans le vrai DeepSeek Harness, sans clé (après chaque montée de version de dsh) |

## Le moteur DeepSeek Harness (parcours local)

Le cœur dsh est un sous-module figé (0.2.2-rc.1), jamais modifié. Pour `pnpm dsh` et `pnpm smoke` :

```bash
git submodule update --init
```

```bash
cd vendor/deepseek-harness && CI=true pnpm install --frozen-lockfile && pnpm run build && cd ../..
```

`CI=true` saute l'installation des hooks git de dsh, qui échoue dans un sous-module. Avec une autre version de pnpm
que 11.28.5, l'installation échoue (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`).

```bash
pnpm credits topup org-demo 100 --ref PAIEMENT-0001
```

```bash
AKILI_ORG_ID=org-demo AKILI_PLAN=solo AKILI_EXTERNAL_MODEL_CONSENT=oui DEEPSEEK_API_KEY=... pnpm dsh web
```

Ce parcours local compte encore ses crédits au jeton (plugin `akili-credits`, ADR 003) ; il n'est pas proposé aux
clients, qui paient par document dans l'application (ADR 007).

## Arborescence

```
apps/server/               API et harness d'agents : auth, organisations, crédits, SasPay, documents, factures,
                           IA, base de connaissances, MCP, connecteurs (Fastify, PostgreSQL)
apps/web/                  interface React selon le design
deploy/                    Caddyfile, image PostgreSQL + pgvector, sauvegarde
docker-compose.yml         production : caddy + app + db
.env.example               tous les réglages du serveur, expliqués
fixtures/                  données fictives : contrats, rapports, documents
vendor/deepseek-harness/   cœur dsh, sous-module figé (0.2.2-rc.1)
plugins/credits/           plugin akili-credits du parcours local dsh
config/akili.patch.yml     surcouche de configuration de dsh
scripts/                   lanceur dsh, test de bout en bout de dsh
docs/                      architecture, guides, décisions (ADR), conceptions et plans
.claude/skills/            skills Superpowers (MIT) pour Claude Code
```

## Licences

DeepSeek Harness : MIT, © DeepSeek (voir `vendor/deepseek-harness/LICENSE`).
Superpowers : MIT, © Jesse Vincent (voir `.claude/skills/SUPERPOWERS-LICENSE`).
