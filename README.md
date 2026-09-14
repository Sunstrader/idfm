# TAD Île-de-France — carte interactive

Projet autonome pour reconstruire une carte complète des transports à la demande (TAD) d’Île-de-France à partir du flux GTFS officiel d’Île-de-France Mobilités.

Le projet remplace le traitement initial qui cherchait directement `route_id` dans `stop_times.txt`. La relation GTFS correcte est utilisée :

```text
stop_times.trip_id → trips.route_id → routes
```

## Ce que contient le projet

- récupération du GTFS IDFM sans dépendance Python externe ;
- détection des lignes TAD, « à la demande » et « sur réservation » ;
- récupération des arrêts, lignes, territoires et tracés théoriques ;
- carte responsive avec recherche, filtres, regroupement des marqueurs et fiches arrêts ;
- affichage facultatif des tracés GTFS et des repères importés depuis l’ancienne carte ;
- exports JSON, CSV, GeoJSON et KML compatible Google My Maps ;
- import d’une exportation KML/KMZ de la carte historique ;
- tests locaux sans réseau.

## Lancer la carte immédiatement

Le dossier contient un petit jeu de données de démonstration afin de vérifier l’interface sans téléchargement.

Depuis le dossier `tad-idfm-carte` :

```bash
python3 -m http.server 8000
```

Puis ouvrir :

```text
http://localhost:8000/web/
```

Le fichier de démonstration `data/tad_data.example.json` est automatiquement utilisé si les données réelles ne sont pas encore générées.

## Générer les données réelles

```bash
python3 update_tad_data.py
python3 -m http.server 8000
```

La commande remplace ou crée dans `data/` :

- `tad_data.json` : données complètes utilisées par la carte ;
- `tad_stops.csv` : un arrêt par ligne et par ligne TAD ;
- `tad_stops.geojson` : points pour un SIG ;
- `tad_stops.kml` : import direct dans Google My Maps.

Pour utiliser un fichier GTFS déjà téléchargé :

```bash
python3 update_tad_data.py --input /chemin/vers/gtfs.zip
```

L’API IDFM complémentaire est optionnelle :

```bash
python3 update_tad_data.py --include-api
```

Le GTFS reste la source principale, car il contient la relation fiable entre les trajets, les lignes et les arrêts.

## Conserver l’ancienne carte Google My Maps

Dans Google My Maps, exporter l’ancienne carte en KML ou KMZ, puis lancer :

```bash
python3 import_mymaps.py /chemin/vers/ancienne-carte.kml --merge data/tad_data.json
```

Les repères et tracés historiques sont alors conservés dans `legacy_map` et peuvent être affichés avec l’interrupteur **Repères importés**.

## Tests

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile update_tad_data.py import_mymaps.py
```

Les tests vérifient notamment le bug principal de l’ancienne version : les arrêts sont retrouvés en passant par `trips.txt`, même lorsque `stop_times.txt` ne contient pas `route_id`.

## Publication pour des collègues

Le dépôt contient aussi une version statique prête pour GitHub Pages. La page
est utilisable directement sur PC, sans installation côté collègue. Le fichier
`.github/workflows/update-data.yml` actualise automatiquement les données IDFM
et `.github/workflows/pages.yml` republie la carte après chaque mise à jour.

## Sources et limites

Les données GTFS décrivent l’offre théorique publiée par IDFM. Elles ne garantissent pas les horaires réels, les perturbations, les conditions de réservation ou le numéro de téléphone de chaque service. Ces informations peuvent être ajoutées plus tard depuis les fiches officielles des territoires.

La carte utilise les fonds OpenStreetMap. L’attribution affichée dans l’interface doit rester présente.

Sources :

- [Open Data Île-de-France Mobilités](https://data.iledefrance-mobilites.fr/)
- [Jeu de données GTFS IDFM sur transport.data.gouv.fr](https://transport.data.gouv.fr/datasets/reseau-urbain-et-interurbain-dile-de-france-mobilites)
- [Référence officielle GTFS](https://gtfs.org/)
