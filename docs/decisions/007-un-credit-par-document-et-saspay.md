# 007 — Un crédit par facture générée depuis un document ; achat par SasPay

Date : 2026-11-17 · Statut : appliqué (version 0.3.0) · Remplace l'ADR 003 pour l'application ; l'ADR 003 reste
la règle du seul parcours local `pnpm dsh`.

## Contexte
`DIRECTIVES.md` §5 : le client ne doit pas payer au jeton. Il achète des crédits prépayés ; un crédit est consommé
par facture générée à partir d'un document. Un échec ne coûte rien. Les crédits s'achètent en ligne.
L'audit du 2026-11-17 a trouvé un défaut : le crédit était débité avant la création de la facture, dans une autre
transaction ; si la création échouait, le crédit était perdu.

## Choix
- Portefeuille par organisation (`credit_wallets`, solde ≥ 0 par contrainte) et registre permanent
  (`credit_transactions`, ajout seul imposé par déclencheur, solde avant et après sur chaque ligne).
- Une seule fonction (`applyCredit`) pour tout mouvement : verrou de ligne, idempotence par clé d'opération,
  refus sous zéro, écriture dans la transaction de l'appelant. Le débit d'un document est écrit dans la
  transaction qui crée la facture.
- Types : achat, consommation, remboursement, allocation, correction. Pas de suppression : écriture inverse.
- Paquets administrables ; quatre exemples (100, 500, 1 000, 5 000) créés **inactifs et sans prix** : les prix sont
  une décision commerciale du fondateur, pas du code.
- SasPay par session de paiement hébergée. Le crédit n'est accordé qu'après vérification de l'état du paiement
  auprès de SasPay par notre serveur (montant et devise contrôlés) ; le webhook signé et la page de retour ne font
  que déclencher cette vérification ; rapprochement périodique. Sans clé : refus, jamais de simulation.

## Conséquences
- Le coût des modèles d'IA reste suivi en interne (activité de l'IA) pour fixer des prix qui le couvrent.
- Le plugin dsh `akili-credits` compte encore au jeton (ADR 003) : à aligner ou à retirer, décision du fondateur.
- La documentation de SasPay présente des écarts (réponse enveloppée ou non ; deux formes de charge utile de webhook) :
  le client accepte les deux formes de réponse et n'utilise pas le contenu du webhook. Le webhook ne désigne aucune session
  de paiement : il déclenche, après la réponse, la vérification de tous les paiements ouverts. Les sessions sont créées avec
  `expires_at` (48 h) ; un paiement fermé de notre côté reste revérifiable.
- Relu le 2026-11-18 (docs.saspay.me) : RDC documentée (CD, CDF, réseaux Airtel Congo, Orange Congo, Vodacom Congo), carte
  Visa/Mastercard en USD, bac à sable `https://sandbox-api.saspay.me/api/v1`. Restent à confirmer avec SasPay : l'activation
  de ces réseaux sur notre compte marchand et le chemin `GET /checkout-sessions/{id}/status/` (à tester en bac à sable).
- Explication simple : [`docs/guides/credits.md`](../guides/credits.md).
