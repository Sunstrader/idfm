#!/usr/bin/env python3
"""Construit une base cartographique des transports à la demande IDFM.

Le script utilise uniquement la bibliothèque standard Python. Il corrige le
principal défaut de l'ancien script : ``stop_times.txt`` ne contient pas
forcément ``route_id``. La relation GTFS correcte est :

    stop_times.trip_id -> trips.route_id -> routes

Les sorties sont adaptées à l'application web fournie dans ``web/`` : JSON,
CSV, GeoJSON et KML importable dans Google My Maps.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Mapping, MutableMapping, Optional, Sequence, Set, Tuple


DEFAULT_GTFS_URL = (
    "https://data.iledefrance-mobilites.fr/api/datasets/1.0/"
    "offre-horaires-tc-gtfs-idfm/files/opendata_gtfs_zip"
)
DEFAULT_API_URL = (
    "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/"
    "datasets/arrets-lignes/records"
)
PROJECT_ROOT = Path(__file__).resolve().parent

PALETTE = [
    "#0B7285", "#1971C2", "#6741D9", "#9C36B5", "#C2255C",
    "#E8590C", "#F08C00", "#5F3DC4", "#087F5B", "#2B8A3E",
    "#364FC7", "#D9480F", "#A61E4D", "#0C8599", "#495057",
]

TAD_MARKERS = (
    "TAD",
    "TRANSPORT A LA DEMANDE",
    "TRANSPORT A DEMANDE",
    "A LA DEMANDE",
    "SUR RESERVATION",
    "RESERVATION OBLIGATOIRE",
    "RESERVATION",
)


def normalize_text(value: object) -> str:
    """Normalise les accents et espaces pour des comparaisons robustes."""
    text = str(value or "")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", text).strip().upper()


def clean_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_float(value: object) -> Optional[float]:
    try:
        number = float(str(value).replace(",", "."))
        if -90 <= number <= 90 or -180 <= number <= 180:
            return number
    except (TypeError, ValueError):
        pass
    return None


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default


def iter_csv_member(archive: zipfile.ZipFile, filename: str) -> Iterator[Dict[str, str]]:
    """Itère sur un fichier CSV GTFS en tolérant BOM et champs absents."""
    try:
        member = archive.getinfo(filename)
    except KeyError:
        return
    with archive.open(member) as raw:
        wrapper = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
        yield from csv.DictReader(wrapper)


def is_tad_route(row: Mapping[str, str]) -> bool:
    haystack = normalize_text(" ".join(
        row.get(field, "") for field in ("route_short_name", "route_long_name", "route_desc")
    ))
    if re.search(r"\bTAD\b", haystack):
        return True
    return any(marker in haystack for marker in TAD_MARKERS[1:])


def split_territory(route: Mapping[str, str]) -> str:
    """Déduit un nom de territoire stable à partir des libellés GTFS."""
    # Le nom long porte généralement le territoire (« TAD Gally-Mauldre »).
    # La description peut contenir seulement « Transport à la demande » et
    # doit donc être essayée après le nom long.
    candidates = [
        clean_text(route.get("route_long_name")),
        clean_text(route.get("route_desc")),
        clean_text(route.get("route_short_name")),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        normalized = normalize_text(candidate)
        pattern = r"\b(?:TAD|TRANSPORT A LA DEMANDE|TRANSPORT A DEMANDE|A LA DEMANDE|SUR RESERVATION|RESERVATION OBLIGATOIRE|RESERVATION)\b"
        parts = [clean_text(part, ) for part in re.split(pattern, candidate, flags=re.IGNORECASE)]
        parts = [re.sub(r"^[\s|:/–—-]+|[\s|:/–—-]+$", "", part).strip() for part in parts]
        useful = [part for part in parts if len(normalize_text(part)) >= 3]
        if useful:
            # Pour « TAD Gally-Mauldre », on garde la partie après TAD ;
            # pour « Gally-Mauldre TAD », on garde la partie avant.
            return max(useful, key=lambda part: len(normalize_text(part)))
        if normalized:
            return candidate
    return "TAD"


def stable_color(key: str) -> str:
    digest = hashlib.sha1(normalize_text(key).encode("utf-8")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def download_bytes(url: str, timeout: int = 120) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "TAD-IDFM-Carto/1.0 (+open-data project)",
            "Accept": "application/zip, application/octet-stream, */*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_api_records(url: str = DEFAULT_API_URL, page_size: int = 100) -> List[dict]:
    """Récupère l'API IDFM en option, sans la rendre obligatoire."""
    records: List[dict] = []
    offset = 0
    where = "route_long_name LIKE '%TAD%' OR route_long_name LIKE '%demande%' OR route_long_name LIKE '%reservation%'"
    while True:
        query = urllib.parse.urlencode({
            "select": "*",
            "limit": page_size,
            "offset": offset,
            "where": where,
        })
        try:
            payload = json.loads(download_bytes(f"{url}?{query}", timeout=45).decode("utf-8"))
        except Exception as exc:  # API facultative : le GTFS reste la source principale.
            print(f"Avertissement : API arrêts-lignes indisponible ({exc})", file=sys.stderr)
            break
        page = payload.get("results", [])
        if not page:
            break
        records.extend(page)
        offset += len(page)
        if len(page) < page_size:
            break
    return records


def parse_gtfs(archive: zipfile.ZipFile, source_url: str = DEFAULT_GTFS_URL) -> dict:
    """Extrait les lignes TAD, arrêts, trajets et tracés du flux GTFS."""
    raw_routes: Dict[str, dict] = {}
    for row in iter_csv_member(archive, "routes.txt"):
        if not row.get("route_id") or not is_tad_route(row):
            continue
        raw_routes[row["route_id"]] = {
            "id": row["route_id"],
            "short_name": clean_text(row.get("route_short_name")),
            "name": clean_text(row.get("route_long_name")) or clean_text(row.get("route_short_name")) or row["route_id"],
            "description": clean_text(row.get("route_desc")),
            "url": clean_text(row.get("route_url")),
            "type": safe_int(row.get("route_type"), 3),
            "color": ("#" + row["route_color"].strip().upper().lstrip("#")) if row.get("route_color") else "",
            "text_color": ("#" + row["route_text_color"].strip().upper().lstrip("#")) if row.get("route_text_color") else "",
            "territory": split_territory(row),
            "stop_ids": [],
            "shape_ids": [],
            "trip_count": 0,
        }

    trip_route: Dict[str, str] = {}
    route_shapes: MutableMapping[str, Set[str]] = defaultdict(set)
    for row in iter_csv_member(archive, "trips.txt"):
        route_id = row.get("route_id", "")
        if route_id not in raw_routes:
            continue
        trip_id = row.get("trip_id", "")
        if not trip_id:
            continue
        trip_route[trip_id] = route_id
        raw_routes[route_id]["trip_count"] += 1
        shape_id = clean_text(row.get("shape_id"))
        if shape_id:
            route_shapes[route_id].add(shape_id)

    route_stops: MutableMapping[str, Set[str]] = defaultdict(set)
    for row in iter_csv_member(archive, "stop_times.txt"):
        route_id = trip_route.get(row.get("trip_id", ""))
        stop_id = clean_text(row.get("stop_id"))
        if route_id and stop_id:
            route_stops[route_id].add(stop_id)

    all_stop_ids = set().union(*route_stops.values()) if route_stops else set()
    stops: Dict[str, dict] = {}
    for row in iter_csv_member(archive, "stops.txt"):
        stop_id = clean_text(row.get("stop_id"))
        if stop_id not in all_stop_ids:
            continue
        lat = safe_float(row.get("stop_lat"))
        lon = safe_float(row.get("stop_lon"))
        if lat is None or lon is None:
            continue
        stops[stop_id] = {
            "id": stop_id,
            "code": clean_text(row.get("stop_code")),
            "name": clean_text(row.get("stop_name")) or stop_id,
            "lat": lat,
            "lng": lon,
            "location_type": safe_int(row.get("location_type"), 0),
            "parent_station": clean_text(row.get("parent_station")),
            "wheelchair_boarding": safe_int(row.get("wheelchair_boarding"), 0),
        }

    shapes: Dict[str, List[List[float]]] = defaultdict(list)
    wanted_shapes = set().union(*(route_shapes.values())) if route_shapes else set()
    for row in iter_csv_member(archive, "shapes.txt"):
        shape_id = clean_text(row.get("shape_id"))
        if shape_id not in wanted_shapes:
            continue
        lat = safe_float(row.get("shape_pt_lat"))
        lon = safe_float(row.get("shape_pt_lon"))
        if lat is not None and lon is not None:
            shapes[shape_id].append([
                safe_int(row.get("shape_pt_sequence"), len(shapes[shape_id])), lat, lon
            ])
    shape_lines = {
        shape_id: [[point[1], point[2]] for point in sorted(points, key=lambda item: item[0])]
        for shape_id, points in shapes.items()
    }

    territories: MutableMapping[str, dict] = {}
    stop_route_ids: MutableMapping[str, Set[str]] = defaultdict(set)
    routes: List[dict] = []
    for route_id, route in sorted(raw_routes.items(), key=lambda item: (item[1]["territory"].lower(), item[1]["name"].lower())):
        stop_ids = sorted(stop_id for stop_id in route_stops.get(route_id, set()) if stop_id in stops)
        shape_ids = sorted(route_shapes.get(route_id, set()))
        route["stop_ids"] = stop_ids
        route["shape_ids"] = shape_ids
        if not route["color"] or len(route["color"]) != 7:
            route["color"] = stable_color(route["territory"] or route["name"])
        for stop_id in stop_ids:
            stop_route_ids[stop_id].add(route_id)
        if not stop_ids:
            continue
        territories.setdefault(route["territory"], {"name": route["territory"], "route_ids": []})["route_ids"].append(route_id)
        routes.append(route)

    for stop_id, stop in stops.items():
        linked_routes = [raw_routes[route_id] for route_id in sorted(stop_route_ids.get(stop_id, set())) if route_id in raw_routes]
        stop["route_ids"] = [route["id"] for route in linked_routes]
        stop["routes"] = [
            {
                "id": route["id"],
                "short_name": route["short_name"],
                "name": route["name"],
                "territory": route["territory"],
                "color": route["color"],
            }
            for route in linked_routes
        ]

    for route in routes:
        route["shapes"] = [shape_id for shape_id in route["shape_ids"] if shape_id in shape_lines]

    return {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "name": "Île-de-France Mobilités — Horaires au format GTFS",
            "gtfs_url": source_url,
            "license": "Licence ouverte / réutilisation selon les prescriptions IDFM",
        },
        "stats": {
            "territories": len(territories),
            "routes": len(routes),
            "stops": sum(1 for stop in stops.values() if stop.get("route_ids")),
            "shapes": len(shape_lines),
        },
        "territories": [
            {
                "name": name,
                "color": stable_color(name),
                "route_ids": sorted(value["route_ids"]),
            }
            for name, value in sorted(territories.items(), key=lambda item: item[0].lower())
        ],
        "routes": routes,
        "stops": [stop for stop in sorted(stops.values(), key=lambda item: item["name"].lower()) if stop.get("route_ids")],
        "shapes": shape_lines,
    }


def write_json(data: dict, output_dir: Path) -> None:
    (output_dir / "tad_data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_csv(data: dict, output_dir: Path) -> None:
    path = output_dir / "tad_stops.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["territoire", "ligne", "nom_ligne", "arret_id", "code", "arret", "latitude", "longitude"])
        routes = {route["id"]: route for route in data["routes"]}
        for stop in data["stops"]:
            for route_id in stop["route_ids"]:
                route = routes[route_id]
                writer.writerow([
                    route["territory"], route["short_name"], route["name"], stop["id"], stop["code"],
                    stop["name"], stop["lat"], stop["lng"],
                ])


def xml_escape(value: object) -> str:
    return (str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def write_kml(data: dict, output_dir: Path) -> None:
    routes = {route["id"]: route for route in data["routes"]}
    placemarks = []
    for stop in data["stops"]:
        route_names = ", ".join(route_display_name(routes[route_id]) for route_id in stop["route_ids"] if route_id in routes)
        description = (
            f"<b>Territoire :</b> {xml_escape(stop['routes'][0]['territory'] if stop.get('routes') else 'TAD')}<br/>"
            f"<b>Lignes :</b> {xml_escape(route_names)}<br/>"
            f"<b>Identifiant :</b> {xml_escape(stop['id'])}"
        )
        placemarks.append(
            "<Placemark>"
            f"<name>{xml_escape(stop['name'])}</name>"
            f"<description><![CDATA[{description}]]></description>"
            f"<Point><coordinates>{stop['lng']},{stop['lat']},0</coordinates></Point>"
            "</Placemark>"
        )
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        '<name>Arrêts TAD Île-de-France</name>' + "".join(placemarks) + "</Document></kml>"
    )
    (output_dir / "tad_stops.kml").write_text(content, encoding="utf-8")


def write_geojson(data: dict, output_dir: Path) -> None:
    routes = {route["id"]: route for route in data["routes"]}
    features = []
    for stop in data["stops"]:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [stop["lng"], stop["lat"]]},
            "properties": {
                "id": stop["id"],
                "name": stop["name"],
                "code": stop["code"],
                "territories": sorted({routes[route_id]["territory"] for route_id in stop["route_ids"] if route_id in routes}),
                "routes": [route_display_name(routes[route_id]) for route_id in stop["route_ids"] if route_id in routes],
            },
        })
    output = {"type": "FeatureCollection", "features": features}
    (output_dir / "tad_stops.geojson").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")


def route_display_name(route: Mapping[str, str]) -> str:
    return route.get("short_name") or route.get("name") or route.get("id", "TAD")


def open_archive(input_path: Optional[Path], url: str) -> Tuple[zipfile.ZipFile, Optional[io.BytesIO]]:
    if input_path:
        return zipfile.ZipFile(input_path), None
    content = download_bytes(url)
    buffer = io.BytesIO(content)
    return zipfile.ZipFile(buffer), buffer


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="ZIP GTFS local à utiliser au lieu du téléchargement")
    parser.add_argument("--url", default=DEFAULT_GTFS_URL, help="URL du flux GTFS IDFM")
    parser.add_argument("--out-dir", type=Path, default=PROJECT_ROOT / "data", help="Dossier des sorties")
    parser.add_argument("--include-api", action="store_true", help="Tente aussi l'API arrêts-lignes, sans remplacer le GTFS")
    args = parser.parse_args(argv)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    print("Téléchargement / ouverture du flux GTFS…")
    try:
        archive, backing = open_archive(args.input, args.url)
    except Exception as exc:
        print(f"Erreur : impossible d'ouvrir le flux GTFS : {exc}", file=sys.stderr)
        return 2
    try:
        data = parse_gtfs(archive, args.url if not args.input else str(args.input))
    finally:
        archive.close()
        if backing is not None:
            backing.close()

    if args.include_api:
        records = fetch_api_records()
        data["source"]["api_records_seen"] = len(records)

    write_json(data, args.out_dir)
    write_csv(data, args.out_dir)
    write_kml(data, args.out_dir)
    write_geojson(data, args.out_dir)
    print(
        f"OK : {data['stats']['routes']} lignes TAD, {data['stats']['stops']} arrêts, "
        f"{data['stats']['territories']} territoires, {data['stats']['shapes']} tracés."
    )
    print(f"Sorties : {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
