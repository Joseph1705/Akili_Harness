# Crédits et paiements : référence technique (version 0.4.0)

Pour les développeurs. Explication simple : [`guides/credits.md`](guides/credits.md). Décision : ADR 007.
Code : `apps/server/src/billing/wallet.ts` (portefeuille), `credits.ts`, `billing/payments.ts`, `billing/saspay.ts`,
`platform.ts`. Un test (`apps/server/tests/release.test.ts`) vérifie que chaque route ci-dessous est documentée ici.

## Tables et relations

```
organizations 1───1 credit_wallets          solde ≥ 0 (contrainte), totaux achetés / consommés / remboursés /
      │                                      alloués / corrigés, seuil d'alerte (10 par défaut)
      │
      ├───* credit_transactions             registre permanent : jamais modifié ni supprimé (déclencheurs)
      │        │  type, amount, balance_before, balance_after (= before + amount, contrainte),
      │        │  operation_key UNIQUE par organisation, actor_user_id, reason, payment_reference
      │        ├── document_id ──▶ documents    (consommation : le document lu)
      │        ├── invoice_id  ──▶ invoices     (consommation : la facture générée)
      │        └── payment_id  ──▶ payments     (achat)
      │
      ├───* payments ──▶ credit_packages    achat : paquet, crédits, montant en centimes, devise, statut,
      │                                      session SasPay (UNIQUE), clé d'idempotence par personne
      └   payment_events                     webhooks SasPay valides (événement, résultat)
credit_ledger                                ancien registre (0.2.0), conservé en lecture, repris par migration
```

Signes imposés par la base : `purchase`, `refund`, `admin_allocation` > 0 ; `consumption` < 0 ; `admin_correction`
de signe libre, jamais sous zéro.

## Clés d'opération (idempotence)

Toute variation passe par `applyCredit` : verrou `FOR UPDATE` du portefeuille, clé déjà vue → premier résultat rendu,
solde jamais négatif, écriture dans la transaction de l'appelant.

| Opération | Clé | Effet d'une répétition |
|---|---|---|
| Facture générée depuis un document | `document:<id du document>` | aucun second débit |
| Achat SasPay | `payment:<id du paiement>` | aucun second crédit (webhooks rejoués, page de retour, rapprochement) |
| Crédits de bienvenue | `signup` | une seule fois par organisation |
| Allocation de la plateforme | `allocation:<Idempotency-Key>` | une seule fois par clé |
| Remboursement | `refund:<id de la transaction remboursée>` ou `refund:<Idempotency-Key>` | une seule fois |
| Correction | `correction:<Idempotency-Key>` | une seule fois par clé |

## Points d'accès

Rôles : `read` = tous les membres ; `billing` = propriétaire et administrateur de l'organisation ;
`plateforme` = adresses de `AKILI_PLATFORM_ADMINS` (pour toute autre personne, la route n'existe pas : 404).

### Organisation

| Route | Rôle | Rôle de la route |
|---|---|---|
| `GET /api/credits` | read | solde, portefeuille (`low` si solde ≤ seuil), 100 dernières écritures (`?type=`, `?before=`) |
| `GET /api/credits/usage` | read | documents traités par jour, semaine ou mois (`?period=day\|week\|month`) |
| `PATCH /api/credits/settings` | billing | seuil d'alerte de solde bas (`{ "low_balance_threshold": 20 }`) ; pas encore d'écran |
| `GET /api/billing/status` | read | paiement en ligne disponible ? moyens de paiement |
| `GET /api/billing/packages` | read | paquets actifs |
| `GET /api/billing/purchases` | billing | 100 derniers achats |
| `POST /api/billing/purchases` | billing | crée l'achat et la session SasPay ; en-tête `Idempotency-Key` obligatoire |
| `POST /api/billing/purchases/:id/verify` | billing | revérifie auprès de SasPay (page de retour) ; ne fait jamais confiance à l'URL |

### SasPay

| Route | Appelant | Rôle de la route |
|---|---|---|
| `POST /api/webhooks/saspay` | SasPay | signature HMAC-SHA256 de `{timestamp}.{corps brut}` (`X-Webhook-Signature`, `X-Webhook-Timestamp`, 300 s) ; répond tout de suite, puis vérifie les paiements ouverts ; ne crédite jamais à lui seul ; limité par adresse ; un appel mal signé est journalisé, pas stocké |

### Plateforme (console des développeurs)

| Route | Rôle de la route |
|---|---|
| `GET /api/platform/orgs` | organisations, propriétaire, soldes, documents (30 jours) |
| `POST /api/platform/orgs/:id/credits` | allocation (`credits`, `ref`, `promotional`), avec `Idempotency-Key` |
| `POST /api/platform/orgs/:id/refunds` | remboursement (`credits`, `reason`, `transactionId` facultatif) |
| `POST /api/platform/orgs/:id/corrections` | correction (`amount` signé, `reason`) ; jamais sous zéro |
| `GET /api/platform/transactions` | registre de toutes les organisations (filtres) |
| `GET /api/platform/packages` | tous les paquets |
| `POST /api/platform/packages` | crée un paquet ; actif seulement avec un prix |
| `PUT /api/platform/packages/:id` | modifie un paquet (un achat lancé garde son prix) |
| `GET /api/platform/payments` | paiements de toutes les organisations (`?status=`) |
| `POST /api/platform/payments/:id/verify` | revérifie un paiement auprès de SasPay (en attente, expiré ou annulé) |
| `GET /api/platform/usage` | documents traités par jour et par organisation |
| `GET /api/platform/ai` | coût interne de l'IA (jour, modèle, organisation), erreurs, évaluations |
| `POST /api/platform/evals/extraction` | évalue la lecture des documents fictifs (`method: local\|model`) |

Toute action financière de la plateforme est écrite au journal d'audit avec son auteur.

## Exemples

Achat d'un paquet (organisation, rôle billing) :

```http
POST /api/billing/purchases
Idempotency-Key: 6f1c2a52-0d3b-4c49-9a43-6c1f5e2b7a10
Content-Type: application/json

{ "packageId": "0b6c…" }
```

```json
{ "purchase": { "id": "a41f…", "package_name": "Essentiel", "credits": 100, "amount_cents": 2500, "currency": "USD",
  "provider": "saspay", "status": "pending", "checkout_url": "https://pay.saspay.me/checkout/…", "credited_at": null } }
```

Le navigateur ouvre `checkout_url`. Au retour (`/credits?paiement=a41f…`), la page appelle
`POST /api/billing/purchases/a41f…/verify` : `status` passe à `succeeded` seulement si SasPay répond `PAID` avec une
transaction `SUCCESS`, le même montant et la même devise.

Webhook reçu de SasPay (forme documentée, contenu non utilisé : il déclenche seulement la vérification) :

```http
POST /api/webhooks/saspay
X-Webhook-Event: transaction.success
X-Webhook-Timestamp: 1763460000
X-Webhook-Signature: 3f9a…(hex)

{ "event": "transaction.success", "data": { "reference": "TXN-2026-000456", "status": "SUCCESS", "amount": "25.00", "currency": "USD" } }
```

Solde et historique :

```json
{ "balance": 99,
  "wallet": { "balance": 99, "total_purchased": 100, "total_consumed": 1, "low_balance_threshold": 10, "low": false },
  "entries": [
    { "type": "consumption", "amount": -1, "balance_before": 100, "balance_after": 99, "filename": "Scan_BL-2026-118.pdf", "invoice_number": "FAC-2026-0001" },
    { "type": "purchase", "amount": 100, "balance_before": 0, "balance_after": 100, "payment_reference": "TXN-2026-000456" } ] }
```

Allocation par la plateforme :

```http
POST /api/platform/orgs/2c7e…/credits
Idempotency-Key: 0d2b5c1e-8a77-4f0e-b1d4-2b9a6c3e5f01

{ "credits": 50, "ref": "Virement BC-2026-12", "promotional": false }
```

## Erreurs

| Code | Cas |
|---|---|
| `402 insufficient_credits` | plus de crédit au moment de générer : rien n'est débité, le document reste en attente |
| `503 payment_unavailable` | SasPay non configuré : l'achat est refusé, jamais simulé |
| `502 payment_provider_error` | SasPay n'a pas créé la session ; l'achat est marqué échoué, rien n'est crédité |
| `403 invalid_signature` | webhook mal signé ou trop ancien |
| `429 rate_limited` | trop d'appels depuis la même adresse |
| `400 price_required` | paquet activé sans prix |
