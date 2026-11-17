import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import refresh_catalog_sources as refresher


class BinaryResponse:
    def __init__(self, content):
        self.content = content

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        pass

    def iter_content(self, size):
        yield self.content


def snapshot_fixture(revision, chinese):
    payloads, bulk = {}, {"data": []}
    for key in refresher.BULK_TYPES:
        name = f"https://data.scryfall.io/{key}-{revision}.jsonl.gz"
        row = {"id": key, "slug": key, "revision": revision}
        payloads[name] = gzip.compress(json.dumps(row).encode() + b"\n", mtime=0)
        bulk["data"].append({
            "id": key, "type": key, "updated_at": f"2026-11-{revision:02}T12:00:00Z",
            "jsonl_download_uri": name, "compressed_size": len(payloads[name]),
        })
    url = "https://github.com/project/data.tar.gz"
    payloads[url] = chinese
    release = {"tag_name": "data-2026-11-08", "assets": [{
        "id": 1, "updated_at": "2026-11-08T12:00:00Z", "name": "data.tar.gz",
        "browser_download_url": url, "size": len(chinese),
        "digest": "sha256:" + hashlib.sha256(chinese).hexdigest(),
    }]}
    sources = [*(refresher.scryfall_source(row) for row in bulk["data"]), refresher.chinese_source(release)]
    return (sources, bulk, release), payloads


class TestCatalogRefresh(unittest.TestCase):
    def test_noop_and_failed_refresh_preserve_validated_cache(self):
        archive_buffer = io.BytesIO()
        with tarfile.open(fileobj=archive_buffer, mode="w:gz") as archive:
            for name in refresher.ARCHIVE_MEMBERS:
                member = tarfile.TarInfo(name)
                member.size = 3
                archive.addfile(member, io.BytesIO(b"{}\n"))
        chinese = archive_buffer.getvalue()
        old, old_payloads = snapshot_fixture(1, chinese)
        new, new_payloads = snapshot_fixture(2, chinese)
        with TemporaryDirectory() as directory:
            cache = Path(directory)
            with patch.object(refresher, "discover", return_value=old), patch.object(
                refresher.requests, "get", side_effect=lambda url, **_: BinaryResponse(old_payloads[url])
            ) as download:
                check = refresher.refresh(cache, check=True, include_all_cards=False)
                self.assertTrue(check["changed"])
                self.assertFalse(list(cache.iterdir()))
                self.assertEqual(download.call_count, 0)
                first = refresher.refresh(cache, check=False, include_all_cards=False)
                self.assertEqual(len(first["contentChangedSources"]), 4)
                self.assertFalse(first["errors"])
                second = refresher.refresh(cache, check=False, include_all_cards=False)
                self.assertFalse(second["changed"])
                self.assertEqual(download.call_count, 4)

            before = {path.name: path.read_bytes() for path in cache.iterdir()}
            invalid = new[0][1].identity["url"]
            corrupt_payloads = {**new_payloads, invalid: b"x" * len(new_payloads[invalid])}
            with patch.object(refresher, "discover", return_value=new), patch.object(
                refresher.requests, "get", side_effect=lambda url, **_: BinaryResponse(corrupt_payloads[url])
            ):
                failed = refresher.refresh(cache, check=False, include_all_cards=False)
                self.assertEqual(failed["errors"][0]["source"], "default_cards")
            self.assertEqual({path.name: path.read_bytes() for path in cache.iterdir()}, before)

            with patch.object(refresher, "discover", return_value=new), patch.object(
                refresher.requests, "get", side_effect=lambda url, **_: BinaryResponse(new_payloads[url])
            ) as download:
                updated = refresher.refresh(cache, check=False, include_all_cards=False)
                self.assertEqual(updated["changedSources"], list(refresher.BULK_TYPES))
                self.assertEqual(download.call_count, 3)
                path = cache / "oracle_cards.jsonl.gz"
                path.write_bytes(b"x" * path.stat().st_size)
                self.assertEqual(
                    refresher.refresh(cache, check=True, include_all_cards=False)["changedSources"],
                    ["oracle_cards"],
                )
