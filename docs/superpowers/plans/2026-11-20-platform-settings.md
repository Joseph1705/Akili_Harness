# Clés API et services depuis l'interface — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un onglet Administration › Clés API et services où un opérateur de la plateforme colle les clés des services, chiffrées en base et appliquées sans redémarrage.

**Architecture:** `readServices(env)` (extrait de `loadConfig`) calcule la configuration des services à partir d'une table de variables ; les valeurs de l'écran (table `platform_settings`, chiffrées) sont fusionnées par-dessus `config.baseEnv` puis copiées en place dans `app.deps.config`, que tous les modules relisent à chaque requête.

**Tech Stack:** Fastify 5, PostgreSQL 16, zod, AES-256-GCM (`sealSecret`), React (Vite), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-platform-settings-design.md` · **Branche :** `feat/platform-settings`

## Global Constraints

- Règles 1–12 de `CLAUDE.md`. Aucun secret ni donnée réelle dans le code, les tests, les journaux, les e-mails.
- Seules les adresses de `AKILI_PLATFORM_ADMINS` voient ces routes ; pour les autres : 404 (comme `/api/platform`).
- Une valeur secrète ne sort jamais du serveur ; indice = `…` + 4 derniers caractères, seulement si la valeur fait ≥ 16 caractères.
- Clés acceptées : uniquement celles du catalogue (jamais `AKILI_PLATFORM_ADMINS`, `DATABASE_URL`, `*_EXTERNAL`, `*_BASE_URL` des modèles).
- `SASPAY_BASE_URL` ∈ { `https://api.saspay.me/api/v1` (réel), `https://sandbox-api.saspay.me/api/v1` (bac à sable) }.
- Textes de l'interface et messages d'erreur en français simple.
- Chaque tâche : test qui échoue, code, `pnpm test` + `pnpm typecheck` verts, commit.

## Review Focus

1. Clé collée avec espaces ou retour à la ligne final (copie depuis une console web) → enregistrée sans les espaces ; un retour à la ligne au milieu est refusé. (Tâche 1)
2. Clé hors catalogue envoyée à l'API (`AKILI_PLATFORM_ADMINS`, `AKILI_LOCAL_MODEL_EXTERNAL`) ou clé d'une autre section → 400, rien n'est enregistré. (Tâche 1)
3. Base restaurée sur un serveur dont la clé maître diffère (valeurs illisibles) → le serveur démarre, ignore ces valeurs et l'écran le signale. (Tâche 1)
4. Mauvais nom de modèle ou clé refusée → « Tester » le dit en clair (clé refusée / modèle inconnu), sans erreur 500. (Tâche 2)
5. Enregistrer un formulaire sans rien changer → aucune écriture, ni audit, ni e-mail. (Tâche 1)

---

### Task 1: Réglages enregistrés, appliqués à chaud (serveur)

**Files:**
- Modify: `apps/server/src/config.ts` (extraire `readServices`, ajouter `baseEnv`)
- Modify: `apps/server/src/migrations.ts` (version 6 : `platform_settings`)
- Create: `apps/server/src/settings/catalog.ts` (sections, champs, contrôles en français)
- Create: `apps/server/src/settings/store.ts` (lecture, chiffrement, application, état de chargement)
- Create: `apps/server/src/settings/routes.ts` (GET, PUT)
- Modify: `apps/server/src/auth/context.ts` (`platformAdminOf`), `apps/server/src/platform.ts` (l'utiliser), `apps/server/src/app.ts` (charger au démarrage), `apps/server/src/routes.ts` (monter sous `/platform/settings`)
- Test: `apps/server/tests/platform-settings.test.ts`

**Interfaces:**
- Produces:
  - `config.ts` : `interface ServiceConfig { brand; supportEmail; signupCredits; models; saspay; ai; connectors }` (mêmes types que `Config`) ; `readServices(env: NodeJS.ProcessEnv, production: boolean): ServiceConfig` (lève `Error('config: …')` comme aujourd'hui) ; `Config.baseEnv: Readonly<NodeJS.ProcessEnv>`.
  - `auth/context.ts` : `platformAdminOf(request: FastifyRequest, config: Config): User` (404 `notFound('Page')` sinon).
  - `settings/catalog.ts` : `type SectionId = 'anthropic' | 'deepseek' | 'other_model' | 'embeddings' | 'saspay' | 'google' | 'whatsapp' | 'platform'` ; `SECTIONS: readonly SettingSection[]` ; `SettingField { key; label; kind: 'secret' | 'text' | 'url' | 'email' | 'int' | 'select'; help?; placeholder?; options?; min?; max?; pattern? }` ; `SettingSection { id; title; description; fields; testable; check?(env): string | null }` ; `normalizeChanges(section, values: Record<string, string | null>): Map<string, string | null>` (lève `badRequest`).
  - `settings/store.ts` : `loadStored(db, config): Promise<{ values: Record<string, string>; meta: Record<string, { updatedAt: string; updatedBy: string | null }>; unreadable: string[] }>` ; `applySettings(config, values, unreadable): void` (section par section, garde l'état des refus) ; `reloadSettings(deps: { db; config }): Promise<void>` ; `settingsState(config): { rejected: Map<SectionId, string> }`.
  - HTTP : `GET /api/platform/settings` → `{ sections: SectionView[] }` ; `PUT /api/platform/settings/:section` corps `{ values: Record<string, string | null> }` → `{ section: SectionView }`.
  - `SectionView = { id; title; description; testable; status: 'on' | 'off' | 'error'; statusText; urls: Array<{ label; value }>; fields: Array<{ key; label; kind; help; placeholder; options; source: 'screen' | 'env' | 'none'; value: string | null; hint: string | null; updatedAt: string | null; updatedBy: string | null }> }` (`value` pour les champs non secrets, `hint` pour les secrets).

Catalogue (clé → type) : anthropic `ANTHROPIC_API_KEY` secret, `AKILI_ANTHROPIC_MODEL_LIGHT|HEAVY` text ; deepseek `DEEPSEEK_API_KEY` secret, `AKILI_DEEPSEEK_MODEL_LIGHT|HEAVY` ; other_model `AKILI_LOCAL_MODEL_URL` url, `AKILI_LOCAL_MODEL_KEY` secret, `AKILI_LOCAL_MODEL_HEAVY|LIGHT` text (URL ⇒ HEAVY) ; embeddings `AKILI_EMBEDDINGS_URL` url, `AKILI_EMBEDDINGS_KEY` secret, `AKILI_EMBEDDINGS_MODEL` text (URL ⇒ MODEL) ; saspay `SASPAY_API_KEY` secret, `SASPAY_WEBHOOK_SECRET` secret, `SASPAY_BASE_URL` select ; google `GOOGLE_CLIENT_ID` text, `GOOGLE_CLIENT_SECRET` secret (les deux ou aucun) ; whatsapp `WHATSAPP_APP_SECRET` secret, `WHATSAPP_VERIFY_TOKEN` text, `WHATSAPP_GRAPH_VERSION` text `^v\d+\.\d+$` (secret + jeton ou aucun) ; platform `AKILI_BRAND_NAME` text ≤ 60, `AKILI_SUPPORT_EMAIL` email, `AKILI_SIGNUP_CREDITS` int 0–10000. Testables : anthropic, deepseek, other_model, embeddings, google.

- [ ] **Step 1: Write the failing tests** in `platform-settings.test.ts` (`createTestApp({ AKILI_PLATFORM_ADMINS: OPS, … })`, owner = `onboardedOwner`):
  - `is invisible to anyone who is not a platform operator` : owner GET et PUT → 404.
  - `lists every service and where each value comes from, never a secret` : env `DEEPSEEK_API_KEY='sk-deepseek-from-env-1234567890'` → ids des 8 sections dans l'ordre ci-dessus ; champ `DEEPSEEK_API_KEY` : `source 'env'`, `hint '…7890'`, `value null` ; `res.body` ne contient pas la clé ; section saspay a l'URL `${ORIGIN}/api/webhooks/saspay`.
  - `a pasted key works at once, is encrypted at rest and survives a restart` : PUT saspay `{ SASPAY_API_KEY: '  sk_test_screen_key_0123456789\n', SASPAY_BASE_URL: sandbox }` → 200, `t.config.saspay` = `{ apiKey: 'sk_test_screen_key_0123456789', baseUrl: sandbox }` ; `GET /api/billing/status` (session d'un membre d'organisation) → `online: true` ; aucune ligne de `platform_settings` ne contient la clé en clair ; `loadConfig(t.config.baseEnv)` + `buildApp` sur la même base → `saspay.apiKey` identique.
  - `the screen wins over the .env file; removing it goes back to the file` : env `DEEPSEEK_API_KEY=A` ; PUT `B` → `t.config.ai.deepseek.apiKey === B`, source `screen` ; PUT `null` → `A`, source `env`.
  - `refuses unknown, incomplete or invalid values and keeps the previous ones` : chacun → 400 et `platform_settings` vide : `{ AKILI_PLATFORM_ADMINS: 'x@y.z' }` (section platform), `{ AKILI_LOCAL_MODEL_EXTERNAL: '0' }` (other_model), `{ GOOGLE_CLIENT_ID: 'id-seul' }`, `{ AKILI_LOCAL_MODEL_URL: 'pas une adresse' }`, `{ AKILI_LOCAL_MODEL_URL: 'https://api.openai.com/v1' }` sans modèle, `{ AKILI_SIGNUP_CREDITS: '-3' }`, `{ SASPAY_BASE_URL: 'https://evil.example' }`, `{ ANTHROPIC_API_KEY: 'a\nb' }` ; section inconnue → 404.
  - `saving nothing changes nothing` : PUT `{ values: {} }` → 200, ni audit ni e-mail.
  - `every change is audited and e-mailed to the operators, never with the value` : après PUT saspay → `audit_log` action `platform.settings_updated`, `target_id 'saspay'`, `detail.set` contient `SASPAY_API_KEY`, aucune colonne ne contient la valeur ; `t.mailer.sent` a un message à OPS dont `text` ne contient pas la valeur.
  - `a stored value that cannot be used is ignored at start-up and reported` : insérer une ligne `AKILI_LOCAL_MODEL_URL` scellée avec une autre clé maître (illisible) et une ligne `AKILI_EMBEDDINGS_URL='https://emb.example/v1'` sans modèle → nouvelle app démarre ; `config.ai.local` et `config.ai.embeddings` indéfinis ; GET → sections other_model et embeddings `status 'error'`.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/tests/platform-settings.test.ts` — Expected: FAIL (routes absentes).
- [ ] **Step 3: Implement** : `readServices` + `baseEnv` (copie de l'env reçu) ; migration 6 `platform_settings (name text PRIMARY KEY CHECK (name ~ '^[A-Z][A-Z0-9_]*$'), value bytea NOT NULL, updated_by uuid REFERENCES users (id), updated_at timestamptz NOT NULL DEFAULT now())` ; chiffrement `sealSecret(config, 'platform', 'setting:<NOM>', valeur)` ; `applySettings` essaie `readServices({ ...baseEnv, ...acceptées, ...section })` section par section, garde les refus, puis `Object.assign(config, readServices(...))` ; PUT : `normalizeChanges` → valeurs fusionnées → `section.check` → `readServices` en dernier rempart → écriture en transaction → `reloadSettings` → audit (`{ set, removed }`, noms seuls) → e-mail à chaque `config.platformAdmins` via `mailer.sendMail` (erreur journalisée, jamais bloquante) ; `reloadSettings` appelé dans `buildApp` après `app.decorate`.
- [ ] **Step 4: Run** le fichier puis `pnpm test` et `pnpm typecheck` — Expected: tout vert.
- [ ] **Step 5: Commit** `feat(settings): service keys stored encrypted and applied without restart`.

### Task 2: Bouton « Tester » (serveur)

**Files:**
- Modify: `apps/server/src/ai/router.ts` (exporter `serverProviders`)
- Modify: `apps/server/src/settings/routes.ts` (`POST /:section/test`)
- Test: `apps/server/tests/platform-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SECTIONS`, `platformAdminOf`, `reloadSettings`) ; `serverProviders(app)` de `ai/router.ts` ; `embed` de `ai/providers/openai-compatible.ts` ; `config.connectors.google.tokenUrl`.
- Produces: `POST /api/platform/settings/:section/test` → `{ ok: boolean; message: string }` ; 409 si la section n'est pas réglée ; 404 si non testable ; 429 au-delà de 10 tests / 10 min par personne.

- [ ] **Step 1: Write the failing tests**:
  - `tests the new key at once, on the light and heavy models` : faux OpenAI (`startFakeOpenAi`), env `DEEPSEEK_BASE_URL=fake.url` ; PUT deepseek clé A + modèles `m-light`/`m-heavy` → test → `ok: true`, message cite `m-light` et `m-heavy`, en-tête `authorization: Bearer A` ; PUT clé B → test → `Bearer B` (fournisseurs reconstruits).
  - `says in plain words when the key or the model is refused` : `fake.chat = () => ({ status: 401 })` → `ok: false`, message contient `clé refusée` ; `status: 404` → message contient le nom du modèle.
  - `checks Google client credentials` : `startFakeGoogle`, env `GOOGLE_TOKEN_URL` vers le faux ; PUT google `google-client`/`google-secret` → `ok: true` ; secret faux → `ok: false`.
  - `checks the embeddings service` : faux OpenAI, PUT embeddings → `ok: true`, message cite les dimensions (64).
  - `refuses to test a service that is not set` : test anthropic sans clé → 409.
- [ ] **Step 2: Run** — Expected: FAIL (404).
- [ ] **Step 3: Implement** : modèles → `generate({ model, system: 'Test de connexion.', messages: [« Réponds seulement : OK »], maxTokens: 16 })` pour léger puis lourd (une fois si identiques), durée mesurée ; `ProviderError.kind` → `auth` « clé refusée par le fournisseur », `invalid` « demande refusée (HTTP n) : le nom du modèle « X » est-il exact ? », `rate_limit` « limite atteinte ou crédit épuisé chez le fournisseur », `unavailable` « fournisseur injoignable », `refusal` = réussite (la clé marche) ; embeddings → `embed(…, ['Test de connexion'])` ; Google → POST `tokenUrl` `grant_type=authorization_code`, `code=akili-connection-test`, `redirect_uri` de l'application : `invalid_grant` = ok, `invalid_client`/401 = refusé, autre = « réponse inattendue » ; audit `platform.settings_tested` `{ ok }`.
- [ ] **Step 4: Run** le fichier, `pnpm test`, `pnpm typecheck` — Expected: vert.
- [ ] **Step 5: Commit** `feat(settings): test buttons for models, embeddings and Google`.

### Task 3: Écran « Clés API et services » (web)

**Files:**
- Create: `apps/web/src/pages/PlatformSettings.tsx` (`export function PlatformSettings()`)
- Modify: `apps/web/src/pages/Platform.tsx` (onglet `settings`, libellé « Clés API et services »)

**Interfaces:**
- Consumes: `GET /api/platform/settings`, `PUT /api/platform/settings/:section`, `POST /api/platform/settings/:section/test` (Tasks 1–2), `api`, `ApiError`, `useSession().toast`.

- [ ] **Step 1: Implement** : carte d'explication (chiffrement, effet immédiat, priorité sur `.env`, journal + e-mail ; ce qui reste dans `.env` : domaine, mot de passe de la base, clé maître, SMTP, adresses des administrateurs) ; une carte par section : titre, badge (`on` Actif / `off` Non configuré / `error` À corriger) + `statusText`, description, champs (secret : `type="password"`, `autoComplete="off"`, vide = inchangé, indice en placeholder, bouton « Retirer » si `source === 'screen'`), mention de la source, URLs à déclarer avec bouton « Copier », boutons « Enregistrer » (n'envoie que les champs modifiés) et « Tester » (si `testable`) avec le résultat affiché sous les boutons.
- [ ] **Step 2: Run** `pnpm typecheck` et `pnpm --filter @akili/web build` — Expected: sans erreur.
- [ ] **Step 3: Run** l'application (`pnpm dev`), se connecter avec une adresse de `AKILI_PLATFORM_ADMINS`, enregistrer une clé DeepSeek factice, vérifier badge, indice, source, puis « Retirer ».
- [ ] **Step 4: Commit** `feat(web): Administration › Clés API et services`.

### Task 4: Documentation et version 0.4.0

**Files:**
- Create: `docs/decisions/009-reglages-des-services-dans-l-interface.md`
- Modify: `docs/guides/deploiement.md` (§ 6 : l'écran d'abord, `.env` en repli), `.env.example` (mention de l'écran dans les sections IA, SasPay, connecteurs), `docs/architecture.md`, `CHANGELOG.md` (`## 0.4.0 — 2026-11-20`), `apps/server/src/routes.ts` (`APP_VERSION = '0.4.0'`), `apps/server/package.json`, `apps/web/package.json`

- [ ] **Step 1: Update** les fichiers ci-dessus.
- [ ] **Step 2: Run** `pnpm vitest run apps/server/tests/release.test.ts` puis `pnpm test`, `pnpm typecheck`, `pnpm smoke` — Expected: vert.
- [ ] **Step 3: Commit** `docs: service keys from the interface; version 0.4.0`.
