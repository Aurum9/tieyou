"""Validate source recovery and the published real-data catalog contract."""
from __future__ import annotations

import gzip
import importlib.util
import json
import re
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
DATA = APP / "dist/data"
spec = importlib.util.spec_from_file_location("build_catalog", APP / "scripts/build_catalog.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SourceRepairTests(unittest.TestCase):
    def test_known_export_quote_defect_preserves_whole_rule(self):
        original = {"name": "Quoted ability", "oracle_text": 'Create a token with "{T}: Add {G}."\nDraw a card.', "translated_text": '派出具有「{T}：加{G}」的衍生物。\n抓一张牌。'}
        good = json.dumps(original, ensure_ascii=False, separators=(",", ":"))
        broken = good.replace('\\"', '\\\\"')
        with self.assertRaises(json.JSONDecodeError):
            json.loads(broken)
        repaired, changed = builder.parse_source_row(broken)
        self.assertTrue(changed)
        self.assertEqual(repaired, original)

    def test_valid_source_is_unchanged_and_bad_unrelated_data_rejected(self):
        row, repaired = builder.parse_source_row('{"name":"Forest","text":"{T}: Add {G}."}')
        self.assertFalse(repaired)
        self.assertEqual(row["name"], "Forest")
        with self.assertRaises(json.JSONDecodeError):
            builder.parse_source_row('{"name":"Unclosed}')

    def test_changed_english_and_upstream_ai_remain_visible(self):
        row = {"translated_text": "抓一张牌。", "oracle_text": "Draw a card.", "text_source": "gpt", "text_stage": 0}
        translation = builder.translation_for(row, "Draw two cards.")
        self.assertTrue(translation["stale"])
        self.assertTrue(translation["upstreamAI"])
        self.assertEqual(translation["reviewStatus"], "unreviewed")
        self.assertEqual(builder.translation_for(None, "Draw a card.")["status"], "missing")

    def test_reviewed_override_is_bound_to_both_baselines_and_keeps_provenance(self):
        translation = builder.translation_for({"translated_text": "抓两张牌。", "oracle_text": "Draw a card.", "text_source": "Example community source", "text_stage": 5}, "Draw a card.")
        entry = {"oracleId": "example", "faceName": "Example Card", "source": "AI semantic review", "version": "test-1",
                 "oracleText": "Draw a card.", "originalText": "抓两张牌。", "translatedText": "抓一张牌。", "reason": "Correct the quantity."}
        chinese, result = builder.apply_translation_override(entry, "Draw a card.", "抓两张牌。", translation)
        self.assertEqual(chinese, "抓一张牌。")
        self.assertEqual(result["source"], "Example community source")
        self.assertEqual(result["sourceStage"], 5)
        self.assertEqual(result["reviewStatus"], "ai-reviewed")
        self.assertEqual(result["override"]["source"], "AI semantic review")
        with self.assertRaisesRegex(ValueError, "English baseline changed"):
            builder.apply_translation_override(entry, "Draw two cards.", "抓两张牌。", translation)
        with self.assertRaisesRegex(ValueError, "Chinese baseline changed"):
            builder.apply_translation_override(entry, "Draw a card.", "抓三张牌。", translation)


class PublishedCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
        cls.cards = []
        for shard in cls.manifest["shards"]:
            cls.cards.extend(json.loads((DATA / shard["url"]).read_text(encoding="utf-8")))
        cls.by_name = {c["name"]: c for c in cls.cards}

    def test_counts_shards_and_real_identifiers(self):
        self.assertEqual(self.manifest["counts"]["cards"], len(self.cards))
        self.assertGreater(len(self.cards), 30000)
        self.assertEqual(len({c["id"] for c in self.cards}), len(self.cards))
        self.assertEqual(self.manifest["counts"]["faces"], sum(len(c["faces"]) for c in self.cards))
        self.assertEqual(self.manifest["counts"]["versions"], sum(len(c["versions"]) for c in self.cards))
        ids = {}
        for shard in self.manifest["shards"]:
            self.assertLess((DATA / shard["url"]).stat().st_size, 15_000_000)
            self.assertEqual(len(json.loads((DATA / shard["url"]).read_text(encoding="utf-8"))), shard["count"])
        for card in self.cards:
            self.assertRegex(card["id"], r"^[0-9a-f]{8}-[0-9a-f-]{27}$")
            self.assertTrue(card["faces"])
            self.assertTrue(card["versions"])
            default_version = next(v for v in card["versions"] if v["id"] == card["defaultVersionId"])
            self.assertEqual(default_version["set"], card["set"])
            self.assertEqual(default_version["collectorNumber"], card["collectorNumber"])
            self.assertEqual(default_version["image"], card["image"])
            for version in card["versions"]:
                self.assertRegex(version["id"], r"^[0-9a-f]{8}-[0-9a-f-]{27}$")
                self.assertEqual(ids.setdefault(version["id"], card["id"]), card["id"], "Printing assigned to two Oracle cards")
                self.assertTrue(version["set"])
                self.assertTrue(version["collectorNumber"])

    def test_coverage_matches_faces_and_no_hidden_placeholder_translation(self):
        faces = [f for c in self.cards for f in c["faces"] if f["oracleText"].strip()]
        coverage = self.manifest["coverage"]
        self.assertEqual(len(faces), coverage["requiredFaces"])
        self.assertEqual(sum(bool(f["zhText"].strip()) for f in faces), coverage["translatedFaces"])
        self.assertEqual(sum(not f["zhText"].strip() for f in faces), coverage["missingFaces"])
        self.assertEqual(sum(f["translation"]["stale"] for f in faces if f["zhText"]), coverage["staleFaces"])
        self.assertEqual(coverage["requiredFaces"], coverage["translatedFaces"] + coverage["missingFaces"])
        self.assertEqual(sum(bool(f["translation"].get("upstreamAI")) for f in faces), self.manifest["translationReview"]["upstreamAIFaces"])
        for face in faces:
            if face["zhText"]:
                self.assertRegex(face["zhText"], r"[\u3400-\u9fff]")
                self.assertNotIn("CARDNAME", face["zhText"])
                self.assertNotEqual(face["zhText"], face["oracleText"])
                self.assertTrue(face["translation"]["source"])

    def test_known_cards_multiface_versions_and_function_tags(self):
        sol = self.by_name["Sol Ring"]
        self.assertEqual(sol["zhName"], "阳光戒")
        self.assertIn("ramp", sol["tags"])
        self.assertGreater(len(sol["versions"]), 10)
        self.assertEqual(self.by_name["Black Lotus"]["legalities"]["commander"], "banned")
        self.assertIn("draw", self.by_name["Rhystic Study"]["tags"])
        self.assertIn("counterspell", self.by_name["Counterspell"]["tags"])
        self.assertIn("sweeper", self.by_name["Wrath of God"]["tags"])
        for name in ["Delver of Secrets // Insectile Aberration", "Bala Ged Recovery // Bala Ged Sanctuary", "Fire // Ice"]:
            card = self.by_name[name]
            self.assertEqual(len(card["faces"]), 2)
            self.assertTrue(all(f["zhName"] for f in card["faces"]))
            self.assertTrue(all(f["zhText"] for f in card["faces"] if f["oracleText"]))

    def test_repair_audit_accounts_for_every_reported_recovery(self):
        report = json.loads((DATA / "coverage-report.json").read_text(encoding="utf-8"))
        counts = {}
        audit_index = json.loads((DATA / "source-repair-audit.json").read_text(encoding="utf-8"))
        for chunk in audit_index["chunks"]:
            self.assertLess((DATA / chunk["url"]).stat().st_size, 15_000_000)
            with gzip.open(DATA / chunk["url"], "rt", encoding="utf-8") as handle:
                for line in handle:
                    item = json.loads(line)
                    key = (item["file"], item["status"])
                    counts[key] = counts.get(key, 0) + 1
                    self.assertTrue(item["raw"])
                    self.assertRegex(item["sha256"], r"^[a-f0-9]{64}$")
        for name, parsing in report["sourceParsing"].items():
            self.assertEqual(counts.get((name, "repaired"), 0), parsing["repaired"])
            self.assertEqual(counts.get((name, "failed"), 0), parsing["failed"])

    def test_published_overrides_match_the_reviewed_file_and_keep_original_sources(self):
        path = APP / "scripts/translation-overrides.json"
        entries = builder.load_translation_overrides(path)
        report = json.loads((DATA / "coverage-report.json").read_text(encoding="utf-8"))
        self.assertEqual(self.manifest["translationReview"].get("overrideFaces", 0), len(entries))
        self.assertEqual(report.get("overrideFaces", 0), len(entries))
        faces = {(c["id"], f["name"]): f for c in self.cards for f in c["faces"]}
        for key, entry in entries.items():
            face = faces[key]
            self.assertEqual(face["zhText"], entry["translatedText"])
            self.assertEqual(face["oracleText"], entry["oracleText"])
            translation = face["translation"]
            self.assertEqual(translation["reviewStatus"], "ai-reviewed")
            self.assertEqual(translation["source"], translation["override"]["originalSource"])
            self.assertEqual(translation["sourceStage"], translation["override"]["originalSourceStage"])
            self.assertEqual(translation["override"]["originalText"], entry["originalText"])
            self.assertEqual(translation["override"]["version"], entry["version"])
            self.assertFalse(translation["stale"])

    @unittest.skipUnless((APP / "scripts/.cache/default_cards.jsonl.gz").exists(), "Source snapshot available after refresh")
    def test_multiface_version_images_come_from_the_selected_real_printing(self):
        wanted = {name: self.by_name[name] for name in ("Delver of Secrets // Insectile Aberration", "Fire // Ice")}
        checked = set()
        for raw in builder.read_snapshot(APP / "scripts/.cache/default_cards.jsonl.gz"):
            name = raw["name"]
            if name not in wanted or name in checked:
                continue
            card = wanted[name]
            if raw["id"] == card["defaultVersionId"]:
                continue
            version = next((v for v in card["versions"] if v["id"] == raw["id"]), None)
            if version is None:
                continue
            whole = raw.get("image_uris", {}).get("normal", "")
            expected = [face.get("image_uris", {}).get("normal", whole) for face in raw["card_faces"]]
            self.assertEqual(version["faceImages"], expected)
            self.assertEqual(len(version["faceImages"]), len(card["faces"]))
            self.assertTrue(all(version["faceImages"]))
            if card["layout"] == "split":
                self.assertEqual(version["faceImages"], [whole, whole])
            else:
                self.assertNotEqual(version["faceImages"][0], version["faceImages"][1])
            checked.add(name)
            if len(checked) == len(wanted):
                break
        self.assertEqual(checked, set(wanted))
        mapping_only = {"scryfall_id": "00000000-0000-0000-0000-000000000000", "set_code": "EXAMPLE", "collector_number": "1"}
        self.assertNotIn("faceImages", builder.version_from(mapping_only))


if __name__ == "__main__":
    unittest.main()
