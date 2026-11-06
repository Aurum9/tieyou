"""Add search-only Oracle fields without rebuilding translated card shards.

python scripts/build_search_metadata.py

The existing frozen Oracle snapshot must have the same date as the catalog.
Only the new sidecar and its manifest descriptor are written.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def write_search_metadata(cards: list[dict], canonical: dict[str, dict], oracle_date: str, output: Path) -> dict:
    rows = {}
    ranked = 0
    for card in cards:
        source = canonical.get(card["id"])
        if source is None:
            raise ValueError(f"Frozen Oracle source is missing catalog ID {card['id']}")
        source_faces = source.get("card_faces") or [source]
        if [face["name"] for face in source_faces] != [face["name"] for face in card["faces"]]:
            raise ValueError(f"Frozen Oracle face names differ for {card['id']}")
        rank = source.get("edhrec_rank")
        if rank is not None and (type(rank) is not int or rank < 1):
            raise ValueError(f"Invalid EDHREC rank for {card['id']}")
        ranked += rank is not None
        rows[card["id"]] = {
            "edhrecRank": rank,
            "faces": [{"name": face["name"], "power": face.get("power"), "toughness": face.get("toughness")} for face in source_faces],
        }
    document = {"schemaVersion": 1, "oracleDate": oracle_date, "cards": rows}
    data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path = output / "search-metadata.json"
    path.write_bytes(data)
    return {"url": path.name, "oracleDate": oracle_date, "cards": len(rows), "rankedCards": ranked,
            "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE.parent / "web" / "data")
    args = parser.parse_args()
    output = args.output.resolve()
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source = HERE / ".cache" / "oracle_cards.jsonl.gz"
    source_meta = json.loads(source.with_name(source.name + ".metadata.json").read_text(encoding="utf-8"))
    oracle_date = source_meta["source"]["updated_at"]
    if oracle_date != manifest["snapshot"]["oracleDate"]:
        raise ValueError("Oracle snapshot date differs from the frozen catalog; rebuild together instead")
    canonical = {}
    with gzip.open(source, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                if row.get("oracle_id"):
                    canonical[row["oracle_id"]] = row
    cards = []
    for shard in manifest["shards"]:
        path = (output / shard["url"]).resolve()
        if path.parent != output:
            raise ValueError("Catalog shard must be inside the output directory")
        cards.extend(json.loads(path.read_text(encoding="utf-8")))
    if len(cards) != manifest["counts"]["cards"]:
        raise ValueError("Catalog count differs from its manifest")
    manifest["searchMetadata"] = write_search_metadata(cards, canonical, oracle_date, output)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest["searchMetadata"], ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
