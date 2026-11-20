# Clés API et services depuis l'interface — design

Date : 2026-11-20 · Demande du fondateur : « un écran dans mon profil développeur où je colle les clés de l'IA, SasPay,
Google Sheets, WhatsApp… pour ne pas toucher au code », mise en ligne sur le VPS le jour même.
Telegram : écarté pour l'instant par le fondateur. Les choix marqués **(mon choix)** sont à relire.

## Intention

Aujourd'hui chaque clé vit dans le fichier `.env` du serveur : la changer veut dire se connecter en SSH, éditer le
fichier, relancer. Le fondateur veut coller ses clés dans le navigateur et qu'elles marchent tout de suite.

## Objectifs, non-objectifs, anti-objectifs

- **Objectifs** : un onglet **Administration › Clés API et services**, réservé aux adresses de `AKILI_PLATFORM_ADMINS`,
  pour Claude, DeepSeek, un autre modèle compatible OpenAI (OpenAI, Mistral, Gemini, Groq, Ollama), la recherche par le
  sens (embeddings), SasPay, Google (Gmail, Sheets), WhatsApp, et les réglages de plateforme (nom affiché, adresse de
  support, crédits offerts). Effet immédiat, sans redémarrage. Boutons « Tester » pour les modèles, les embeddings et Google.
- **Non-objectifs** : Telegram ; SMTP, domaine, base, clé maître et adresses des administrateurs (il les faut avant de
  pouvoir se connecter : ils restent dans `.env`) ; réglages d'exploitation (cache IA, rétention, OCR, ClamAV).
- **Anti-objectifs** : une clé lisible en base ou renvoyée au navigateur ; un réglage cassé qui empêche le serveur de
  démarrer ; un changement de clé de paiement passé inaperçu (une session volée pourrait détourner les paiements vers un
  autre compte marchand) ; un écran qui contourne la règle 5 (un modèle externe déclaré « local » par erreur).

## Approches

1. **Réglages chiffrés en base, appliqués à chaud (choisie)** : table `platform_settings` (nom de la variable → valeur
   chiffrée AES-256-GCM, clé dérivée de la clé maître). Au démarrage et après chaque enregistrement, la configuration des
   services est recalculée à partir de `.env` + valeurs de l'écran, avec les mêmes fonctions de lecture que `.env`, et
   remplace en place celle du processus : tous les modules la relisent à chaque requête.
2. Écrire dans le fichier `.env` et relancer le conteneur : l'application devrait écrire sur l'hôte et piloter Docker
   (accès au socket Docker = prise de contrôle du serveur). Écartée.
3. Écran qui génère un bloc `.env` à copier : il faut encore toucher le serveur. Écartée.

## Choix de construction

- **Priorité** : une valeur saisie à l'écran remplace celle de `.env` ; « Retirer » revient à la valeur de `.env`
  (ou à rien). Chaque champ affiche sa source : « saisie ici », « fichier .env », « non réglé ».
- **Secrets** : jamais renvoyés au navigateur ; seuls les 4 derniers caractères sont montrés (clés d'au moins
  16 caractères). Champ vide à l'enregistrement = clé inchangée.
- **Validation** : contrôles en français (paires obligatoires, adresse web, entier, e-mail), puis les fonctions de
  lecture de `config.ts` en dernier rempart. Un réglage refusé ne change rien.
- **Démarrage robuste** : un réglage enregistré devenu invalide (ou illisible après un changement de clé maître) est
  ignoré et signalé à l'écran ; le serveur démarre quand même avec `.env`.
- **Sécurité (mon choix)** : chaque modification est inscrite au journal d'audit (noms des champs, jamais les valeurs)
  et signalée par e-mail à tous les administrateurs. L'adresse SasPay est un choix entre « réel » et « bac à sable »,
  pas un champ libre. Les options « ce modèle est chez nous » (`AKILI_LOCAL_MODEL_EXTERNAL=0`,
  `AKILI_EMBEDDINGS_EXTERNAL=0`) restent dans `.env` : à l'écran, l'adresse décide seule, donc une adresse publique est
  toujours traitée comme externe (consentement et pseudonymisation, règle 5).
- **Tests de connexion** : appel minimal (« Réponds OK ») aux modèles léger et lourd, un vecteur pour les embeddings,
  et pour Google un échange de code volontairement faux (`invalid_grant` = identifiants reconnus, `invalid_client` =
  refusés). Action explicite d'un administrateur, sans donnée client (règle 5 respectée). Limités en nombre.
  Pas de test SasPay : un achat en bac à sable reste la vraie preuve.
- **Un seul processus** applicatif aujourd'hui : l'application en mémoire suffit. Avec plusieurs instances, chacune
  relirait les réglages à son démarrage (limite notée).

## Reste au constructeur

Libellés, aides et mise en page dans l'identité existante ; limites de longueur ; nombre de tests autorisés par minute.
