# 003 — Facturation par crédits prépayés

Date : 2026-11-09 · Statut : proposé · Remplace, pour la facturation, l'abonnement mensuel de la section 4.7

## Contexte
Le fondateur préfère que les entreprises achètent des crédits et rechargent quand ils sont épuisés, plutôt qu'un abonnement mensuel.

## Choix
- **Unité :** 1 crédit = 0,01 USD de prix de vente (configurable). Soldes en milli-crédits entiers.
- **Calcul (code déterministe, règle 6) :** coût fournisseur = jetons × prix publié (entrée, sortie, cache lu, cache écrit), en nano-USD entiers ; débit = coût × (1 + marge) ÷ valeur du crédit, arrondi au supérieur. Marge par défaut 30 %.
- **Moment du débit :** à la réception du bloc `usage` envoyé par le fournisseur, écrit dans le registre avant de transmettre la suite de la réponse.
- **Blocage :** un appel ne démarre que si le solde ≥ seuil minimal (1 crédit par défaut). Un appel en cours n'est pas coupé : le solde peut devenir légèrement négatif, l'appel suivant est refusé (`CREDITS_EXHAUSTED`).
- **Registre :** journal JSON-lines en ajout seul (recharges, débits, corrections), qui sert aussi de piste d'audit. Toute ligne illisible bloque le calcul du solde au lieu de le deviner.
- **Appels interrompus :** inscrits à 0 avec `unmetered: true`, à rapprocher de la facture du fournisseur.
- **Prix inconnu :** appel refusé (`PRICE_UNKNOWN`) plutôt que consommé sans facturer. Chaque prix porte sa source.

## Conséquences
- Recharge manuelle par `pnpm credits topup <org> <crédits> --ref <référence de paiement>` en attendant le mobile money (section 4.7).
- Les prix DeepSeek viennent du catalogue pi-ai, **non vérifiés** sur la page officielle : à confirmer avant toute vente (règle 12).
- La licence signée (section 4.7) reste utile pour l'offre, les sièges et les packs ; seul le paiement passe aux crédits.
- Phase 1 : registre en PostgreSQL avec `org_id` et RLS, même format d'écriture.
