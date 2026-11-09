# 004 — Aucune métadonnée ni télémétrie vers DeepSeek

Date : 2026-11-09 · Statut : appliqué

## Constat (dsh 0.2.2-rc.1)
- `plugin-package-inventory-deepseek` ajoute la liste des plugins installés (`dsh_plugin_packages`) à chaque requête vers l'API DeepSeek officielle.
- `session-telemetry-otel` exporte vers `https://dsh-otel-collector.deepseeksvc.com/v1/logs` (mode `FEEDBACK_ONLY` par défaut).
- `desktop-product-telemetry` / `product-analytics` ne sont actifs que dans le profil desktop.

## Choix
Règles 4 et 5 : rien ne part en dehors de la requête de modèle elle-même.
- Surcouche : `plugin-package-inventory-deepseek` → `enabled: false`.
- `scripts/dsh.mjs` lance toujours dsh avec `DSH_TELEMETRY_DISABLED=1` (dsh désactive alors la ligne de télémétrie au démarrage ; une surcouche ne peut pas le faire).

## À faire
Revoir la télémétrie desktop avant la phase 5, et refaire cet inventaire à chaque montée de version de dsh.
