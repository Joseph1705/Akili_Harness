# 009 — Les clés des services se règlent dans l'interface

Date : 2026-11-20 · Statut : appliqué (version 0.4.0) · Complète l'ADR 006

## Contexte
Jusqu'ici, chaque clé (modèles d'IA, SasPay, Google, WhatsApp) vivait dans le fichier `.env` du serveur : pour en
changer une, il fallait se connecter en SSH, éditer le fichier et relancer l'application. Le fondateur veut coller
ses clés dans le navigateur, sans toucher au serveur, et qu'elles marchent tout de suite.

## Options
1. **Réglages chiffrés en base, appliqués à chaud** : une table `platform_settings` (nom de la variable → valeur
   chiffrée avec une clé dérivée de la clé maître). Au démarrage et après chaque enregistrement, la configuration des
   services est recalculée (`.env` + valeurs de l'écran) avec les mêmes fonctions de lecture que `.env`.
2. Écrire dans `.env` et relancer le conteneur : l'application devrait écrire sur l'hôte et piloter Docker ; l'accès
   au socket Docker revient à donner le serveur entier à quiconque prend la main sur l'application.
3. Un écran qui génère un bloc `.env` à copier : il faut toujours se connecter au serveur.

## Choix
Option 1, onglet **Administration › Clés API et services**, réservé aux adresses de `AKILI_PLATFORM_ADMINS`.

## Conséquences
- Une valeur saisie à l'écran l'emporte sur `.env` ; la retirer revient à `.env`. Effet immédiat, sans redémarrage.
- Les secrets ne sortent jamais du serveur (4 derniers caractères seulement) ; une sauvegarde de la base ne contient
  que des valeurs chiffrées : sans la clé maître, elles sont illisibles.
- Seules les variables du catalogue (`apps/server/src/settings/catalog.ts`) sont acceptées. Restent dans `.env` : domaine,
  base, clé maître, SMTP, adresses des administrateurs (il les faut avant de pouvoir se connecter), réglages
  d'exploitation, et les options qui déclarent un modèle « chez nous » (elles lèveraient le consentement et la
  pseudonymisation, règle 5).
- Chaque modification est inscrite au journal d'audit (noms des champs, jamais les valeurs) et signalée par e-mail à
  tous les administrateurs : une session volée ne peut pas changer la clé de paiement en silence.
- Une valeur enregistrée devenue inutilisable (clé maître changée, `.env` modifié) est ignorée au démarrage et
  signalée à l'écran ; le serveur démarre avec `.env`.
- Boutons « Tester » : un appel minimal aux modèles léger et lourd, aux embeddings, et à Google (identifiants client) ;
  action explicite d'un administrateur, sans donnée client.
- Limite : la configuration est tenue en mémoire par le processus. Avec plusieurs instances de l'application, chacune
  relirait les réglages à son démarrage seulement.
