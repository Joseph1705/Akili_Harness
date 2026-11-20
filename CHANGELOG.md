# Journal des versions

Le numéro de version s'affiche dans l'écran « À propos ». Tant que DeepSeek Harness est en préversion et que
l'intégration DGI n'est pas validée, les versions restent en 0.x et chaque facture porte « Document non fiscal ».

## 0.4.0 — 2026-11-20 · Clés API et services depuis l'interface

Conception : `docs/superpowers/specs/2026-11-20-platform-settings-design.md` · Décision : ADR 009.

- Nouvel onglet **Administration › Clés API et services** (opérateurs de la plateforme seulement) : Claude, DeepSeek,
  un autre modèle compatible OpenAI (OpenAI, Mistral, Gemini, Groq, Ollama), la recherche par le sens, SasPay (réel
  ou bac à sable), Google (Gmail, Sheets), WhatsApp, et les textes de la plateforme (nom affiché, adresse d'aide,
  crédits offerts). Plus besoin d'éditer `.env` ni de relancer le serveur pour brancher un service.
- Clés chiffrées en base avec la clé maître, prises en compte tout de suite, jamais réaffichées (4 derniers caractères
  seulement). Une valeur saisie à l'écran l'emporte sur `.env` ; « Retirer » revient à la valeur du fichier.
- Boutons « Tester » : modèles léger et lourd, embeddings, identifiants Google ; la réponse dit en clair ce qui ne va
  pas (clé refusée, nom de modèle inconnu…). Au plus 10 tests par 10 minutes et par personne.
- Chaque modification est inscrite au journal d'audit (noms des champs, jamais les valeurs) et signalée par e-mail à
  tous les administrateurs.
- Une valeur enregistrée devenue inutilisable (clé maître changée, `.env` modifié) est ignorée au démarrage et
  signalée à l'écran : le serveur démarre quand même.
- Restent dans `.env` : domaine, base, clé maître, envoi des e-mails (SMTP), adresses des administrateurs.
- Revue de la branche avant la version, corrections testées :
  - une adresse de modèle ou d'embeddings saisie à l'écran est jugée par elle-même : une adresse publique est toujours
    un fournisseur externe (consentement et pseudonymisation), même si `.env` déclarait l'ancienne adresse « chez nous » ;
  - un appel au modèle déjà en cours n'utilise jamais un fournisseur retiré, ou devenu externe pour une organisation
    qui n'a pas consenti ; un document de la base de connaissances garde le service d'embeddings avec lequel il a commencé ;
  - au plus 30 enregistrements par heure et par administrateur (chaque enregistrement envoie un e-mail) ;
  - clés : espaces et caractères invisibles refusés ; adresses : https obligatoire hors de notre réseau, ni identifiants,
    ni paramètres, ni adresses réservées du serveur ;
  - « Copier » prévient quand le navigateur l'interdit (test par IP sans HTTPS) ; les gestionnaires de mots de passe ne
    remplissent plus les champs de clé.

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
- Revue complète de la branche avant la version, corrections testées :
  - un paiement encaissé par SasPay est toujours crédité, même confirmé tard (sessions de 48 h, dernier contrôle
    avant fermeture, paiements fermés revérifiables) ; le webhook répond tout de suite et vérifie ensuite ;
  - les limites d'envoi de documents et de questions à l'IA ne se contournent plus ;
  - un modèle « local » à une adresse extérieure est traité comme un fournisseur externe (consentement, pseudonymisation) ;
  - brouillons WhatsApp : aucun outil pour un expéditeur extérieur, petit modèle, un brouillon en attente par conversation ;
  - un document qui ferait tomber le serveur à chaque tentative est abandonné au lieu de relancer le serveur en boucle ;
  - protection SSRF étendue aux formes IPv6 des adresses internes ; webhooks limités par adresse ;
  - le bouton d'évaluation fonctionne en production (documents fictifs livrés dans l'image).
- Référence technique des crédits et paiements : `docs/credits-technique.md`.
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
