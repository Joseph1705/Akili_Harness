# 001 — Base DeepSeek Harness figée en sous-module

Date : 2026-11-09 · Statut : proposé (à valider par le fondateur)

## Contexte
Directive section 3 : base `dsh`, plugins uniquement, version figée. dsh est en « developer preview » : ruptures de compatibilité annoncées.

## Options
1. Copier les sources de dsh dans `vendor/` (202 Mo, historique perdu, mise à jour manuelle).
2. Sous-module git pointant sur un commit précis.
3. Dépendre du paquet npm `@deepseek-ai/dsh`.

## Choix
Option 2 : `vendor/deepseek-harness`, commit `fcc0ad4621` = version `0.2.2-rc.1` (2026-11-04). Le dépôt ne contient que la référence au commit ; aucune modification du cœur n'est possible sans que `git status` le montre.

## Conséquences
- Installation : `git submodule update --init`, puis dans `vendor/deepseek-harness` : `CI=true pnpm install --frozen-lockfile && pnpm run build`. `CI=true` saute l'installation des hooks git de dsh (lefthook), qui échoue dans un sous-module.
- **Écart avec la directive :** la directive indique Node `^22.19.0 || >=24.0.0` ; dsh 0.2.2-rc.1 exige **Node `>=24.9.0`** (`package.json`, champ `engines`). La documentation officielle a raison (règle 5 de la section 0).
- Le lockfile de dsh télécharge `xlsx` depuis `cdn.sheetjs.com` : cet hôte doit être autorisé par le réseau de build.
- Montée de version : branche dédiée, nouveau commit du sous-module, `pnpm smoke` + `pnpm test` verts (règle 3).
- Nos plugins se montent par une surcouche Cordis (`config/akili.patch.yml`) passée à `dsh <profil> --patch` ; chemins absolus générés par `scripts/dsh.mjs`.
