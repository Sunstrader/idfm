from __future__ import annotations

import csv
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import update_tad_data  # noqa: E402


def make_gtfs_zip() -> zipfile.ZipFile:
    files = {
        "routes.txt": "route_id,route_short_name,route_long_name,route_desc,route_type\nregular,10,Bus régulier,,3\ntad1,TAD 1,TAD Vallée de Test,Transport à la demande,3\n",
        "trips.txt": "route_id,service_id,trip_id,shape_id\ntad1,weekday,trip-1,shape-1\ntad1,weekday,trip-2,shape-1\nregular,weekday,regular-trip,\n",
        "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip-1,08:00:00,08:00:00,s1,1\ntrip-1,08:05:00,08:05:00,s2,2\ntrip-2,09:00:00,09:00:00,s1,1\nregular-trip,08:00:00,08:00:00,s3,1\n",
        "stops.txt": "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type\ns1,A1,Mairie Test,48.1000,1.1000,0\ns2,A2,Gare Test,48.1100,1.1200,0\ns3,A3,Arrêt régulier,48.1200,1.1300,0\n",
        "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshape-1,48.1000,1.1000,1\nshape-1,48.1100,1.1200,2\n",
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    buffer.seek(0)
    return zipfile.ZipFile(buffer)


class PipelineTests(unittest.TestCase):
    def test_gtfs_relation_uses_trips(self):
        with make_gtfs_zip() as archive:
            data = update_tad_data.parse_gtfs(archive, "fixture")
        self.assertEqual(data["stats"]["routes"], 1)
        self.assertEqual(data["stats"]["stops"], 2)
        self.assertEqual(data["routes"][0]["territory"], "Vallée de Test")
        self.assertEqual(data["routes"][0]["stop_ids"], ["s1", "s2"])
        self.assertEqual(data["routes"][0]["shapes"], ["shape-1"])

    def test_outputs_are_reusable(self):
        with make_gtfs_zip() as archive, tempfile.TemporaryDirectory() as temp:
            data = update_tad_data.parse_gtfs(archive, "fixture")
            output = Path(temp)
            update_tad_data.write_json(data, output)
            update_tad_data.write_csv(data, output)
            update_tad_data.write_kml(data, output)
            update_tad_data.write_geojson(data, output)
            self.assertEqual(json.loads((output / "tad_data.json").read_text())["stats"]["stops"], 2)
            self.assertIn("Mairie Test", (output / "tad_stops.csv").read_text(encoding="utf-8-sig"))
            self.assertIn("<kml", (output / "tad_stops.kml").read_text())
            self.assertEqual(json.loads((output / "tad_stops.geojson").read_text())["type"], "FeatureCollection")

    def test_route_classification(self):
        self.assertTrue(update_tad_data.is_tad_route({"route_long_name": "Service à la demande"}))
        self.assertTrue(update_tad_data.is_tad_route({"route_long_name": "TAD 52"}))
        self.assertFalse(update_tad_data.is_tad_route({"route_long_name": "Ligne régulière 52"}))


if __name__ == "__main__":
    unittest.main()
