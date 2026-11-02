"""Build the static bilingual catalog from public snapshots.

python app/scripts/refresh_catalog_sources.py  # optional bounded network refresh
python app/scripts/build_catalog.py          # deterministic local build

All legacy inputs are read-only. Malformed source rows are repaired only when
collapsing doubled quote escapes yields valid JSON, and are retained in the audit.
Community/official labels describe provenance, never a guarantee of review.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import io
import json
import re
import tarfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OUTPUT = HERE.parent / "dist" / "data"
LEGACY = Path("C:/Users/1482/Documents/New project 2")
EXCLUDED_LAYOUTS = {"token", "double_faced_token", "emblem", "art_series", "planar", "scheme", "vanguard"}
EXCLUDED_SET_TYPES = {"token", "memorabilia", "art_series", "minigame"}


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def normalize_text(value: str | None) -> str:
    """Normalize only the known SQL-export extra escapes; preserve all wording."""
    if not value:
        return ""
    value = re.sub(r"\\+n", "\n", value)
    value = re.sub(r"\\+r", "", value)
    value = re.sub(r"\\+t", "\t", value)
    value = re.sub(r'\\+"', '"', value)
    return value.strip()


def text_fingerprint(value: str | None) -> str:
    return re.sub(r"\s+", " ", normalize_text(value)).strip()


def parse_source_row(raw: str) -> tuple[dict, bool]:
    try:
        return json.loads(raw), False
    except json.JSONDecodeError as original_error:
        # Known export defect: an internal \" is emitted as \\".
        # This transformation is attempted only on a row standard JSON rejected.
        fixed = re.sub(r'(?<!\\)(\\{2,})(?=")', lambda m: "\\" * (len(m[0]) - 1) if len(m[0]) % 2 == 0 else m[0], raw)
        try:
            return json.loads(fixed), True
        except json.JSONDecodeError:
            raise original_error


def read_source_rows(handle, name: str, audit_handle, statistics: dict):
    stats = statistics.setdefault(name, {"rows": 0, "repaired": 0, "failed": 0})
    for line_number, line in enumerate(handle, 1):
        raw = line.decode("utf-8") if isinstance(line, bytes) else line
        if not raw.strip():
            continue
        stats["rows"] += 1
        try:
            row, repaired = parse_source_row(raw)
        except json.JSONDecodeError as error:
            stats["failed"] += 1
            audit_handle.write(dumps({"file": name, "line": line_number, "status": "failed", "sha256": hashlib.sha256(raw.encode()).hexdigest(), "error": str(error), "raw": raw.rstrip("\r\n")}) + "\n")
            continue
        if repaired:
            stats["repaired"] += 1
            audit_handle.write(dumps({"file": name, "line": line_number, "status": "repaired", "method": "collapse_even_quote_escape", "sha256": hashlib.sha256(raw.encode()).hexdigest(), "raw": raw.rstrip("\r\n")}) + "\n")
        yield row


class RepairAudit:
    """Retain every repaired raw line in bounded, independently readable chunks."""
    def __init__(self, directory: Path):
        self.directory = directory
        self.chunks = []
        self.handle = None
        self.raw_bytes = 0
        self.rows = 0
        self.path = None

    def __enter__(self):
        return self

    def write(self, value: str):
        if self.handle is None or self.raw_bytes + len(value.encode("utf-8")) > 20_000_000:
            self.close_chunk()
            self.path = self.directory / f"source-repair-audit-{len(self.chunks):03d}.jsonl.gz"
            self.handle = gzip.open(self.path, "wt", encoding="utf-8")
            self.raw_bytes = 0
            self.rows = 0
        self.handle.write(value)
        self.raw_bytes += len(value.encode("utf-8"))
        self.rows += 1

    def close_chunk(self):
        if self.handle is not None:
            self.handle.close()
            self.chunks.append({"url": self.path.name, "rows": self.rows, "bytes": self.path.stat().st_size,
                                "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest()})
            self.handle = None

    def __exit__(self, *args):
        self.close_chunk()
        (self.directory / "source-repair-audit.json").write_text(json.dumps({"chunks": self.chunks}, indent=2), encoding="utf-8")


def read_snapshot(path: Path):
    if path.name.endswith(".jsonl.gz"):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)
    else:
        yield from json.loads(path.read_text(encoding="utf-8"))


def included(card: dict, freeze_date: str) -> bool:
    return ("paper" in (card.get("games") or []) and not card.get("digital")
            and not card.get("oversized")
            and card.get("layout") not in EXCLUDED_LAYOUTS
            and card.get("set_type") not in EXCLUDED_SET_TYPES
            and card.get("released_at", "9999") <= freeze_date)


def image_uri(card: dict, print_id: str = "", face_index: int = 0) -> str:
    uris = card.get("image_uris") or {}
    image = uris.get("normal") or uris.get("display") or ""
    if image:
        return image
    if card.get("card_faces"):
        return image_uri(card["card_faces"][face_index], card.get("id", print_id), face_index)
    if print_id:
        side = "front" if face_index == 0 else "back"
        return f"https://cards.scryfall.io/normal/{side}/{print_id[0]}/{print_id[1]}/{print_id}.jpg"
    return ""


def version_from(card: dict) -> dict:
    version = {"id": card.get("id") or card["scryfall_id"], "set": (card.get("set") or card.get("set_code", "")).lower(),
            "setName": card.get("set_name", ""), "collectorNumber": str(card.get("collector_number", "")),
            "lang": card.get("lang", "en"), "releasedAt": card.get("released_at", ""),
            "image": image_uri(card, card.get("id") or card.get("scryfall_id", "")), "rarity": card.get("rarity", "")}
    if card.get("card_faces"):
        whole_uris = card.get("image_uris") or {}
        whole_image = whole_uris.get("normal") or whole_uris.get("display") or ""
        version["faceImages"] = []
        for face in card["card_faces"]:
            uris = face.get("image_uris") or {}
            # A split/adventure printing has a real whole-card image. Never
            # invent a back URL or borrow a face from another printing.
            version["faceImages"].append(uris.get("normal") or uris.get("display") or whole_image)
    return version


def translation_for(row: dict | None, oracle_text: str) -> dict:
    if not row or (oracle_text and not normalize_text(row.get("translated_text"))):
        return {"source": "", "status": "missing", "stale": False, "freshness": "missing", "reviewStatus": "unknown"}
    source = row.get("text_source") or row.get("name_source") or "magic-cards-zhs (source unspecified)"
    upstream_ai = source.lower() in {"gpt", "ai", "chatgpt", "machine translation"}
    baseline = row.get("oracle_text")
    stale = baseline is not None and text_fingerprint(baseline) != text_fingerprint(oracle_text)
    return {"source": source, "status": "official" if source == "Chinese Simplified" else "community",
            "stale": stale, "freshness": "stale" if stale else ("matched" if baseline is not None else "unknown"),
            "reviewStatus": "unreviewed" if upstream_ai else "unknown", "upstreamAI": upstream_ai, "sourceStage": row.get("text_stage"),
            "englishSha256": hashlib.sha256(normalize_text(baseline).encode()).hexdigest() if baseline is not None else None}


def load_translation_overrides(path: Path, *, required: bool = False) -> dict:
    if not path.exists():
        if required:
            raise FileNotFoundError(f"translation overrides not found: {path}")
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or not isinstance(payload.get("overrides"), list):
        raise ValueError("translation overrides require schemaVersion:1 and an overrides array")
    result = {}
    for entry in payload["overrides"]:
        for field in ("oracleId", "faceName", "source", "version", "oracleText", "originalText", "translatedText", "reason"):
            if not isinstance(entry.get(field), str) or (field != "originalText" and not entry[field].strip()):
                raise ValueError(f"translation override requires string field {field}")
        key = (entry["oracleId"], entry["faceName"])
        if key in result:
            raise ValueError(f"duplicate translation override: {key}")
        result[key] = entry
    return result


def apply_translation_override(entry: dict, english: str, chinese: str, translation: dict) -> tuple[str, dict]:
    """Apply a specifically reviewed correction only against its exact baseline."""
    if normalize_text(entry["oracleText"]) != normalize_text(english):
        raise ValueError(f"English baseline changed for override {entry['oracleId']} / {entry['faceName']}; review required")
    if normalize_text(entry["originalText"]) != chinese:
        raise ValueError(f"Chinese baseline changed for override {entry['oracleId']} / {entry['faceName']}; review required")
    revised = normalize_text(entry["translatedText"])
    result = dict(translation)
    result.update(stale=False, freshness="matched", reviewStatus="ai-reviewed",
                  englishSha256=hashlib.sha256(normalize_text(english).encode()).hexdigest())
    # Retain original source/sourceStage and distinguish AI correction provenance.
    result["override"] = {key: entry[key] for key in ("source", "version", "originalText", "translatedText", "reason")}
    result["override"]["originalSource"] = translation.get("source", "")
    result["override"]["originalSourceStage"] = translation.get("sourceStage")
    result["override"]["previousEnglishSha256"] = translation.get("englishSha256")
    return revised, result


def load_aliases() -> dict[str, list[str]]:
    path = LEGACY / "data/index/card_aliases.json"
    result = collections.defaultdict(list)
    if path.exists():
        for zh, english in json.loads(path.read_text(encoding="utf-8")).items():
            result[english].append(zh)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze-date", default="2026-11-03")
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument("--overrides", type=Path, default=None, help="Optional reviewed correction file; defaults to scripts/translation-overrides.json if present")
    args = parser.parse_args()
    override_path = args.overrides or HERE / "translation-overrides.json"
    overrides = load_translation_overrides(override_path, required=args.overrides is not None)
    applied_overrides = []
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    metadata_path = CACHE / "scryfall-bulk.metadata.json"
    bulk = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {"data": []}
    meta = {item["type"]: item for item in bulk["data"]}
    for source_type in ("oracle_cards", "default_cards", "oracle_tags"):
        bound_path = CACHE / (source_type + ".jsonl.gz.metadata.json")
        if bound_path.exists():
            meta[source_type] = json.loads(bound_path.read_text(encoding="utf-8"))["source"]
    oracle_path = CACHE / "oracle_cards.jsonl.gz"
    fresh_oracle = oracle_path.exists()
    if fresh_oracle:
        oracle_date = meta["oracle_cards"]["updated_at"]
    else:
        oracle_path = LEGACY / "data/raw/scryfall/oracle_cards.json"
        oracle_date = json.loads((oracle_path.parent / "oracle_cards.metadata.json").read_text(encoding="utf-8"))["updated_at"]
    # An Oracle representative can be a future reprint or an MTGO edition of a
    # genuine paper card. Actual released paper PRINTINGS determine this pool.
    canonical = {card["oracle_id"]: card for card in read_snapshot(oracle_path)
                 if card.get("oracle_id") and card.get("layout") not in EXCLUDED_LAYOUTS}
    print(f"Read {len(canonical)} candidate Oracle identities; resolving physical printings", flush=True)
    chinese_archive = CACHE / "chinese.tar.gz"
    archive = tarfile.open(chinese_archive, "r:gz") if chinese_archive.exists() else None
    release_path = CACHE / "chinese.tar.gz.metadata.json"
    release = json.loads(release_path.read_text(encoding="utf-8"))["source"] if archive and release_path.exists() else {}
    chinese_date = release.get("tag_name", "data-2026-04-13").removeprefix("data-")
    chinese_url = release.get("html_url", "https://github.com/HeliumOctahelide/magic-cards-zhs/releases/tag/data-2026-04-13")
    statistics = {}
    zhs_by_face = {}
    mapping = {}
    versions = collections.defaultdict(dict)
    print_overrides = collections.defaultdict(list)

    def source_handle(name):
        if archive:
            member = next(m for m in archive.getmembers() if m.name.rsplit("/", 1)[-1] == name)
            return archive.extractfile(member)
        return (LEGACY / "data/raw/magic-cards-zhs" / name).open("rb")

    with RepairAudit(output) as audit:
        with source_handle("zhs_oracle.json") as handle:
            for row in read_source_rows(handle, "zhs_oracle.json", audit, statistics):
                key = (row.get("oracle_id"), row.get("name"))
                if key not in zhs_by_face or normalize_text(row.get("translated_text")):
                    zhs_by_face[key] = row
        with source_handle("scryfall_card.json") as handle:
            for row in read_source_rows(handle, "scryfall_card.json", audit, statistics):
                oid = row.get("oracle_id")
                if oid not in canonical:
                    continue
                mapping[row["uuid"]] = {field: row.get(field) for field in ["oracle_id", "face_oracle_id", "face_index", "name", "face_name", "oracle_text", "released_at"]}
                if included(row, args.freeze_date):
                    version = version_from(row)
                    versions[oid][version["id"]] = version
        with source_handle("zhs_card.json") as handle:
            for row in read_source_rows(handle, "zhs_card.json", audit, statistics):
                related = mapping.get(row.get("card_id"))
                if not related:
                    continue
                oid = related["oracle_id"]
                # Printed wording is used only to fill an absent Oracle translation.
                # Preserve its own English baseline so old print wording is flagged.
                override = {"name": related.get("face_name") or related.get("name"),
                            "translated_name": row.get("face_name") or row.get("name"),
                            "translated_type": row.get("type_line"), "translated_text": row.get("text"),
                            "oracle_text": related.get("oracle_text"), "text_source": row.get("source"),
                            "former_names": [], "released_at": related.get("released_at", "")}
                print_overrides[(oid, override["name"])].append(override)
    if archive:
        archive.close()
    print(f"Parsed Chinese sources: {statistics}", flush=True)
    del mapping

    default_path = CACHE / "default_cards.jsonl.gz"
    default_count = 0
    fallback_prints = {}
    if default_path.exists():
        for row in read_snapshot(default_path):
            oid = row.get("oracle_id")
            if oid in canonical and included(row, args.freeze_date):
                version = version_from(row)
                versions[oid][version["id"]] = version
                default_count += 1
                if not included(canonical[oid], args.freeze_date):
                    current = fallback_prints.get(oid)
                    if current is None or (row.get("released_at", ""), row["id"]) > (current.get("released_at", ""), current["id"]):
                        fallback_prints[oid] = row
    for oid, row in canonical.items():
        if included(row, args.freeze_date):
            version = version_from(row)
            versions[oid][version["id"]] = version
    canonical = {oid: fallback_prints.get(oid, row) for oid, row in canonical.items() if versions[oid]}
    print(f"Resolved {len(canonical)} released physical card identities", flush=True)
    tags_by_id = collections.defaultdict(set)
    vocabulary = []
    tags_path = CACHE / "oracle_tags.jsonl.gz"
    if tags_path.exists():
        tag_rows = list(read_snapshot(tags_path))
        tag_index = {t["id"]: t for t in tag_rows}

        def ancestors(tag_id, visited=None):
            visited = set() if visited is None else visited
            if tag_id in visited or tag_id not in tag_index:
                return set()
            visited.add(tag_id)
            result = {tag_id}
            for parent_id in tag_index[tag_id].get("parent_ids", []):
                result.update(ancestors(parent_id, visited))
            return result

        expanded = {}
        for tag in tag_rows:
            ancestor_rows = [tag_index[t] for t in ancestors(tag["id"])]
            expanded[tag["id"]] = {r["slug"] for r in ancestor_rows}
            for ancestor in ancestor_rows:
                expanded[tag["id"]].update(ancestor.get("aliases", []))
            vocabulary.append({"slug": tag["slug"], "label": tag.get("label", ""), "aliases": tag.get("aliases", []), "description": tag.get("description", ""), "url": tag.get("uri", ""),
                               "parentSlugs": [tag_index[t]["slug"] for t in tag.get("parent_ids", []) if t in tag_index]})
        for tag in tag_rows:
            for tagging in tag.get("taggings", []):
                oid = tagging.get("oracle_id")
                if oid in canonical:
                    tags_by_id[oid].update(expanded[tag["id"]])
    (output / "tag-vocabulary.json").write_text(dumps(vocabulary), encoding="utf-8")
    aliases = load_aliases()
    cards = []
    missing = []
    stale = []
    freshness_unknown = []
    name_missing = []
    coverage = {"requiredFaces": 0, "translatedFaces": 0, "missingFaces": 0, "staleFaces": 0}
    face_count = 0
    translation_sources = collections.Counter()
    template_replacements = 0
    upstream_ai_faces = 0
    for oid, canonical_card in canonical.items():
        faces = []
        card_aliases = set(aliases.get(canonical_card["name"], []))
        for face_index, face in enumerate(canonical_card.get("card_faces") or [canonical_card]):
            name = face["name"]
            english = face.get("oracle_text", "")
            row = zhs_by_face.get((oid, name))
            if (not row or not normalize_text(row.get("translated_text"))) and english:
                candidates = print_overrides.get((oid, name), [])
                candidates = sorted(candidates, key=lambda r: (text_fingerprint(r.get("oracle_text")) == text_fingerprint(english), r.get("released_at", "")), reverse=True)
                row = next((r for r in candidates if normalize_text(r.get("translated_text"))), row)
            zh_name = normalize_text((row or {}).get("translated_name"))
            if " // " in zh_name and " // " not in name:
                name_parts = zh_name.split(" // ")
                if face_index < len(name_parts):
                    zh_name = name_parts[face_index]
            zh_type = normalize_text((row or {}).get("translated_type"))
            zh_text = normalize_text((row or {}).get("translated_text"))
            if zh_name and "CARDNAME" in zh_text:
                template_replacements += zh_text.count("CARDNAME")
                zh_text = zh_text.replace("CARDNAME", zh_name)
            translation = translation_for(row, english)
            override_key = (oid, name)
            if override_key in overrides:
                zh_text, translation = apply_translation_override(overrides[override_key], english, zh_text, translation)
                applied_overrides.append({"oracleId": oid, "faceName": name, **translation["override"]})
            if english.strip():
                coverage["requiredFaces"] += 1
                if zh_text:
                    coverage["translatedFaces"] += 1
                    translation_sources[translation["source"]] += 1
                    upstream_ai_faces += bool(translation.get("upstreamAI"))
                    if translation["stale"]:
                        coverage["staleFaces"] += 1
                        stale.append({"oracleId": oid, "name": name, "zhName": zh_name, "source": translation["source"]})
                    if translation["freshness"] == "unknown":
                        freshness_unknown.append({"oracleId": oid, "name": name})
                else:
                    coverage["missingFaces"] += 1
                    missing.append({"oracleId": oid, "faceIndex": face_index, "name": name, "releasedAt": canonical_card.get("released_at", "")})
            if not zh_name:
                name_missing.append({"oracleId": oid, "name": name})
            for alias in (row or {}).get("former_names") or []:
                card_aliases.add(normalize_text(alias))
            if zh_name:
                card_aliases.add(zh_name)
            face_id = (row or {}).get("face_oracle_id") or face.get("oracle_id") or f"{oid}:{face_index}"
            faces.append({"id": face_id, "name": name, "zhName": zh_name, "typeLine": face.get("type_line", ""),
                          "zhTypeLine": zh_type, "manaCost": face.get("mana_cost", ""), "oracleText": english,
                          "zhText": zh_text, "image": image_uri(face) or image_uri(canonical_card), "translation": translation})
        face_count += len(faces)
        front = faces[0]
        card_translation = dict(front["translation"])
        if any(f["oracleText"].strip() and f["translation"]["status"] == "missing" for f in faces):
            card_translation.update(status="missing", freshness="missing")
        card_translation["stale"] = any(f["translation"]["stale"] for f in faces)
        card_translation["upstreamAI"] = any(f["translation"].get("upstreamAI", False) for f in faces)
        if card_translation["upstreamAI"]:
            card_translation["reviewStatus"] = "unreviewed"
        corrected_faces = [f for f in faces if f["translation"].get("override")]
        if corrected_faces:
            card_translation["overrideFaces"] = [f["name"] for f in corrected_faces]
            required_faces = [f for f in faces if f["oracleText"].strip()]
            if all(f["translation"].get("override") for f in required_faces):
                card_translation["reviewStatus"] = "ai-reviewed"
        cards.append({"id": oid, "name": canonical_card["name"], "zhName": " // ".join(f["zhName"] for f in faces) if all(f["zhName"] for f in faces) else front["zhName"],
                      "aliases": sorted(a for a in card_aliases if a), "manaCost": front["manaCost"],
                      "manaValue": canonical_card.get("cmc", 0), "colors": canonical_card.get("colors", faces and (canonical_card.get("card_faces") or [{}])[0].get("colors", [])),
                      "colorIdentity": canonical_card.get("color_identity", []), "typeLine": canonical_card.get("type_line", front["typeLine"]),
                      "zhTypeLine": " // ".join(f["zhTypeLine"] for f in faces), "oracleText": "\n\n".join(f["oracleText"] for f in faces),
                      "zhText": "\n\n".join(f["zhText"] for f in faces), "legalities": {"commander": canonical_card.get("legalities", {}).get("commander", "not_legal")},
                      "set": canonical_card.get("set", ""), "collectorNumber": canonical_card.get("collector_number", ""),
                      "defaultVersionId": canonical_card["id"],
                      "releasedAt": canonical_card.get("released_at", ""), "image": image_uri(canonical_card), "layout": canonical_card.get("layout", ""),
                      "keywords": canonical_card.get("keywords", []), "producedMana": canonical_card.get("produced_mana", []), "rarity": canonical_card.get("rarity", ""),
                      "lang": canonical_card.get("lang", "en"), "faces": faces,
                      "versions": sorted(versions[oid].values(), key=lambda v: (v["releasedAt"], v["set"], v["collectorNumber"]), reverse=True),
                      "translation": card_translation, "tags": sorted(tags_by_id[oid])})
    cards.sort(key=lambda c: (c["name"].casefold(), c["id"]))
    applied_keys = {(entry["oracleId"], entry["faceName"]) for entry in applied_overrides}
    if set(overrides) - applied_keys:
        raise ValueError(f"translation override targets not found in frozen card pool: {sorted(set(overrides) - applied_keys)}")
    # Bounded shards avoid hosting per-file limits and permit progressive loading.
    shards = []
    current = []
    current_bytes = 2
    for card in cards:
        serialized = dumps(card)
        size = len(serialized.encode("utf-8")) + 1
        if current and current_bytes + size > 8_000_000:
            filename = f"catalog-{len(shards):03d}.json"
            (output / filename).write_text("[" + ",".join(current) + "]", encoding="utf-8")
            shards.append({"url": filename, "count": len(current), "bytes": current_bytes})
            current = []
            current_bytes = 2
        current.append(serialized)
        current_bytes += size
    if current:
        filename = f"catalog-{len(shards):03d}.json"
        (output / filename).write_text("[" + ",".join(current) + "]", encoding="utf-8")
        shards.append({"url": filename, "count": len(current), "bytes": current_bytes})
    sources = [{"name": "Scryfall Oracle Cards", "url": meta.get("oracle_cards", {}).get("jsonl_download_uri", "https://scryfall.com/docs/api/bulk-data"), "date": oracle_date},
               {"name": "magic-cards-zhs (CC BY-SA 4.0)", "url": chinese_url, "date": chinese_date},
               {"name": "Scryfall Default Cards", "url": meta.get("default_cards", {}).get("jsonl_download_uri", ""), "date": meta.get("default_cards", {}).get("updated_at", "")},
               {"name": "Scryfall Oracle Tags", "url": meta.get("oracle_tags", {}).get("jsonl_download_uri", ""), "date": meta.get("oracle_tags", {}).get("updated_at", "")}]
    manifest = {"schemaVersion": 1, "updatedAt": datetime.now(timezone.utc).isoformat(), "freezeDate": args.freeze_date,
                "snapshot": {"oracleDate": oracle_date, "chineseDate": chinese_date},
                "counts": {"cards": len(cards), "faces": face_count, "versions": sum(len(c["versions"]) for c in cards)},
                "shards": shards, "coverage": coverage, "sources": sources,
                "tagCoverage": {"cards": sum(bool(c["tags"]) for c in cards), "tags": len(vocabulary), "includesAncestors": True},
                "translationReview": {"upstreamAIFaces": upstream_ai_faces, "manualReviewPerformed": False,
                                      "overrideFaces": len(applied_overrides), "overrideReviewStatus": "ai-reviewed" if applied_overrides else None},
                "tagSource": sources[-1], "tagVocabulary": "tag-vocabulary.json",
                "versionCoverage": {"defaultPrintings": default_count, "englishDefaultSnapshotLoaded": default_path.exists(), "allLanguagesSnapshotLoaded": False,
                                    "note": "Current default-language paper printings plus Chinese community mapped printings; not every language printing."},
                "reports": {"coverage": "coverage-report.json", "repairAudit": "source-repair-audit.json"}}
    report = {"freezeDate": args.freeze_date, "snapshot": manifest["snapshot"], "counts": manifest["counts"], "coverage": coverage,
              "sourceParsing": statistics, "missingNames": len(name_missing), "unknownFreshnessFaces": len(freshness_unknown),
              "upstreamAIFaces": upstream_ai_faces, "cardNameTemplateReplacements": template_replacements,
              "overrideFaces": len(applied_overrides), "translationOverrides": applied_overrides,
              "translationSources": dict(translation_sources.most_common()), "missing": missing, "stale": stale, "nameMissing": name_missing,
              "assumptions": ["Card pool: released physical paper cards, including Commander banned cards; tokens, emblems, art, digital and non-deck game objects excluded.",
                              "Required faces have nonempty English rules. Genuine blank rules need no translation.",
                              "Stale is a literal normalized English-baseline mismatch; it also flags harmless reminder wording changes and requires review.",
                              "Source stages are retained without inventing a review-quality meaning. Community translations have not been manually reviewed here.",
                              "Unavailable Chinese remains empty. No English-as-Chinese or generated placeholder translations.",
                              "Printings are complete for current default-language bulk plus available community mappings, not all languages."]}
    (output / "coverage-report.json").write_text(dumps(report), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    percent = coverage["translatedFaces"] / max(coverage["requiredFaces"], 1) * 100
    summary = f"""# 中文牌库构建与覆盖报告

冻结日期：{args.freeze_date}。英文快照：{oracle_date}；中文快照：{chinese_date}。

- 实体牌：{len(cards):,} 张；牌面：{face_count:,}；真实印刷版本：{manifest['counts']['versions']:,}。
- 需要规则翻译：{coverage['requiredFaces']:,} 面；已有中文：{coverage['translatedFaces']:,} 面（{percent:.2f}%）；缺失：{coverage['missingFaces']:,} 面。
- 中文所依英文与当前 Oracle 存在差异：{coverage['staleFaces']:,} 面，界面应显示待复核。此项包含提示文字等变化。
- 中文名称缺失：{len(name_missing):,} 面；无法比较英文基线：{len(freshness_unknown):,} 面。
- 上游 AI 来源译文：{upstream_ai_faces:,} 面，各牌面的复核状态单独保留；本次未进行人工规则翻译审核。已将 {template_replacements:,} 处上游 CARDNAME 占位符替换为该牌面的真实中文名。
- 已核实纠错：{len(applied_overrides):,} 面，保留原始来源并标记 ai-reviewed（AI 语义复核，未标为人工审核）。每条修订记录在 coverage-report.json。
- 功能标签：{len(vocabulary):,} 个，覆盖 {manifest['tagCoverage']['cards']:,} 张牌，来自真实 Scryfall Oracle Tags。

| 来源文件 | 总行数 | 修复成功 | 无法解析 |
| --- | ---: | ---: | ---: |
"""
    summary += "\n".join(f"| {name} | {s['rows']:,} | {s['repaired']:,} | {s['failed']:,} |" for name, s in statistics.items())
    summary += "\n\n原始输入未更改。source-repair-audit.json 索引各审计分片，保留每条修复和失败行的文件名、行号、SHA-256 与原文。coverage-report.json 列出逐面缺译与待复核清单。\n\n缺译保持空值，保留英文对照。社区来源按原样展示，未将来源阶段值推断为人工审核等级。版本范围包含当前默认语言印刷和中文社区映射印刷，尚未载入全部语言印刷。数据源与授权见 manifest.json，中文社区数据采用 CC BY-SA 4.0。\n"
    (output / "coverage-report.md").write_text(summary, encoding="utf-8")
    print(dumps({"counts": manifest["counts"], "coverage": coverage, "tagCoverage": manifest["tagCoverage"], "shards": len(shards)}), flush=True)


if __name__ == "__main__":
    main()
