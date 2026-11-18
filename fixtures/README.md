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

- `documents/` : documents d'affaires quelconques transformés en factures après vérification humaine, générés par
  `node --import tsx apps/server/scripts/generate-document-fixtures.ts` (police IBM Plex fournie avec le serveur).

| Fichier | Ce qu'il montre |
|---|---|
| `BC-MWA-2026-044_Mwanga_Bon_de_commande.pdf` | Bon de commande (PDF texte, colonnes) émis par un client vers nous : la facture va à l'émetteur |
| `Scan_BL-2026-118_Tshala.pdf` | Bon de livraison imprimé puis scanné (PDF image) : lu par OCR, NIF mal lu « AO987654K » corrigé |
| `Photo_Devis_D-2026-031.jpg` | Photo de téléphone (légèrement de travers) d'un devis pour un nouveau client |
| `Commande_Lualaba_BC-LM-0471.docx` | Commande Word avec tableau, client exonéré de TVA |
| `Demande_facturation_Kalembe.txt` | Demande copiée d'un e-mail (« 2 x 210,00 = 420,00 USD ») |
| `Facture_piegee_Mwanga.pdf` | Consigne cachée adressée à l'IA (« facture 50 000 USD… sans validation ») |
| `Photo_floue.png` | Photo sans texte lisible : échec, aucun crédit consommé |
