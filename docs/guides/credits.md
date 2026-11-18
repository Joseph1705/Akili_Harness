# Comment fonctionnent les crédits

Ce guide s'adresse aux personnes qui vendent le produit, aux clients et à l'équipe, sans connaissance technique.

## En une phrase

**Un crédit = une facture produite à partir d'un document.** Le client achète des crédits à l'avance ;
chaque fois que l'application transforme un de ses documents en facture, un crédit est utilisé.

Le client ne paie jamais « au mot » ni « à la question posée à l'IA » : le prix ne dépend pas de la longueur
du document ni du modèle d'IA utilisé.

## Ce qui consomme un crédit, et ce qui n'en consomme pas

| Situation | Crédit utilisé ? |
|---|---|
| Un rapport d'activité devient une facture (prix pris dans le contrat) | **Oui, 1** |
| Un autre document (bon de commande, devis, photo, scan…) : la personne vérifie les champs proposés puis clique « Générer la facture » | **Oui, 1**, au moment de la génération |
| Une facture créée à la main, sans document | Non |
| Le document est illisible, l'OCR échoue, il n'y a rien à facturer | Non |
| La génération de la facture échoue | Non : le crédit n'est retiré qu'avec une facture réellement créée |
| Le même document est déposé deux fois (doublon) | Non |
| On clique deux fois sur « Générer », ou la connexion coupe et la demande repart | Un seul crédit |
| Une question posée à l'assistant, une recherche dans la base de connaissances | Non |

## Quand il n'y a plus de crédit

- Le document déposé **attend** : il n'est ni lu ni facturé, et rien n'est perdu.
- Dès que l'organisation rachète des crédits, les documents en attente repartent tout seuls.
- Le solde ne descend jamais sous zéro, même si plusieurs personnes travaillent au même moment.
- Une **alerte de solde bas** s'affiche dans l'écran Crédits quand il reste 10 crédits ou moins.

## Obtenir des crédits

1. **À l'inscription** : chaque nouvelle organisation reçoit des crédits d'essai (10 par défaut, réglable par la plateforme).
2. **Achat en ligne** : écran **Crédits**, choisir un paquet, payer sur la page SasPay par mobile money
   (Airtel Money, Orange Money, M-Pesa de Vodacom, en francs congolais) ou par carte bancaire (en dollars).
3. **Par l'équipe de la plateforme** : allocation (geste commercial, paiement reçu autrement), avec un motif écrit.

Seuls le propriétaire et les administrateurs d'une organisation peuvent acheter des crédits.

### Les paquets

Quatre paquets existent au départ : Essentiel (100), Pro (500), Cabinet (1 000), Entreprise (5 000).
Ils sont **inactifs et sans prix** : c'est au fondateur de fixer les prix, dans le menu **Administration**,
puis de les activer. Un paquet sans prix ne peut pas être activé.

### Ce qui garantit qu'un paiement est réel

- Les crédits ne sont ajoutés **qu'après que notre serveur a lui-même interrogé SasPay** et confirmé que le paiement
  est réussi, pour le bon montant et la bonne devise.
- Revenir sur la page de confirmation ne prouve rien et n'ajoute rien.
- Si SasPay prévient plusieurs fois du même paiement, les crédits ne sont ajoutés qu'une fois.
- Les paiements restés en attente sont revérifiés automatiquement pendant 72 heures.
- Si SasPay n'est pas configuré, l'achat en ligne est refusé avec un message clair : on ne fait jamais semblant.

## Corriger une erreur

On ne supprime ni ne modifie jamais une ligne de l'historique. Une erreur se corrige par une nouvelle ligne :

| Opération | Qui | Effet |
|---|---|---|
| Remboursement | Équipe de la plateforme | Rend des crédits (ex. facture produite par erreur), avec motif |
| Allocation | Équipe de la plateforme | Ajoute des crédits, avec motif |
| Correction | Équipe de la plateforme | Ajoute ou retire des crédits pour rectifier un solde, avec motif ; jamais sous zéro |

Chaque ligne de l'historique indique le type d'opération, le nombre de crédits, le solde avant et après,
la date, la personne et le motif. L'organisation voit son propre historique dans l'écran **Crédits**.

## Ce que l'IA nous coûte (interne)

Les appels aux modèles d'IA ont un coût pour nous (au nombre de « jetons » de texte). L'équipe de la plateforme
le suit dans **Administration › Coûts IA et évaluations** pour piloter nos marges ; il n'est jamais montré au
client comme un prix.
Le prix du crédit doit couvrir ce coût moyen par document : à vérifier avec les chiffres réels avant de fixer
les tarifs des paquets.

## À retenir pour une démonstration

- « Vous payez par facture produite, pas par usage de l'IA. »
- « Un échec ou un doublon ne vous coûte rien. »
- « Votre solde et chaque mouvement sont visibles à tout moment. »
- Les factures portent la mention « Document non fiscal » tant que l'intégration avec la DGI n'est pas validée.
