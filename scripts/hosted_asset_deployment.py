"""Local deployment transaction; published generations always have durable recovery."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

from hosted_assets import audit, digest, json_bytes, sync_file, sync_directory

ROOT = Path(__file__).resolve().parent.parent


def durable_generation(path):
    for item in path.rglob('*'):
        if item.is_file():
            with item.open('rb') as stream:
                sync_file(stream.fileno())
    sync_directory(path/'chunks')
    sync_directory(path)
    sync_directory(path.parent)


@contextmanager
def locked(state):
    state.mkdir(parents=True, exist_ok=True)
    with (state/'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another asset deployment or recovery is running') from None
        yield lock


def snapshot(path):
    report = audit(path)
    return {'revision':report['revision'],
            'chunks':sorted(p.name for p in (path/'chunks').iterdir()),
            'headers':digest((path/'_headers').read_bytes())}


def verify_snapshot(path, transaction):
    if path.is_symlink():
        raise ValueError('Recovery generation must not be a symlink')
    actual = snapshot(path)
    if any(actual[key] != transaction[key] for key in ('revision','chunks','headers')):
        raise ValueError('Recovery generation differs from its durable transaction')


def write_pending(state, transaction):
    with tempfile.NamedTemporaryFile(dir=state, prefix='pending.', delete=False) as stream:
        stream.write(json_bytes(transaction))
        stream.flush()
        sync_file(stream.fileno())
        temporary = Path(stream.name)
    os.replace(temporary, state/'pending.json')
    sync_directory(state)


def clear_pending(state):
    (state/'pending.json').unlink()
    sync_directory(state)


def finalize(state):
    """Recover safely at either directory rename boundary, without uploading."""
    pending = state/'pending.json'
    if pending.is_symlink():
        raise ValueError('Invalid pending transaction')
    transaction = json.loads(pending.read_bytes())
    if (transaction.get('schema') != 1
            or not re.fullmatch(r'upload\.[a-zA-Z0-9_]+', transaction.get('stage',''))
            or not re.fullmatch(r'previous\.[0-9a-f]{32}', transaction.get('backup',''))):
        raise ValueError('Invalid pending transaction paths')
    stage, backup, retained = state/transaction['stage'], state/transaction['backup'], state/'deployed'
    if retained.is_symlink() or backup.is_symlink():
        raise ValueError('Invalid retention directory')
    if not stage.exists():
        # A crash after installing the complete generation but before clearing
        # the journal is recoverable without moving or discarding any bytes.
        verify_snapshot(retained, transaction)
    else:
        verify_snapshot(stage, transaction)
        if retained.exists():
            if backup.exists():
                raise ValueError('Conflicting retention directories; preserve them for recovery')
            os.replace(retained, backup)
            sync_directory(state)
        os.replace(stage, retained)
        sync_directory(state)
        verify_snapshot(retained, transaction)
    clear_pending(state)
    return retained


def deploy(root, release=None, *, recover=False):
    if os.environ.get('GITHUB_ACTIONS') or os.environ.get('CI'):
        raise ValueError('Game assets must be prepared and deployed locally, outside CI.')
    root = root.resolve()
    state = root/'.agent/work/hosted-assets'
    with locked(state) as lock:
        pending = state/'pending.json'
        if pending.exists() or pending.is_symlink():
            if not recover:
                raise ValueError('Asset retention recovery is pending. Run bash scripts/deploy-game-assets.sh --recover before another deployment.')
            return finalize(state)
        if recover:
            raise ValueError('No pending asset retention transaction to recover')
        if release is None:
            raise ValueError('A prepared asset directory is required')
        release = release.resolve()
        if not release.is_relative_to(root/'.agent'):
            raise ValueError('Game assets must remain beneath the ignored .agent directory.')
        if subprocess.run(['git','check-ignore','-q',str(release)],cwd=root).returncode:
            raise ValueError('Game asset output is not ignored by Git.')
        if subprocess.check_output(['git','ls-files','--',str(release)],cwd=root):
            raise ValueError('Refusing to deploy game assets tracked by Git.')
        audit(release)
        retained = state/'deployed'
        if 'HOSTED_ASSETS_FIRST_DEPLOY' in os.environ:
            raise ValueError('HOSTED_ASSETS_FIRST_DEPLOY is unsupported. Restore the complete retained generation before deploying.')
        if retained.is_symlink() or (retained.exists() and not retained.is_dir()):
            raise ValueError('Invalid retention directory. Restore the retained generation before deploying.')
        if not retained.exists():
            raise ValueError('Missing retained generation. Restore the retained generation before deploying; local absence does not prove the remote service is empty.')
        audit(retained)
        stage = Path(tempfile.mkdtemp(prefix='upload.',dir=state))
        try:
            (stage/'chunks').mkdir()
            for source in (retained, release):
                for chunk in (source/'chunks').iterdir():
                    shutil.copy2(chunk,stage/'chunks'/chunk.name)
            shutil.copy2(release/'manifest.json',stage/'manifest.json')
            shutil.copy2(root/'cloudflare/game-asset-headers',stage/'_headers')
            transaction = {'schema':1, 'stage':stage.name, 'backup':'previous.'+uuid.uuid4().hex,
                           **snapshot(stage)}
            # Complete and sync the entire union, then persist its exact inventory
            # before invoking Wrangler. Any uncertain upload/finalization failure
            # leaves a journal that blocks future uploads until local recovery.
            durable_generation(stage)
            write_pending(state, transaction)
        except BaseException:
            # The journal, even if its final fsync failed, owns recovery bytes.
            # Before that boundary, discard only this invocation's temporary
            # stage. Cleanup must never replace the original failure/interrupt.
            try:
                if not pending.exists() and not pending.is_symlink():
                    shutil.rmtree(stage)
            except BaseException:
                pass
            raise
        env = {**os.environ,'WRANGLER_SEND_METRICS':'false'}
        subprocess.run([str(root/'tools/release/node_modules/.bin/wrangler'),'deploy',
                        '--config','wrangler.game-assets.jsonc','--assets',str(stage)],
                       cwd=root,env=env,check=True,pass_fds=(lock.fileno(),))
        return finalize(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', nargs='?', type=Path)
    parser.add_argument('--recover',action='store_true',help='Finish a pending local retention transaction; never uploads')
    args = parser.parse_args()
    if args.recover and args.release is not None:
        parser.error('--recover does not accept a release directory')
    try:
        result = deploy(ROOT,args.release,recover=args.recover)
    except (ValueError,OSError,subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
    print('Asset generation retained in '+str(result))


if __name__ == '__main__': main()
