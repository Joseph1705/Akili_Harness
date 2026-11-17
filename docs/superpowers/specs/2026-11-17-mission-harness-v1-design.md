# Mission « harness complet » — design

Date : 2026-11-17 · Source : `DIRECTIVES.md` (mission du fondateur), consignes « ne pas s'arrêter après l'audit » et « ne pas demander d'accord pour chaque décision mineure ». Les décisions marquées **(mon choix)** sont à relire par le fondateur.

## 1. Intention

Livrer un produit démontrable à des cabinets comptables et des entreprises : un document arrive (PDF, scan, photo, Word, texte, Excel, CSV), l'IA en extrait les données, un humain vérifie, le code calcule et produit la facture, **un crédit prépayé est consommé par facture générée depuis un document**, et les crédits s'achètent en ligne par SasPay. Autour : un vrai harness d'agents (prompts configurables, RAG, MCP, connecteurs Google et WhatsApp, garde-fous, routage de modèles, observabilité).

## 2. État trouvé (audit du 2026-11-17)

- `apps/server` (Fastify 5, PostgreSQL 16, 102 tests) : connexion par code e-mail, sessions révocables, rôles (propriétaire, admin, opérateur, lecteur, comptable externe), organisations isolées par `org_id`, fichiers chiffrés AES-256-GCM par organisation, journal d'audit, file de tâches `SKIP LOCKED`, rapports d'activité PDF/XLSX/CSV → brouillon de facture calculé par le code → validation humaine idempotente → PDF « Document non fiscal ».
- Crédits : registre `credit_ledger` en ajout seul, 1 crédit = 1 document, verrou consultatif. **Défaut trouvé** : le crédit est débité *avant* la création de la facture, dans une autre transaction ; si la création échoue, le crédit est perdu (contraire à la règle « échec = pas de débit »).
- Pas de paiement, pas d'OCR, pas de factures manuelles, pas de remise ni de statut de paiement, pas de recherche, pas de partage.
- IA : aucun appel de modèle dans l'application (assistant à commandes). Le plugin dsh `akili-credits` facture les **jetons** : contraire à la nouvelle directive (pas de facturation au jeton pour le client).
- Un test du plugin échoue sous Windows (chemin avec `\`).

## 3. Objectifs / non-objectifs / anti-objectifs

**Objectifs** : tous les points de `DIRECTIVES.md` §3 à §11 réalisables sans identifiants externes, testés.

**Non-objectifs** : application desktop, intégration DGI (règle 8 : « Document non fiscal » reste obligatoire), comptabilité SYSCOHADA, connecteurs autres que Google et WhatsApp.

**Anti-objectifs** (échec même si « ça marche ») : une intégration simulée qui fait croire à un succès ; un crédit ajouté parce qu'une URL de retour a été visitée ; un appel sortant vers un fournisseur de modèle sans activation ni consentement de l'organisation (règle 5) ; un montant calculé par le modèle (règle 6) ; une action sortante (e-mail, WhatsApp, écriture Google) sans validation humaine (règle 7) ; un agent qui fait plus que l'utilisateur qui l'a lancé.

## 4. Approches considérées pour le moteur d'agents

1. **Harness dans `apps/server` (choisie, mon choix)** : modules TypeScript à nous (fournisseurs de modèles, routage, RAG, MCP, garde-fous, traces), multi-organisations, sur PostgreSQL. Prolonge l'ADR 005. dsh reste figé et non modifié pour le parcours local `pnpm dsh web`.
2. Faire tourner dsh comme moteur par session : dsh est mono-utilisateur (stockage, sandbox, shell locaux), en préversion, et ses dépendances ne s'installent pas sans `cdn.sheetjs.com` ; l'isolation multi-organisations serait à reconstruire autour.
3. Bibliothèque d'agents tierce (LangChain…) : dépendance lourde, peu de contrôle sur la confidentialité.

## 5. Choix de construction

### Crédits (directive §5)
- `credit_wallets` (une ligne par organisation : solde ≥ 0 par contrainte, totaux achetés, consommés, remboursés, alloués) + `credit_transactions` (registre permanent : type, montant, solde avant, solde après, clé d'opération unique par organisation, document, facture, paiement, auteur, motif, statut). Mise à jour et suppression interdites par déclencheur PostgreSQL.
- Toute opération passe par une seule fonction : verrou de ligne `FOR UPDATE` sur le portefeuille, contrôle d'idempotence par clé, solde jamais négatif, écriture du registre dans la **même transaction**. Le débit d'un document se fait dans la transaction qui crée la facture : si la facture échoue, rien n'est débité.
- Types : `purchase`, `consumption`, `refund`, `admin_allocation`, `admin_correction`. On ne supprime jamais : correction = écriture compensatoire.
- Reprise de l'ancien registre dans le nouveau (migration), ancien tableau conservé en lecture.

### Paquets et SasPay (directive §5 D–E)
- Paquets administrables (nom, crédits, prix, devise USD/CDF, description, disponibilité, promotion) ; exemples 100/500/1 000/5 000 créés **inactifs, sans prix** : le fondateur fixe les prix (mon choix : je n'invente pas de tarif).
- SasPay par **session de paiement hébergée** (`POST /checkout-sessions/`) : le client choisit mobile money (Airtel, Orange, Vodacom en CDF) ou carte (USD) sur la page SasPay. Vérification côté serveur par `GET /checkout-sessions/{id}/status/` (`PAID` + `transaction_status: SUCCESS`, montant et devise contrôlés). Webhook signé HMAC-SHA256 (`X-Webhook-Signature`, `X-Webhook-Timestamp`, fenêtre 300 s) : il déclenche la vérification, il ne crédite jamais à lui seul. Crédit idempotent (clé `payment:<id>`). Rapprochement périodique des paiements en attente. Sans clé SasPay : achat refusé avec un message clair, jamais simulé.
- Écarts de documentation SasPay notés (enveloppe `success/data` ou non, sandbox annoncé « bientôt ») : le client accepte les deux formes.

### Documents et factures (directive §4, §6)
- Formats : PDF texte, PDF scanné, PNG/JPEG/WebP, DOCX, TXT, XLSX, CSV ; type lu dans les octets ; limites de taille, de pages, de pixels et de décompression.
- OCR local (tesseract.js, données français + anglais embarquées, rendu des pages PDF par `@napi-rs/canvas`) : aucun document ne quitte le serveur pour l'OCR.
- Deux chemins : (a) rapport d'activité + contrat (existant, prix du contrat) ; (b) document libre → champs extraits (par le modèle si l'organisation l'a activé, sinon extraction heuristique) → statut « à vérifier » → l'utilisateur corrige client, numéro, dates, lignes, taxes → « Générer la facture » (clé d'idempotence) → le code recalcule tout, signale les écarts avec les totaux lus, crée la facture **et** débite le crédit dans une transaction.
- Factures manuelles sans crédit. Remise, statut de paiement (non payée, partielle, payée), recherche et filtres, lien de partage expirant et révocable, historique.

### Harness IA (directive §3)
- Fournisseurs : Anthropic, DeepSeek, compatible OpenAI (OpenAI, Mistral, Ollama local). Clés dans l'environnement du serveur. Niveaux `light` et `heavy`, choisis par tâche ; repli sur le modèle suivant en cas d'erreur ; coût interne estimé et journalisé (jamais affiché comme prix au client).
- Garde : appel externe seulement si l'organisation a activé l'IA **et** donné le consentement « fournisseur externe » ; pseudonymisation avant envoi (e-mails, téléphones, NIF, RCCM, comptes, noms connus de l'organisation et de ses clients), restitution au retour ; test qui intercepte la requête sortante.
- Cache de réponses par organisation, chiffré, à durée limitée.
- Prompts système versionnés par agent (identité, instructions, style, restrictions) ; une version active ; le préambule de sécurité de la plateforme ne peut pas être retiré ; test prouvant que la version active est bien envoyée au modèle.
- RAG : base de connaissances par organisation (PDF, DOCX, TXT, images par OCR), nettoyage, découpage par paragraphes, recherche plein texte PostgreSQL toujours active + vecteurs `pgvector` quand un modèle d'embeddings est configuré (fusion des rangs), sources citées, mise à jour et suppression. Le contenu récupéré est encadré comme donnée non fiable.
- MCP : serveurs distants HTTP uniquement (pas de processus local en SaaS), protection SSRF, découverte des outils, schéma validé (ajv), outils désactivés par défaut, rôle minimal par outil, validation humaine pour les outils sensibles.
- Connecteurs : Google (OAuth 2.0 avec PKCE et `state`, Gmail lecture et envoi, Sheets ajout de lignes, Drive préparé), WhatsApp Business Platform officielle (webhook vérifié par `X-Hub-Signature-256`, conversations, réponses validées par un humain). Jetons chiffrés. Sans identifiants : « non configuré », jamais simulé.
- Observabilité : exécutions (modèle, jetons, durée, coût, erreurs, cache), étapes (récupération, outils, garde-fous), évaluations d'extraction sur les fixtures, tableaux de bord organisation et plateforme.

### Sécurité (directive §7)
Limitation de débit globale et par route sensible, secrets chiffrés (HKDF sur la clé maître), protection SSRF, fichiers vérifiés, registre financier immuable, piste d'audit des actions financières, aucune donnée sensible dans les journaux, tests de sécurité dédiés.

## 6. Reste au constructeur
Libellés, mise en page des nouveaux écrans dans l'identité existante, valeurs par défaut des limites.
