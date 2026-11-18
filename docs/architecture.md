# Architecture technique (version 0.3.0)

Pour qui : les développeurs et l'équipe technique. Les règles absolues sont dans [`CLAUDE.md`](../CLAUDE.md),
les décisions dans [`docs/decisions/`](decisions/), la mission dans [`DIRECTIVES.md`](../DIRECTIVES.md).
Pour les crédits expliqués simplement : [`docs/guides/credits.md`](guides/credits.md).

## Vue d'ensemble

```
Navigateur ──HTTPS──▶ Caddy ──▶ app (Fastify : API /api + interface React)
                                 │   └─ worker en tâche de fond (même processus) : documents, base de
                                 │      connaissances, rapprochement des paiements, rétention
                                 ├──▶ PostgreSQL 16 + pgvector (toutes les données, isolées par org_id)
                                 ├──▶ /data/blobs (fichiers chiffrés AES-256-GCM, une clé par organisation)
                                 └──▶ services externes, seulement s'ils sont configurés :
                                      SMTP · SasPay · Anthropic / DeepSeek / modèle local · Google · WhatsApp (Meta)
                                      · serveurs MCP des organisations · ClamAV
```

- **Production** : `docker compose up -d --build` (guide : [`guides/deploiement.md`](guides/deploiement.md)).
  Réglages : [`.env.example`](../.env.example).
- **DeepSeek Harness** (`vendor/deepseek-harness`, figé en 0.2.2-rc.1) n'est pas modifié. Il sert au parcours
  local `pnpm dsh` avec notre plugin `plugins/credits` et la surcouche `config/akili.patch.yml`. Le harness
  d'agents de l'application est écrit dans `apps/server` (ADR 008).

## Code du serveur (`apps/server/src`)

| Dossier / fichier | Rôle |
|---|---|
| `app.ts`, `routes.ts`, `config.ts`, `main.ts` | démarrage, en-têtes de sécurité, contrôle d'origine (CSRF), routes, réglages lus et vérifiés au démarrage |
| `db.ts`, `migrations.ts` | accès PostgreSQL (`?` → `$n`), transactions, migrations versionnées |
| `auth/`, `sessions/`, `orgs/` | connexion par code e-mail, sessions révocables, organisations, rôles, consentements, membres |
| `storage/` | fichiers chiffrés, type lu dans les octets (jamais dans le nom) |
| `documents/` | dépôt, lecture (PDF, Word, Excel, CSV, texte), OCR local, extraction, revue, génération de facture |
| `invoicing/` | clients, contrats, calcul en entiers, numérotation sans trou, PDF « Document non fiscal », partage |
| `billing/` | portefeuille et registre de crédits (`wallet.ts`), SasPay (`saspay.ts`, `payments.ts`) |
| `credits.ts`, `platform.ts` | écrans Crédits et Administration (paquets, allocations, remboursements, corrections, coûts IA, évaluations) |
| `ai/` | routage des modèles, prompts versionnés, pseudonymisation, cache, outils, validations humaines, traces |
| `knowledge/` | base de connaissances : ingestion, découpage, recherche hybride |
| `mcp/` | serveurs MCP distants : découverte, validation, appels |
| `connectors/` | Google (Gmail, Sheets) et WhatsApp Business Platform |
| `security/` | chiffrement, secrets, protection SSRF, antivirus, garde-fous contre l'injection de prompt |
| `jobs.ts`, `maintenance.ts`, `audit.ts` | file de tâches (`SKIP LOCKED`), rétention, journal d'audit |

L'interface (`apps/web`) est une application React servie par le même serveur ; elle n'appelle que `/api`.

## Les parcours principaux

### 1. Un document devient une facture

1. Dépôt : type vérifié dans les octets, taille limitée (15 Mo), antivirus si configuré, fichier chiffré.
2. Une tâche de fond lit le document : texte, tableaux, OCR des scans et photos (tesseract.js, sur le serveur ;
   aucun document ne sort pour être lu). S'il n'y a plus de crédit, le document attend sans être lu.
3. Deux cas :
   - **rapport d'activité** avec un bon de commande connu → brouillon de facture au prix du contrat ;
   - **autre document** → champs proposés (par le modèle si l'organisation l'a activé, sinon par lecture
     heuristique) → statut « à vérifier » → la personne corrige → « Générer la facture ».
4. Le code recalcule tout (montants en centimes entiers, TVA, remise) et signale les écarts avec les totaux lus.
5. La facture et le débit d'**un crédit** sont écrits dans **la même transaction** : si l'une échoue, rien n'est
   débité. La clé d'opération `document:<id>` empêche tout double débit.
6. Validation humaine → numéro définitif FAC-AAAA-NNNN → PDF « Document non fiscal » (règle 8).

### 2. Les crédits

- Table `credit_wallets` (une ligne par organisation, solde ≥ 0 par contrainte) et `credit_transactions`
  (registre en ajout seul : mise à jour et suppression refusées par déclencheur PostgreSQL).
- Toute opération passe par `applyCredit` (`billing/wallet.ts`) : verrou `FOR UPDATE` sur le portefeuille,
  idempotence par clé d'opération, refus sous zéro, écriture du registre dans la transaction de l'appelant.
- Types : `purchase`, `consumption`, `refund`, `admin_allocation`, `admin_correction`. Une erreur se corrige par
  une écriture inverse. Détail pour non-techniciens : [`guides/credits.md`](guides/credits.md) ; décision : ADR 007.

### 3. L'achat de crédits (SasPay)

1. L'organisation choisit un paquet actif ; une ligne `payments` est créée (idempotente) puis une session de
   paiement hébergée SasPay (`POST /checkout-sessions/`) pour le prix exact du paquet.
2. Le client paie sur SasPay (mobile money ou carte).
3. Les crédits ne sont ajoutés qu'après `GET /checkout-sessions/{id}/status/` : `PAID`, transaction `SUCCESS`,
   même montant, même devise. Clé `payment:<id>` : jamais deux fois.
4. Le webhook (`POST /api/webhooks/saspay`, signature HMAC-SHA256, fenêtre de 300 s) répond tout de suite et
   déclenche cette vérification en arrière-plan (il ne désigne aucune session). La page de retour la déclenche aussi.
   Le worker revérifie les paiements ouverts toutes les 3 minutes, les plus récents d'abord. Les sessions SasPay
   expirent après 48 h (`expires_at`) ; après 72 h, un dernier contrôle précède la fermeture de notre côté, et un
   paiement fermé reste revérifiable : de l'argent encaissé par SasPay est toujours crédité.
5. Sans `SASPAY_API_KEY` : achat refusé avec un message, jamais simulé.

### 4. Une réponse d'agent (harness IA)

1. **Accès** : IA activée par l'organisation ; pour un fournisseur externe, consentement enregistré (règle 5) ;
   plafond mensuel de jetons par organisation.
2. **Prompt** : règles de la plateforme d'abord (non retirables), puis la version active des instructions
   de l'agent (identité, instructions, style, restrictions).
3. **Connaissances** : recherche avant de répondre ; passages numérotés, encadrés comme données non fiables.
4. **Modèle** : niveau léger ou lourd selon la tâche ; ordre des fournisseurs selon l'offre (Entreprise : Claude
   d'abord ; Entrepreneur : DeepSeek d'abord), puis les autres configurés ; un fournisseur en échec est sauté.
5. **Pseudonymisation** avant tout envoi externe (identité de l'organisation, clients, personnes connues, NIF,
   RCCM, e-mails, téléphones, comptes), restitution au retour. C'est une pseudonymisation, pas une anonymisation.
6. **Outils** : intersection des outils de l'agent, des connecteurs branchés et des droits de la personne ;
   au plus 5 tours et 8 appels ; un outil sensible (envoi, écriture) crée une **demande de validation**
   exécutée une seule fois après accord d'une personne autorisée (expire après 7 jours).
7. **Trace** : chaque exécution et ses étapes (recherche, garde-fous, appels, replis, outils), jetons, durée,
   coût interne, erreurs. Extraits pseudonymisés, tronqués, effacés après `AKILI_AI_LOG_RETENTION_DAYS`.
8. **Cache** chiffré par organisation, pour l'extraction de documents seulement (jamais les conversations).

### 5. Base de connaissances (RAG)

Ingestion en tâche de fond (texte, Word, PDF, scans par OCR), nettoyage, passages d'environ 900 caractères
coupés aux titres et paragraphes. Recherche plein texte PostgreSQL toujours active, vecteurs `pgvector` quand
un service d'embeddings est configuré et autorisé, fusion des rangs (RRF). Sources citées. Chaque requête est
limitée à une organisation.

### 6. MCP et connecteurs

- **MCP** : serveurs distants HTTP seulement, client protégé contre le SSRF (adresses privées, métadonnées
  cloud, redirections refusées), outils découverts **désactivés par défaut**, arguments validés contre le schéma
  de chaque outil, rôle minimal par outil, validation humaine pour les outils sensibles.
- **Google** : OAuth 2.0 avec PKCE et `state` à usage unique ; jetons chiffrés ; Gmail (lecture, envoi après
  validation), Sheets (ajout de lignes, sans injection de formules). Redirection : `/api/connectors/google/callback`.
- **WhatsApp** (API Cloud officielle de Meta) : webhook `/api/webhooks/whatsapp` vérifié par
  `X-Hub-Signature-256` ; messages stockés une fois ; réponses envoyées ou validées par une personne.
- Sans identifiants : « non configuré », jamais simulé.

## Sécurité

| Sujet | Mesure |
|---|---|
| Isolation | `org_id` dans chaque requête ; tests d'isolation sur chaque fonctionnalité (`isolation.test.ts`, `security.test.ts`) |
| Rôles | propriétaire, admin, opérateur, lecteur, comptable externe (`auth/context.ts`, table `CAN`) ; un agent n'a jamais plus de droits que la personne |
| Chiffrement | fichiers et secrets en AES-256-GCM, clé par organisation dérivée de `AKILI_MASTER_KEY` (HKDF-SHA256) |
| Requêtes | contrôle d'origine (CSRF), en-têtes stricts, limitation de débit (en mémoire, un serveur) |
| Contenu non fiable | documents, e-mails, messages, passages et résultats d'outils sont des données, jamais des instructions (règle 9) |
| Argent | montants calculés par le code en entiers (règle 6) ; registre de crédits immuable ; journal d'audit |
| Rétention | codes, sessions, caches expirés supprimés ; extraits IA effacés après 90 jours par défaut ; historique financier jamais supprimé |
| Données | export complet d'une organisation ; retrait d'un membre qui coupe ses sessions |

## Vérifications

| Commande | Ce qu'elle prouve |
|---|---|
| `pnpm test` | tout le serveur et le plugin, sur PostgreSQL (`pnpm dev:db`), chaque test dans son propre schéma ; les intégrations externes sont testées contre de faux serveurs HTTP locaux |
| `pnpm typecheck` | types du serveur, du plugin et de l'interface |
| `pnpm smoke` | le plugin `akili-credits` dans le vrai DeepSeek Harness, sans clé (après chaque montée de version de dsh) |

La CI (`.github/workflows/ci.yml`) lance l'installation, les types, les tests et la construction sur chaque envoi.
