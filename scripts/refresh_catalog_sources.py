"""Refresh the reproducible Scryfall and Chinese card data cache."""
from __future__ import annotations

import argparse
import concurrent.futures
from dataclasses import dataclass
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
from tempfile import TemporaryDirectory
import time
from urllib.parse import urlsplit

import requests

CACHE = Path(__file__).resolve().parent / ".cache"
BULK_URL = "https://api.scryfall.com/bulk-data"
RELEASE_URL = "https://api.github.com/repos/HeliumOctahelide/magic-cards-zhs/releases/latest"
BULK_TYPES = ("oracle_cards", "default_cards", "oracle_tags")
ARCHIVE_MEMBERS = {"zhs_oracle.json", "scryfall_card.json", "zhs_card.json"}
HEADERS = {"User-Agent": "CommanderDesk/0.1 (public local card catalog)", "Accept": "application/json"}
CHUNK = 1024 * 1024


@dataclass(frozen=True)
class Source:
    key: str
    name: str
    identity: dict
    metadata: dict


def retry(operation):
    for attempt in range(3):
        try:
            return operation()
        except (requests.Timeout, requests.ConnectionError, requests.exceptions.ChunkedEncodingError, TimeoutError):
            if attempt == 2:
                raise
        except requests.HTTPError as error:
            if attempt == 2 or error.response.status_code not in {429, 500, 502, 503, 504}:
                raise
        time.sleep(2**attempt)


def fetch_json(url: str) -> dict:
    def fetch():
        with requests.get(url, headers=HEADERS, timeout=(10, 25)) as response:
            response.raise_for_status()
            return response.json()
    return retry(fetch)


def validate_url(url: str, host: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != host or not parsed.path:
        raise ValueError(f"unexpected download URL for {host}")
    return url


def validate_size(size: int, limit: int) -> int:
    if type(size) is not int or not 0 < size <= limit:
        raise ValueError(f"invalid compressed download size: {size}")
    return size


def scryfall_source(item: dict) -> Source:
    key = item["type"]
    updated_at = item["updated_at"]
    datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    identity = {
        "id": item["id"],
        "updatedAt": updated_at,
        "url": validate_url(item["jsonl_download_uri"], "data.scryfall.io"),
        "bytes": validate_size(item["compressed_size"], 800_000_000 if key == "all_cards" else 400_000_000),
    }
    if not isinstance(identity["id"], str) or not identity["id"]:
        raise ValueError(f"missing bulk data ID for {key}")
    return Source(key, key + ".jsonl.gz", identity, item)


def chinese_source(release: dict) -> Source:
    tag = release["tag_name"]
    if not isinstance(tag, str) or not tag.startswith("data-"):
        raise ValueError("unexpected Chinese data release tag")
    archives = [asset for asset in release["assets"] if asset["name"].endswith(".tar.gz")]
    matching = [asset for asset in archives if asset["name"] == f"magic-cards-zhs-{tag}.tar.gz"]
    archives = matching or archives
    if len(archives) != 1:
        raise ValueError("Chinese data release must contain a unique snapshot archive")
    asset = archives[0]
    updated_at = asset["updated_at"]
    datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    identity = {
        "id": asset["id"], "release": tag, "updatedAt": updated_at,
        "url": validate_url(asset["browser_download_url"], "github.com"),
        "bytes": validate_size(asset["size"], 400_000_000),
    }
    if type(identity["id"]) is not int or identity["id"] <= 0:
        raise ValueError("missing Chinese data asset ID")
    if asset.get("digest"):
        digest = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", asset["digest"])
        if not digest:
            raise ValueError("invalid Chinese release asset digest")
        identity["sha256"] = digest[1].lower()
    return Source("chinese", "chinese.tar.gz", identity, release)


def discover(include_all_cards: bool, bulk_url: str, chinese_release_file: Path | None = None):
    parsed = urlsplit(bulk_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Scryfall bulk metadata URL must use HTTPS")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        bulk_response = pool.submit(fetch_json, bulk_url)
        release_response = pool.submit(fetch_json, RELEASE_URL) if chinese_release_file is None else None
        bulk = bulk_response.result()
        release = release_response.result() if release_response else json.loads(chinese_release_file.read_text(encoding="utf-8-sig"))
    by_type = {row["type"]: row for row in bulk["data"]}
    required = (*BULK_TYPES, "all_cards") if include_all_cards else BULK_TYPES
    missing = [key for key in required if key not in by_type]
    if missing:
        raise ValueError(f"Scryfall bulk metadata omitted: {', '.join(missing)}")
    return [*(scryfall_source(by_type[key]) for key in required), chinese_source(release)], bulk, release


def cached_source(cache: Path, source: Source) -> tuple[dict | None, bool]:
    path = cache / source.name
    try:
        bound = json.loads((cache / (source.name + ".metadata.json")).read_text(encoding="utf-8"))
        previous = chinese_source(bound["source"]) if source.key == "chinese" else scryfall_source(bound["source"])
        data = bound["download"]
        if (previous.key != source.key or data["name"] != source.name or data["url"] != previous.identity["url"]
                or data["bytes"] != previous.identity["bytes"] or path.stat().st_size != data["bytes"]):
            return None, False
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(CHUNK), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        if digest != data["sha256"] or (previous.identity.get("sha256") or digest) != digest:
            return None, False
        return data, previous.identity == source.identity
    except (OSError, KeyError, TypeError, ValueError, AttributeError):
        return None, False


def validate_download(path: Path, source: Source):
    with gzip.open(path, "rb") as content:
        if source.key == "chinese":
            members = set()
            with tarfile.open(fileobj=content, mode="r|") as archive:
                for member in archive:
                    name = member.name.rsplit("/", 1)[-1]
                    if name not in ARCHIVE_MEMBERS:
                        continue
                    if name in members or not member.isfile() or member.size <= 0:
                        raise ValueError(f"invalid Chinese archive member: {name}")
                    members.add(name)
            if members != ARCHIVE_MEMBERS:
                raise ValueError("Chinese snapshot is missing required data files")
        else:
            row = json.loads(content.readline(CHUNK))
            expected_key = "slug" if source.key == "oracle_tags" else "id"
            if not isinstance(row, dict) or not row.get(expected_key):
                raise ValueError(f"invalid first JSONL record: {source.name}")
        # Read to EOF to verify the gzip stream and its checksum.
        while content.read(CHUNK):
            pass


def download(source: Source, staging: Path) -> dict:
    url = source.identity["url"]
    size = source.identity["bytes"]
    expected_hash = source.identity.get("sha256")
    part = staging / source.name

    def stream():
        started = time.monotonic()
        hasher = hashlib.sha256()
        count = 0
        headers = {**HEADERS, "Accept": "application/octet-stream", "Accept-Encoding": "identity"}
        with requests.get(url, headers=headers, stream=True, timeout=(10, 35)) as response:
            response.raise_for_status()
            with part.open("wb") as handle:
                for chunk in response.iter_content(CHUNK):
                    if time.monotonic() - started > 240:
                        raise TimeoutError(f"download exceeded four minutes: {source.name}")
                    count += len(chunk)
                    if count > size:
                        raise ValueError(f"download exceeds expected size: {source.name}")
                    handle.write(chunk)
                    hasher.update(chunk)
        digest = hasher.hexdigest()
        if count != size:
            raise ValueError(f"size mismatch for {source.name}: expected {size}, received {count}")
        if expected_hash and digest != expected_hash:
            raise ValueError(f"SHA-256 mismatch for {source.name}")
        return {"name": source.name, "url": url, "bytes": count, "sha256": digest, "cached": False}

    result = retry(stream)
    validate_download(part, source)
    return result


def write_json(path: Path, data: dict):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def refresh(cache: Path, *, check: bool, include_all_cards: bool, bulk_url: str = BULK_URL,
            chinese_release_file: Path | None = None) -> dict:
    if chinese_release_file is None:
        sources, bulk, release = discover(include_all_cards, bulk_url)
    else:
        sources, bulk, release = discover(include_all_cards, bulk_url, chinese_release_file)
    previous = {source.key: cached_source(cache, source) for source in sources}
    changed = [source for source in sources if not previous[source.key][1]]
    report = {
        "changed": bool(changed),
        "changedSources": [source.key for source in changed],
        "sources": {source.key: source.identity for source in sources},
        "downloads": [],
        "errors": [],
    }
    if check:
        return report

    cache.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".refresh-", dir=cache) as directory:
        staging = Path(directory)
        downloaded = {}
        if changed:
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                running = {pool.submit(download, source, staging): source for source in changed}
                for job in concurrent.futures.as_completed(running):
                    source = running[job]
                    try:
                        downloaded[source.key] = job.result()
                    except Exception as error:
                        report["errors"].append({"source": source.key, "error": str(error)})
            if report["errors"]:
                return report
        report["contentChangedSources"] = [
            source.key for source in changed
            if downloaded[source.key]["sha256"] != (previous[source.key][0] or {}).get("sha256")
        ]
        for source in sources:
            result = downloaded.get(source.key) or {**previous[source.key][0], "cached": True}
            report["downloads"].append(result)
        if changed:
            for source in changed:
                record = {"download": downloaded[source.key], "source": source.metadata}
                write_json(staging / (source.name + ".metadata.json"), record)
            write_json(staging / "scryfall-bulk.metadata.json", bulk)
            write_json(staging / "chinese-release.metadata.json", release)
            for source in changed:
                (staging / source.name).replace(cache / source.name)
                metadata_name = source.name + ".metadata.json"
                (staging / metadata_name).replace(cache / metadata_name)
            for name in ["scryfall-bulk.metadata.json", "chinese-release.metadata.json"]:
                (staging / name).replace(cache / name)
        write_json(staging / "download-report.json", report)
        (staging / "download-report.json").replace(cache / "download-report.json")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--check", action="store_true", help="Compare upstream metadata without downloading")
    parser.add_argument("--include-all-cards", action="store_true", help="Also refresh the full multilingual Scryfall bulk")
    parser.add_argument("--chinese-release-file", type=Path, help="Use metadata fetched from the Chinese release API")
    parser.add_argument("--scryfall-bulk-url", default=os.environ.get("SCRYFALL_BULK_URL", BULK_URL),
                        help="Use a trusted HTTPS endpoint for Scryfall bulk metadata")
    args = parser.parse_args()
    try:
        report = refresh(args.cache, check=args.check, include_all_cards=args.include_all_cards,
                         bulk_url=args.scryfall_bulk_url, chinese_release_file=args.chinese_release_file)
    except Exception as error:
        report = {"changed": False, "changedSources": [], "sources": {}, "downloads": [],
                  "errors": [{"source": "refresh", "error": str(error)}]}
    print(json.dumps(report, ensure_ascii=True), flush=True)
    return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
