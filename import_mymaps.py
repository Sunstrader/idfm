#!/usr/bin/env python3
"""Importe une exportation KML/KMZ de Google My Maps.

Google My Maps permet d'exporter une carte en KML/KMZ depuis son menu. Ce
script conserve les repères historiques afin de pouvoir les afficher dans la
nouvelle carte, même lorsqu'ils ne sont pas présents dans le GTFS.
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Optional, Sequence
from xml.etree import ElementTree as ET


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def text_of(element: Optional[ET.Element]) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def parse_coordinates(value: str):
    parts = re.split(r"\s+", value.strip())
    points = []
    for part in parts:
        values = part.split(",")
        if len(values) < 2:
            continue
        try:
            lon, lat = float(values[0]), float(values[1])
            points.append([lat, lon])
        except ValueError:
            continue
    return points


def read_kml(path: Path) -> bytes:
    if path.suffix.lower() != ".kmz":
        return path.read_bytes()
    with zipfile.ZipFile(path) as archive:
        candidates = [name for name in archive.namelist() if name.lower().endswith(".kml")]
        if not candidates:
            raise ValueError("Le KMZ ne contient aucun fichier KML")
        return archive.read(candidates[0])


def parse_mymaps(path: Path) -> dict:
    root = ET.fromstring(read_kml(path))
    points = []
    lines = []
    for placemark in (node for node in root.iter() if local_name(node.tag) == "Placemark"):
        name = text_of(next((child for child in placemark if local_name(child.tag) == "name"), None))
        description = text_of(next((child for child in placemark if local_name(child.tag) == "description"), None))
        for geometry in placemark.iter():
            kind = local_name(geometry.tag)
            if kind not in {"Point", "LineString", "Polygon"}:
                continue
            coordinates = next((child for child in geometry if local_name(child.tag) == "coordinates"), None)
            parsed = parse_coordinates(text_of(coordinates))
            if not parsed:
                continue
            item = {"name": name or "Repère importé", "description": description}
            if kind == "Point":
                item.update({"type": "point", "lat": parsed[0][0], "lng": parsed[0][1]})
                points.append(item)
            else:
                item.update({"type": "line", "coordinates": parsed})
                lines.append(item)
            break
    return {
        "source": str(path),
        "imported_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "points": points,
        "lines": lines,
        "stats": {"points": len(points), "lines": len(lines)},
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kml", type=Path, help="Fichier KML ou KMZ exporté depuis Google My Maps")
    parser.add_argument("--output", type=Path, default=Path("data/mymaps_points.json"))
    parser.add_argument("--merge", type=Path, help="Ajoute les repères au fichier tad_data.json indiqué")
    args = parser.parse_args(argv)

    imported = parse_mymaps(args.kml)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(imported, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.merge:
        data = json.loads(args.merge.read_text(encoding="utf-8"))
        data["legacy_map"] = imported
        args.merge.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"OK : {imported['stats']['points']} repères et {imported['stats']['lines']} tracés importés")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
