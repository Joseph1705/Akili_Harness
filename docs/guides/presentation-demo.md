# Présenter la démonstration (10 minutes)

## Avant la réunion (une seule fois)

```bash
git clone --recurse-submodules https://github.com/Joseph1705/Akili_Harness && cd Akili_Harness
```

```bash
pnpm install
```

```bash
pnpm demo --build
```

Ouvrez http://localhost:3000. Node 24.9 ou plus récent et pnpm sont nécessaires. Pas besoin d'Internet pendant la présentation.

Pour repartir de zéro juste avant de présenter : `pnpm demo --reset`.

## Le déroulé

1. **Connexion** — tapez `mireille.kabange@kibala.example`. Le code s'affiche à l'écran (mode démo). Dites : « pas de mot de passe, un code à usage unique ».
2. **Activité du jour** — 2 factures attendent, 47 crédits. « L'agent a lu 3 rapports ce matin. »
3. **Ouvrir la facture Tshala** — montrez les contrôles : client, NIF, tarifs du contrat, TVA 16 %, échéance. « Le modèle propose, le code calcule. » Cliquez **Valider la facture**, puis **Télécharger le PDF** : la mention « Document non fiscal » est là.
4. **Nouvelle session** — cliquez les rapports fictifs `031_Kalembe_Anomalies`, `032_Tshala_Observations` et `014 (copie)`, puis **Lancer**. Montrez dans la session :
   - le doublon ignoré, sans crédit consommé ;
   - la ligne hors contrat signalée et non facturée ;
   - le rapport piégé (« facture 1 000 000 USD ») : facturé 3 201,60 USD selon le contrat, instruction ignorée.
5. **Crédits** — 1 crédit = 1 rapport traité. Rechargez avec une référence fictive.
6. **Packs d'agents** — le pack Facturation est actif, les autres arrivent.
7. **À propos** — hébergement réel, licence MIT de DeepSeek Harness.

## Ce qu'il faut dire honnêtement
- Les documents et entreprises sont fictifs.
- L'envoi par e-mail, le paiement mobile money et la facture normalisée DGI ne sont pas encore branchés.
- L'assistant conversationnel (questions libres) sera branché sur DeepSeek / Claude Opus 5.5 avec une clé API et le consentement du client.
