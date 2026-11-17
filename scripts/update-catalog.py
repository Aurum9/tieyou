"""Refresh, build, and activate a catalog on the standalone server."""
import argparse
from datetime import date, datetime, timedelta
import fcntl
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo


SCRIPTS = Path(__file__).resolve().parent
BUNDLED = SCRIPTS.parent / 'web' / 'data'
VERSION = re.compile(r'catalog-[0-9a-f]{24}')
ZONE = ZoneInfo('Asia/Shanghai')
SOURCE_FILES = {
    'oracle_cards.jsonl.gz', 'default_cards.jsonl.gz', 'oracle_tags.jsonl.gz', 'chinese.tar.gz',
}
ARCHIVE_FILES = SOURCE_FILES | {name + '.metadata.json' for name in SOURCE_FILES} | {
    'download-report.json', 'scryfall-bulk.metadata.json', 'chinese-release.metadata.json',
}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def active_version(database):
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10) as conn:
        version = conn.execute('SELECT active_version FROM catalog_state WHERE id=1').fetchone()
    if not version or not VERSION.fullmatch(version[0]):
        raise RuntimeError('没有可用的现行卡库版本')
    return version[0]


def source_fingerprint(report):
    files = {item['name']: item['sha256'] for item in report['downloads']}
    if report['errors'] or files.keys() != SOURCE_FILES:
        raise ValueError('卡库来源文件清单不完整')
    return files


def older_source(revisions, previous):
    for key, revision in revisions.items():
        before = datetime.fromisoformat(previous[key]['updatedAt'].replace('Z', '+00:00'))
        after = datetime.fromisoformat(revision['updatedAt'].replace('Z', '+00:00'))
        if after < before:
            return key
    return None


def run(*args, capture=False):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, encoding='utf-8',
                          stdout=subprocess.PIPE if capture else None).stdout


def extract_snapshot(archive_path, directory):
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        if len(members) != len(ARCHIVE_FILES) or {item.name for item in members} != ARCHIVE_FILES:
            raise ValueError('上传的卡库来源包文件清单不正确')
        if any(not item.isfile() or item.size > 400_000_000 for item in members):
            raise ValueError('上传的卡库来源包包含无效文件')
        for member in members:
            with archive.extractfile(member) as source, (directory / member.name).open('xb') as target:
                shutil.copyfileobj(source, target)


def publish(args, cache):
    database = args.state / 'catalog.sqlite'
    releases = args.state / 'catalog-releases'
    releases.mkdir(exist_ok=True)
    previous = releases / active_version(database)
    if not previous.is_dir():
        previous = BUNDLED
    report = read_json(cache / 'download-report.json')
    fingerprint = source_fingerprint(report)
    previous_report = previous / 'source-fingerprint.json'
    if previous_report.exists() and read_json(previous_report) == fingerprint:
        print('卡库来源未变化，沿用现行版本', flush=True)
        return
    if previous_report.exists():
        older = older_source(report['sources'], read_json(previous / 'source-revisions.json'))
        if older:
            raise ValueError(f'{older} 来源比现行卡库更旧')

    with TemporaryDirectory(prefix='.build-', dir=releases) as temporary:
        build = Path(temporary)
        shutil.copyfile(BUNDLED / 'DATA-LICENSE.md', build / 'DATA-LICENSE.md')
        run(args.python, '-u', SCRIPTS / 'build_catalog.py', '--cache', cache, '--out', build,
            '--freeze-date', datetime.now(ZONE).date().isoformat(), '--no-legacy', '--previous-catalog', previous)
        run(args.python, '-u', SCRIPTS / 'build_playtest_tokens.py', '--cache', cache, '--out', build, '--no-legacy')
        write_json(build / 'source-fingerprint.json', fingerprint)
        write_json(build / 'source-revisions.json', report['sources'])
        version = run(args.node, '--input-type=module', '-e',
                      'const {readCatalogManifest}=await import(process.argv[1]); '
                      'console.log((await readCatalogManifest(process.argv[2])).version)',
                      (SCRIPTS / 'catalog-seed.mjs').as_uri(), build, capture=True).strip()
        if not VERSION.fullmatch(version):
            raise RuntimeError('构建产生了无效版本')
        target = releases / version
        if not target.exists():
            build.rename(target)
        # Reuse immutable files if a previous run staged the same manifest.
        result = json.loads(run(args.node, SCRIPTS / 'publish-local-catalog.mjs', target, database, capture=True))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        keep = {result['version'], result['previousVersion']}
        for directory in releases.iterdir():
            if VERSION.fullmatch(directory.name) and directory.name not in keep and directory.is_dir():
                shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--python', default='/usr/bin/python3')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--scheduled', action='store_true')
    mode.add_argument('--source-archive', type=Path)
    mode.add_argument('--status', action='store_true')
    args = parser.parse_args()
    args.state = args.state.resolve(strict=True)
    if args.status:
        version = active_version(args.state / 'catalog.sqlite')
        path = args.state / 'catalog-releases' / version / 'source-revisions.json'
        print(json.dumps(read_json(path) if path.exists() else {}))
        return

    with (args.state / 'catalog-update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        today = datetime.now(ZONE).date()
        stamp = args.state / 'catalog-last-attempt.json'
        if args.scheduled and stamp.exists():
            if today < date.fromisoformat(read_json(stamp)['date']) + timedelta(days=2):
                return
        if args.source_archive:
            with TemporaryDirectory(prefix='.catalog-input-', dir=args.state) as directory:
                cache = Path(directory)
                extract_snapshot(args.source_archive, cache)
                publish(args, cache)
        else:
            write_json(stamp, {'date': today.isoformat()})
            cache = args.state / 'catalog-source-cache'
            run(args.python, '-u', SCRIPTS / 'refresh_catalog_sources.py', '--cache', cache)
            publish(args, cache)


if __name__ == '__main__':
    main()
