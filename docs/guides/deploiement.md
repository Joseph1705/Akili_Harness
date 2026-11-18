# Mettre l'application en ligne (VPS Hostinger)

Tout tourne dans Docker : **Caddy** (HTTPS) → **application** → **PostgreSQL**. Seul Caddy est visible depuis Internet.

## 1. Le serveur

- VPS Hostinger KVM, **Ubuntu 24.04**, 2 cœurs et 8 Go de RAM suffisent au départ. Région Europe (France ou Allemagne) : mesurer la latence depuis Lubumbashi pendant les 30 jours de remboursement.
- Se connecter en SSH, puis installer Docker :

```bash
curl -fsSL https://get.docker.com | sh
```

- Pare-feu : n'ouvrir que 22 (SSH), 80 et 443.

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

## 2. Le code

```bash
git clone https://github.com/Joseph1705/Akili_Harness /opt/akili && cd /opt/akili
```

```bash
cp .env.example .env && nano .env
```

Dans `.env`, remplir :

| Variable | Comment l'obtenir |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `AKILI_MASTER_KEY` | `openssl rand -base64 32` — **à copier aussi en lieu sûr** : sans elle, les fichiers des clients sont illisibles |
| `SMTP_PASSWORD` | Mot de passe d'application Gmail (voir plus bas) |
| `APP_DOMAIN`, `AKILI_PUBLIC_ORIGIN` | Voir l'étape 3 ou 4 |
| `AKILI_HOSTING_LABEL` | La vraie région, ex. « Hébergé en France » |
| `ACME_EMAIL` | Une adresse e-mail pour le certificat HTTPS |
| `SMTP_USER` | L'adresse Gmail qui envoie les codes de connexion |
| `AKILI_PLATFORM_ADMINS` | Les adresses des opérateurs de la plateforme (menu Administration) |

Chaque ligne de `.env.example` est expliquée dans le fichier. Paiement, IA et connecteurs sont facultatifs : étape 6.

**Mot de passe d'application Gmail** (pour `josephprods@gmail.com`) : Compte Google › Sécurité › activer la validation en deux étapes › « Mots de passe des applications » › créer « Akili » › copier les 16 caractères dans `SMTP_PASSWORD`. Gmail limite à environ 500 e-mails par jour : suffisant pour commencer ; un service d'envoi transactionnel prendra le relais avec les mêmes variables.

## 3. Premier test par l'adresse IP (avant d'avoir le domaine)

Dans `.env` :

```
APP_DOMAIN=:80
AKILI_PUBLIC_ORIGIN=http://IP_DU_VPS
AKILI_ALLOW_HTTP=1
```

```bash
docker compose up -d --build
```

Ouvrir `http://IP_DU_VPS`. Se connecter avec `josephprods@gmail.com` : le code arrive par e-mail. Ce mode est sans HTTPS : ne pas y mettre de vraies données.

## 4. Avec le domaine (le jour où il est acheté)

1. Chez le registraire du domaine : un enregistrement **A** `app` → IP du VPS (et plus tard `@` pour le site vitrine).
2. Dans `.env` :

```
APP_DOMAIN=app.votre-domaine.com
AKILI_PUBLIC_ORIGIN=https://app.votre-domaine.com
```

   et **supprimer** la ligne `AKILI_ALLOW_HTTP=1`.

3. Relancer :

```bash
docker compose up -d
```

Caddy obtient le certificat HTTPS tout seul (quelques secondes) et le renouvelle.

## 5. Au quotidien

| Besoin | Commande |
|---|---|
| Mettre à jour après un changement de code | `git pull && docker compose up -d --build` |
| Voir les journaux | `docker compose logs -f app` |
| État des services | `docker compose ps` |
| Sauvegarde manuelle | `./deploy/backup.sh` |
| Sauvegarde chaque nuit à 2 h | `crontab -e`, puis `0 2 * * * /opt/akili/deploy/backup.sh >> /var/log/akili-backup.log 2>&1` |
| Créditer une entreprise (paiement reçu autrement, geste commercial) | Menu **Administration** (adresses listées dans `AKILI_PLATFORM_ADMINS`) |

Les sauvegardes restent sur le VPS (14 jours). Étape suivante : copie chiffrée chez un autre fournisseur (directive 4.4).

## 6. Brancher les services (facultatif)

Chaque service se règle dans `.env`, puis `docker compose up -d` pour en tenir compte. Sans réglage, l'application
affiche « non configuré » : rien n'est jamais simulé. `app.votre-domaine.com` est à remplacer par le vrai domaine.

| Service | Variables | À déclarer chez le fournisseur |
|---|---|---|
| Achat de crédits (SasPay) | `SASPAY_API_KEY`, `SASPAY_WEBHOOK_SECRET` | URL du webhook : `https://app.votre-domaine.com/api/webhooks/saspay` |
| IA Claude (offre Entreprise) | `ANTHROPIC_API_KEY` | — |
| IA DeepSeek (offre Entrepreneur individuel) | `DEEPSEEK_API_KEY` | — |
| Gmail et Google Sheets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Client OAuth « Application Web », URI de redirection : `https://app.votre-domaine.com/api/connectors/google/callback` |
| WhatsApp Business | `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | URL de rappel : `https://app.votre-domaine.com/api/webhooks/whatsapp`, avec le même jeton de vérification |

Une clé d'IA présente ne suffit pas : chaque organisation doit encore activer l'IA et donner son consentement
avant que la moindre donnée parte vers un fournisseur (règle 5).

## 7. Avant la première vente

1. Menu **Administration** › Paquets et prix : fixer le prix de chaque paquet, puis l'activer (un paquet sans prix ne peut
   pas l'être). Fonctionnement des crédits : [`credits.md`](credits.md).
2. Faire un achat réel du plus petit paquet et vérifier que les crédits arrivent une seule fois.
3. Vérifier le coût réel de l'IA par document dans **Administration** › Coûts IA et évaluations avant de figer les prix.
4. Les factures portent « Document non fiscal » tant que l'intégration DGI n'est pas validée (règle 8).
