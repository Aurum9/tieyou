"""Fetch public, reproducible card snapshots. No credentials or old project writes.

Run from any directory: python app/scripts/refresh_catalog_sources.py
The build script can fall back to the read-only legacy snapshot if unavailable.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import time
from pathlib import Path

import requests

CACHE = Path(__file__).resolve().parent / ".cache"
HEADERS = {"User-Agent": "CommanderDesk/0.1 (public local card catalog)", "Accept": "application/json"}


def fetch_json(url: str) -> dict:
    response = requests.get(url, headers=HEADERS, timeout=(10, 25))
    response.raise_for_status()
    return response.json()


def download(job: tuple[str, str, int, str | None]) -> dict:
    name, url, expected_size, expected_hash = job
    path = CACHE / name
    bound_path = CACHE / (name + ".metadata.json")
    bound_url = None
    if bound_path.exists():
        bound_url = json.loads(bound_path.read_text(encoding="utf-8"))["download"]["url"]
    if path.exists() and path.stat().st_size == expected_size and (bound_url == url or expected_hash):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if not expected_hash or digest == expected_hash:
            return {"name": name, "url": url, "bytes": path.stat().st_size, "sha256": digest, "cached": True}
    part = path.with_suffix(path.suffix + ".part")
    started = time.monotonic()
    hasher = hashlib.sha256()
    count = 0
    with requests.get(url, headers=HEADERS, stream=True, timeout=(10, 35)) as response:
        response.raise_for_status()
        length = int(response.headers.get("Content-Length", "0"))
        if length > 400_000_000:
            raise RuntimeError(f"refusing oversized snapshot {name}: {length}")
        with part.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if time.monotonic() - started > 240:
                    raise TimeoutError(f"download exceeded four minutes: {name}")
                handle.write(chunk)
                hasher.update(chunk)
                count += len(chunk)
    digest = hasher.hexdigest()
    if expected_hash and digest != expected_hash:
        raise ValueError(f"SHA-256 mismatch for {name}")
    if expected_size and count != expected_size:
        raise ValueError(f"size mismatch for {name}: {count} != {expected_size}")
    part.replace(path)
    return {"name": name, "url": url, "bytes": count, "sha256": digest, "cached": False}


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    metadata = {"downloads": [], "errors": []}
    jobs = []
    job_metadata = {}
    try:
        bulk = fetch_json("https://api.scryfall.com/bulk-data")
        (CACHE / "scryfall-bulk.metadata.json").write_text(json.dumps(bulk, indent=2), encoding="utf-8")
        for item in bulk["data"]:
            if item["type"] in {"oracle_cards", "default_cards", "oracle_tags"}:
                uri = item.get("jsonl_download_uri") or item.get("download_uri")
                extension = ".jsonl.gz" if item.get("jsonl_download_uri") else ".json"
                size = item.get("compressed_size") or item.get("size", 0)
                if size <= 400_000_000:
                    name = item["type"] + extension
                    jobs.append((name, uri, size, None))
                    job_metadata[name] = item
    except Exception as error:
        metadata["errors"].append({"source": "scryfall", "error": str(error)})
    try:
        release = fetch_json("https://api.github.com/repos/HeliumOctahelide/magic-cards-zhs/releases/latest")
        (CACHE / "chinese-release.metadata.json").write_text(json.dumps(release, ensure_ascii=False, indent=2), encoding="utf-8")
        asset = next(asset for asset in release["assets"] if asset["name"].endswith(".tar.gz"))
        digest = asset.get("digest", "").removeprefix("sha256:") or None
        jobs.append(("chinese.tar.gz", asset["browser_download_url"], asset["size"], digest))
        job_metadata["chinese.tar.gz"] = release
    except Exception as error:
        metadata["errors"].append({"source": "chinese", "error": str(error)})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(download, job): job[0] for job in jobs}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
                metadata["downloads"].append(result)
                # Bind metadata only after the matching download is complete.
                # A failed future refresh must not relabel an older cache as new.
                (CACHE / (result["name"] + ".metadata.json")).write_text(
                    json.dumps({"download": result, "source": job_metadata[result["name"]]}, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps(result), flush=True)
            except Exception as error:
                result = {"source": futures[future], "error": str(error)}
                metadata["errors"].append(result)
                print(json.dumps(result), flush=True)
    (CACHE / "download-report.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
