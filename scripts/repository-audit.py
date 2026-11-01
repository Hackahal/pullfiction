#!/usr/bin/env python3
"""Reject local artifacts, game payloads and known credential signatures before publication.

Reads Git and source files only. Reports paths and signature types, never matched
values. History scanning covers objects reachable from the selected revision;
current mode also checks nonignored untracked files. This is a bounded signature
check, not a guarantee that arbitrary sensitive text cannot exist.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
FORBIDDEN_SUFFIXES = {'.mpq', '.blp', '.m2', '.wmo', '.adt', '.wdt', '.dbc', '.db2',
                      '.wasm', '.bin', '.gz', '.zip', '.7z', '.ogg', '.mp3', '.wav', '.har', '.pem', '.key'}
PREFIXES = ('.agent/', '.agents/', '.codex/', '.claude/', 'target/', 'WoW/', 'extracted/', 'out/', 'web/dist/', 'benilla-config/')
PATTERNS = {
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----(?:\s|\\n)+[A-Za-z0-9+/=]{32,}'),
    'GitHub token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})'),
    'AWS access key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'Slack token': re.compile(rb'xox[baprs]-[A-Za-z0-9-]{20,}'),
}
MAGICS = (b'BLP1', b'BLP2', b'MD20', b'MD21', b'MPQ\x1a', b'WDBC', b'WDC1', b'WDC2', b'WDC3', b'WDC4', b'WDC5', b'OggS', b'\x00asm')


def path_problem(path):
    value = path.replace('\\', '/')
    parts = value.split('/')
    leaf = parts[-1]
    if leaf in ('AGENTS.md', 'CLAUDE.md') or re.fullmatch(r'PERFORMANCE-REVIEW-\d{4}-\d{2}-\d{2}\.md', leaf):
        return 'local assistant instructions or investigation notes'
    if value.startswith(PREFIXES) or 'node_modules' in parts or '__pycache__' in parts:
        return 'generated/local directory'
    if (leaf == '.env' or leaf.startswith('.env.')) and leaf not in ('.env.example', '.env.sample'):
        return 'local environment file'
    if leaf == '.probe-identity':
        return 'local account identity'
    if Path(value).suffix.lower() in FORBIDDEN_SUFFIXES:
        return 'game, binary build, archive or credential artifact'
    return None


def content_problems(data):
    result = [name for name, pattern in PATTERNS.items() if pattern.search(data)]
    if data.startswith(MAGICS):
        result.append('game or WebAssembly payload magic')
    if len(data) >= 25 * 1024 * 1024:
        result.append('blob at or above 25 MiB')
    return result


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def audit(revision='HEAD', current=True, history=True):
    findings, checked = [], 0
    if current:
        paths = set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0'))
        for raw in sorted(paths):
            if not raw:
                continue
            name = raw.decode('utf-8', errors='surrogateescape')
            path = ROOT / name
            if not path.exists() and not path.is_symlink():
                continue  # staged/unstaged deletions are absent from the candidate tree
            reason = path_problem(name)
            if reason:
                findings.append({'scope': 'worktree', 'path': name, 'reason': reason})
            if path.is_symlink():
                findings.append({'scope': 'worktree', 'path': name, 'reason': 'symlink requires explicit publication review'})
                continue
            if path.is_file():
                checked += 1
                for reason in content_problems(path.read_bytes()):
                    findings.append({'scope': 'worktree', 'path': name, 'reason': reason})
    if history:
        findings, checked = audit_history(revision, findings, checked)
    return {'revision': revision, 'checkedFilesAndBlobs': checked, 'findings': findings,
            'scope': {'current': current, 'history': history},
            'proof': 'Path, file-magic, size and known credential-signature checks only; arbitrary secrets and copyright provenance need review.'}


def audit_history(revision, findings, checked):
    objects = git('rev-list', '--objects', revision).splitlines()
    reader = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for entry in objects:
            oid, _, raw_name = entry.partition(b' ')
            name = raw_name.decode('utf-8', errors='surrogateescape')
            reader.stdin.write(oid + b'\n'); reader.stdin.flush()
            header = reader.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError('Cannot read Git object header')
            size = int(header[2]);data = reader.stdout.read(size);newline = reader.stdout.read(1)
            if len(data) != size or newline != b'\n':
                raise RuntimeError('Truncated Git object read')
            if header[1] != b'blob':
                continue
            checked += 1
            reason = path_problem(name)
            reasons = ([reason] if reason else []) + content_problems(data)
            for reason in reasons:
                findings.append({'scope': 'history', 'path': name, 'object': oid.decode(), 'reason': reason})
    finally:
        reader.stdin.close(); reader.stdout.close(); reader.wait()
    if reader.returncode:
        raise RuntimeError('Git object reader failed')
    return findings, checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', default='HEAD')
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--history-only', action='store_true')
    scope.add_argument('--tree-only', action='store_true', help='Check current source without reachable history')
    args = parser.parse_args()
    try:
        report = audit(args.revision, not args.history_only, not args.tree_only)
        print(json.dumps(report, indent=2, ensure_ascii=True))
        return bool(report['findings'])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(2, f'Repository audit failed: {error}\n')


if __name__ == '__main__':
    sys.exit(main())
