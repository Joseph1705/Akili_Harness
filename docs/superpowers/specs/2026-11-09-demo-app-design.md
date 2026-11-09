# Application de démonstration — design (court)

Date : 2026-11-09 · Demandé par le fondateur : « finir le projet pour présenter demain », avec le design Claude Design fourni, sans document client réel.

## Intention
Montrer à un prospect (sous-traitant minier, Lubumbashi) le flux du client 1 de bout en bout : un rapport d'activité arrive → l'agent extrait les données → le code calcule la facture → un humain valide → PDF « Document non fiscal ». Avec une vraie connexion, des organisations isolées, des crédits (1 crédit = 1 document) et le design fourni.

## Objectifs
- Connexion par code e-mail, sessions sûres, rôles, onboarding (sections 5.1–5.4 de la directive).
- Écrans du design : Activité du jour (E), Session (A/B), Validation de facture (C), Packs → créer un agent (D), À propos (F) ; clair et sombre.
- Pack « Facturation sous-traitance » opérationnel sur des rapports fictifs (PDF, XLSX, CSV).
- Crédits : 1 document traité = 1 crédit ; blocage à 0 ; recharge par un admin avec référence de paiement.
- Sécurité : isolation par organisation, chiffrement des fichiers au repos, journal d'audit, limitation de débit, en-têtes de sécurité, injection de prompt neutralisée.

## Non-objectifs (démo)
Envoi réel d'e-mails, facture normalisée DGI, paiement mobile money, desktop, PostgreSQL, pseudonymisation, packs autres que Facturation (affichés « bientôt »).

## Anti-objectifs
- Un calcul fait par le modèle (règle 6). - Une donnée réelle (règle 4). - Un appel sortant non consenti (règle 5). - Une facture qui se dit « normalisée ».

## Approches considérées
1. **Retoucher l'interface web de DeepSeek Harness** par plugins client : conforme à la règle 1 mais l'interface dsh est faite pour coder ; les 6 écrans du design ne s'y prêtent pas en un jour.
2. **Application à nous (API + interface) au-dessus de dsh** — structure `apps/web`, `apps/server` de la directive 4.2 ; dsh reste le moteur d'agent, piloté par son SDK pour l'assistant. **Choisie** : seule voie réaliste pour le design et la sécurité demandés, sans toucher au cœur.
3. Maquette statique : rapide mais ne prouve rien. Rejetée.

## Décisions de construction (mes choix)
- TypeScript partout, Node ≥ 24.9. Serveur Fastify 5 ; base SQLite intégrée à Node (`node:sqlite`) derrière un module de dépôt (PostgreSQL plus tard) ; zod pour valider chaque entrée.
- Interface React + Vite, polices IBM Plex auto-hébergées (fonctionne hors ligne), jetons de couleur du design, i18n FR.
- Extraction déterministe des rapports au format fixture (PDF texte, XLSX, CSV) : la démo marche sans clé ni réseau. Sans clé API, l'assistant répond aux commandes (`/facturer`, `/solde`, `/aide`) et dit clairement que l'IA conversationnelle n'est pas configurée ; avec une clé, il passe par dsh (étape suivante).
- Montants en centimes entiers, quantités en millièmes, TVA 16 % paramétrable (source à confirmer par un expert-comptable).
- E-mail de connexion : transport console ; en mode démo seulement, le code s'affiche aussi à l'écran.
