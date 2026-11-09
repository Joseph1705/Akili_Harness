# Données fictives de démonstration

Tout ici est inventé (règle 4) : prestataire, donneurs d'ordre, NIF, RCCM, montants, personnes.

- `contracts.json` : le prestataire (Kibala Services SARL), trois donneurs d'ordre et leurs grilles tarifaires.
- `reports/` : rapports d'activité d'octobre 2026, générés par `node --import tsx apps/server/scripts/generate-fixtures.ts`.

| Fichier | Ce qu'il montre |
|---|---|
| `RA-2026-10-014_Tshala_Kipushi.pdf` | Cas nominal, mêmes montants que la maquette (14 801,60 USD TTC) |
| `RA-2026-10-015_Tshala_Kipushi.xlsx` | Rapport Excel |
| `RA-2026-10-021_Kalembe_Forage.pdf` | Quantités décimales (1 240,5 m) |
| `RA-2026-10-022_Kalembe_Transport.csv` | Rapport CSV |
| `RA-2026-10-030_Lualaba_Services.pdf` | Client sans TVA |
| `RA-2026-10-031_Kalembe_Anomalies.pdf` | Ligne hors contrat et quantité au-delà du plafond |
| `RA-2026-10-032_Tshala_Observations.pdf` | Instructions piégées adressées à l'IA (injection de prompt) |
| `RA-2026-10-014_Tshala_Kipushi (copie).pdf` | Doublon exact du premier |
