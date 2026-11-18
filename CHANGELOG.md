# Journal des versions

Le numéro de version s'affiche dans l'écran « À propos ». Tant que DeepSeek Harness est en préversion et que
l'intégration DGI n'est pas validée, les versions restent en 0.x et chaque facture porte « Document non fiscal ».

## 0.3.0 — 2026-11-18 · Harness complet

Mission : `DIRECTIVES.md`. Conception : `docs/superpowers/specs/2026-11-17-mission-harness-v1-design.md`.

**Crédits (nouveau modèle économique)**
- Un crédit = une facture générée à partir d'un document. Plus de facturation au jeton pour le client.
- Portefeuille par organisation et registre permanent : chaque mouvement garde le solde avant et après ;
  rien ne se supprime, une erreur se corrige par une écriture inverse.
- Un échec (document illisible, OCR raté, génération qui échoue) ne coûte aucun crédit ; un doublon non plus.
- Deux traitements simultanés sur le dernier crédit : un seul passe, le solde n'est jamais négatif.
- Administration : allocations, remboursements et corrections avec motif et trace ; alerte de solde bas.

**Achat de crédits en ligne**
- Paquets de crédits gérés par la plateforme (créés inactifs et sans prix : le fondateur fixe les prix).
- Paiement SasPay (mobile money ou carte). Les crédits ne sont ajoutés qu'après vérification auprès de SasPay
  par notre serveur ; un webhook rejoué ou une page de retour visitée ne crédite jamais deux fois.

**Documents et factures**
- Documents acceptés : PDF, scans, photos, Word, texte, Excel, CSV. Lecture des scans (OCR) sur notre serveur.
- Tout document commercial devient une proposition de facture que la personne vérifie et corrige
  avant de la générer ; le code recalcule tous les montants.
- Factures manuelles (sans crédit), remise, statut de paiement, recherche, partage par lien expirant
  et révocable, historique des modifications.

**Harness d'agents IA**
- Modèles Claude (offre Entreprise), DeepSeek (offre Entrepreneur individuel) ou modèle local ;
  niveaux léger et lourd, repli automatique, cache. Rien ne part sans activation et consentement de l'organisation.
- Pseudonymisation avant tout envoi à un fournisseur externe (e-mails, téléphones, NIF, RCCM, comptes, noms connus).
- Instructions des agents versionnées, avec retour possible à une version précédente.
- Base de connaissances avec sources citées ; serveurs d'outils MCP ; Gmail, Google Sheets et WhatsApp.
- Toute action sortante (e-mail, message, écriture) attend la validation d'une personne.
- Activité de l'IA : exécutions, durée, erreurs, coût interne, évaluations de l'extraction.

**Sécurité et exploitation**
- Limitation de débit, secrets chiffrés, protection SSRF, conservation limitée des extraits de l'IA,
  export des données d'une organisation, retrait d'un membre, tests de sécurité dédiés.
- PostgreSQL avec `pgvector` (développement, CI, production).
- Modèle de réglages `.env.example` complet, que le guide de déploiement fait copier.
- Le lanceur `pnpm dsh` fonctionne sous Windows ; `pnpm smoke` vérifie d'abord que le lanceur démarre dsh.

**Limites connues**
- Facture non normalisée DGI : mention « Document non fiscal » obligatoire (règle 8).
- Prix des paquets à fixer par le fondateur avant toute vente.
- Le parcours local `pnpm dsh` (plugin `akili-credits`) compte encore les crédits au jeton ; il n'est pas proposé
  aux clients. Décision à prendre : l'aligner sur « un crédit par document » ou le retirer.

## 0.2.0 — 2026-11-12 · Prêt pour la production

- PostgreSQL, codes de connexion envoyés par e-mail (SMTP), fin du mode démonstration.
- Clients et contrats, demandes de crédits, page d'administration de la plateforme.
- Mise en ligne par Docker Compose (Caddy pour le HTTPS, application, base), sauvegardes, intégration continue.
- Lancement local sur son propre ordinateur (`docker-compose.local.yml`).

## 0.1.0 — 2026-11-09 · Prototype

- DeepSeek Harness figé (0.2.2-rc.1), routage du modèle selon l'offre, crédits prépayés.
- Application : connexion par code e-mail, organisations et rôles, fichiers chiffrés, rapports d'activité
  transformés en factures vérifiées par une personne, PDF « Document non fiscal », interface du design.
