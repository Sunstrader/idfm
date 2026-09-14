#!/usr/bin/env python3
"""Prépare la version statique à publier sur GitHub Pages."""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "github-pages"


def main() -> None:
    if TARGET.exists():
        shutil.rmtree(TARGET)
    (TARGET / "assets").mkdir(parents=True)
    (TARGET / "data").mkdir(parents=True)
    shutil.copy2(ROOT / "web" / "index.html", TARGET / "index.html")
    shutil.copytree(ROOT / "web" / "assets", TARGET / "assets", dirs_exist_ok=True)
    source = ROOT / "data" / "tad_data.json"
    if not source.exists():
        source = ROOT / "data" / "tad_data.example.json"
    shutil.copy2(source, TARGET / "data" / "tad_data.json")
    (TARGET / ".nojekyll").write_text("", encoding="utf-8")
    (TARGET / "README.md").write_text(
        """# Carte TAD IDFM — version publique\n\nCette version est prête pour GitHub Pages. Les collègues ouvrent simplement l'URL du site.\n\nPour mettre à jour les données depuis le projet parent :\n\n```bash\npython3 update_tad_data.py\npython3 build_github_pages.py\n```\n\nLe dossier `github-pages` est ensuite le contenu à publier.\n""",
        encoding="utf-8",
    )
    print(f"Version GitHub Pages générée dans : {TARGET}")
    print(f"Données copiées depuis : {source}")


if __name__ == "__main__":
    main()
