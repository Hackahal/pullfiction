#!/usr/bin/env python3
"""Exercise deployment safety with authored packs and a recording, offline CLI."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from hosted_assets import ChunkWriter, audit
import hosted_asset_deployment as deployment
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
BUILD = {'product':'fixture','version':'1','buildKey':'a'*32}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'scripts').mkdir()
        (self.root/'cloudflare').mkdir()
        (self.root/'.gitignore').write_text('.agent/\n')
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        for name in ('deploy-game-assets.sh','hosted_assets.py','hosted_asset_deployment.py'):
            shutil.copy2(ROOT/'scripts'/name,self.root/'scripts'/name)
        shutil.copy2(ROOT/'cloudflare/game-asset-headers',self.root/'cloudflare/game-asset-headers')
        cli = self.root/'tools/release/node_modules/.bin/wrangler'
        cli.parent.mkdir(parents=True)
        cli.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$WRANGLER_CAPTURE"\n')
        cli.chmod(0o755)
        self.capture = self.root/'cli-call'
        self.release = self.root/'.agent/release'
        self.retained = self.root/'.agent/work/hosted-assets/deployed'
        self.pack(self.release,b'new fixture bytes')

    def pack(self,path,payload):
        writer = ChunkWriter(path,BUILD)
        writer.add('read:fonts/fixture.ttf',payload)
        writer.finish(appearanceInputs=[])

    def run_script(self,first=None,ci=False,recover=False):
        env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
        env['WRANGLER_CAPTURE'] = str(self.capture)
        if first is not None: env['HOSTED_ASSETS_FIRST_DEPLOY'] = first
        if ci: env['CI'] = '1'
        return subprocess.run(['bash',str(self.root/'scripts/deploy-game-assets.sh'),
                               *(['--recover'] if recover else [str(self.release)])],
                              cwd=self.root,env=env,text=True,capture_output=True)

    def assert_not_uploaded(self,result):
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(self.capture.exists())
        self.assertEqual(list((self.root/'.agent/work/hosted-assets').glob('upload.*')),[])

    def test_missing_retention_fails_closed_without_staging_or_cli(self):
        result = self.run_script()
        self.assert_not_uploaded(result)
        self.assertIn('Restore the retained generation',result.stderr)
        self.assertIn('local absence does not prove',result.stderr)

    def test_bootstrap_override_cannot_bypass_missing_or_existing_retention(self):
        for value in ('','0','true','1'):
            result = self.run_script(first=value)
            self.assert_not_uploaded(result)
            self.assertIn('unsupported',result.stderr)
        self.pack(self.retained,b'old fixture bytes')
        self.assert_not_uploaded(self.run_script(first='1'))

    def test_existing_remote_only_chunks_require_restoring_complete_retention(self):
        # Authored stand-in for an existing service. The deployer must not infer
        # remote emptiness from a missing local directory or an environment flag.
        remote = self.root/'.agent/remote-service'
        self.pack(remote,b'old remote-only fixture bytes')
        before = {p.name:p.read_bytes() for p in (remote/'chunks').iterdir()}
        self.assert_not_uploaded(self.run_script())
        self.assert_not_uploaded(self.run_script(first='1'))
        self.assertEqual({p.name:p.read_bytes() for p in (remote/'chunks').iterdir()},before)
        shutil.copytree(remote,self.retained)
        result = self.run_script()
        self.assertEqual(result.returncode,0,result.stderr)
        for name,data in before.items():
            self.assertEqual((self.retained/'chunks'/name).read_bytes(),data)
        self.assertEqual(len(list((self.retained/'chunks').iterdir())),2)

    def test_valid_retention_is_audited_and_union_is_uploaded(self):
        self.pack(self.retained,b'old fixture bytes')
        old = {p.name:p.read_bytes() for p in (self.retained/'chunks').iterdir()}
        result = self.run_script()
        self.assertEqual(result.returncode,0,result.stderr)
        args = self.capture.read_text().splitlines()
        self.assertEqual(args[:3],['deploy','--config','wrangler.game-assets.jsonc'])
        self.assertEqual(args[3],'--assets')
        self.assertEqual(audit(self.retained)['revision'],audit(self.release)['revision'])
        for name,data in old.items():
            self.assertEqual((self.retained/'chunks'/name).read_bytes(),data)
        self.assertEqual(len(list((self.retained/'chunks').iterdir())),2)

    def test_invalid_retention_cannot_be_bypassed(self):
        self.retained.mkdir(parents=True)
        (self.retained/'manifest.json').write_text('{}')
        self.assert_not_uploaded(self.run_script())
        self.assert_not_uploaded(self.run_script(first='1'))

    def test_symlink_retention_and_ci_are_refused_without_cli(self):
        self.retained.parent.mkdir(parents=True)
        self.retained.symlink_to(self.release,target_is_directory=True)
        self.assert_not_uploaded(self.run_script())
        self.assert_not_uploaded(self.run_script(first='1',ci=True))



    def test_published_upload_finalization_failures_block_upload_until_recovered(self):
        for boundary in ('backup','install','clear'):
            with self.subTest(boundary=boundary):
                # Each failure runs in an independent authored fixture.
                case = DeploymentTests(); case.setUp()
                try:
                    case.pack(case.retained,b'old fixture bytes')
                    old_chunks = {p.name:p.read_bytes() for p in (case.retained/'chunks').iterdir()}
                    original_replace = deployment.os.replace
                    def replace(source,destination):
                        if ((boundary == 'backup' and Path(destination).name.startswith('previous.'))
                                or (boundary == 'install' and Path(source).name.startswith('upload.')
                                    and Path(destination).name == 'deployed')):
                            raise OSError('Injected retention rename failure')
                        return original_replace(source,destination)
                    original_clear = deployment.clear_pending
                    def clear(state):
                        if boundary == 'clear': raise OSError('Injected journal clear failure')
                        return original_clear(state)
                    env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
                    env['WRANGLER_CAPTURE'] = str(case.capture)
                    with patch.dict(os.environ,env,clear=True), patch.object(deployment.os,'replace',side_effect=replace), patch.object(deployment,'clear_pending',side_effect=clear):
                        with self.assertRaises(OSError): deployment.deploy(case.root,case.release)
                    self.assertTrue(case.capture.exists())  # Stub upload succeeded.
                    recorded = case.capture.read_bytes()
                    pending = case.retained.parent/'pending.json'
                    transaction = json.loads(pending.read_bytes())
                    complete = case.retained.parent/transaction['stage']
                    if boundary == 'clear': complete = case.retained
                    deployment.verify_snapshot(complete,transaction)
                    self.assertEqual(len(transaction['chunks']),2)
                    blocked = case.run_script(first='1')
                    self.assertNotEqual(blocked.returncode,0)
                    self.assertIn('recovery is pending',blocked.stderr)
                    self.assertEqual(case.capture.read_bytes(),recorded)
                    recovered = case.run_script(recover=True)
                    self.assertEqual(recovered.returncode,0,recovered.stderr)
                    self.assertEqual(case.capture.read_bytes(),recorded)  # Recovery never uploads.
                    self.assertFalse(pending.exists())
                    self.assertEqual(audit(case.retained)['revision'],audit(case.release)['revision'])
                    for name,data in old_chunks.items():self.assertEqual((case.retained/'chunks'/name).read_bytes(),data)
                    self.assertEqual(len(list((case.retained/'chunks').iterdir())),2)
                    self.assertEqual(case.run_script().returncode,0)
                finally: case.doCleanups()

    def test_uncertain_upload_failure_keeps_durable_recovery_and_blocks_next_upload(self):
        self.pack(self.retained,b'old fixture bytes')
        cli = self.root/'tools/release/node_modules/.bin/wrangler'
        cli.write_text(cli.read_text()+'exit 7\n')
        result = self.run_script()
        self.assertNotEqual(result.returncode,0)
        recorded = self.capture.read_bytes()
        self.assertTrue((self.retained.parent/'pending.json').exists())
        self.assertNotEqual(self.run_script().returncode,0)
        self.assertEqual(self.capture.read_bytes(),recorded)
        self.assertEqual(self.run_script(recover=True).returncode,0)
        self.assertEqual(self.capture.read_bytes(),recorded)
        self.assertEqual(len(list((self.retained/'chunks').iterdir())),2)


    def test_recovery_rejects_a_missing_old_extra_chunk_even_when_manifest_audits(self):
        self.pack(self.retained,b'old fixture bytes')
        old = next((self.retained/'chunks').iterdir())
        original = deployment.os.replace
        def replace(source,destination):
            if Path(destination).name.startswith('previous.'):
                raise OSError('Injected post-upload backup failure')
            return original(source,destination)
        env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
        env['WRANGLER_CAPTURE'] = str(self.capture)
        with patch.dict(os.environ,env,clear=True), patch.object(deployment.os,'replace',side_effect=replace):
            with self.assertRaises(OSError): deployment.deploy(self.root,self.release)
        transaction = json.loads((self.retained.parent/'pending.json').read_bytes())
        stage = self.retained.parent/transaction['stage']
        staged_old = stage/'chunks'/old.name
        data = staged_old.read_bytes();staged_old.unlink()
        self.assertEqual(audit(stage)['revision'],audit(self.release)['revision'])
        recorded = self.capture.read_bytes()
        self.assertNotEqual(self.run_script(recover=True).returncode,0)
        self.assertNotEqual(self.run_script().returncode,0)
        self.assertEqual(self.capture.read_bytes(),recorded)
        staged_old.write_bytes(data)
        self.assertEqual(self.run_script(recover=True).returncode,0)
        self.assertEqual((self.retained/'chunks'/old.name).read_bytes(),data)

    def test_concurrent_deployment_is_refused_without_staging(self):
        with deployment.locked(self.retained.parent):
            result = self.run_script(first='1')
        self.assert_not_uploaded(result)
        self.assertIn('Another asset deployment',result.stderr)


    def test_staging_failures_and_interrupts_cleanup_only_before_journal_ownership(self):
        for phase in ('copy','snapshot','sync','journal_before','journal_after'):
            for error_type in (OSError,KeyboardInterrupt):
                with self.subTest(phase=phase,error=error_type.__name__):
                    case = DeploymentTests();case.setUp()
                    try:
                        case.pack(case.retained,b'old fixture bytes')
                        failure = error_type('Injected staging failure')
                        env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
                        env['WRANGLER_CAPTURE'] = str(case.capture)
                        original = deployment.write_pending
                        def journal(state,transaction):
                            if phase == 'journal_after': original(state,transaction)
                            raise failure
                        if phase == 'copy':
                            target,attribute,effect = deployment.shutil,'copy2',failure
                        elif phase == 'snapshot':
                            target,attribute,effect = deployment,'snapshot',failure
                        elif phase == 'sync':
                            target,attribute,effect = deployment,'durable_generation',failure
                        else:
                            target,attribute,effect = deployment,'write_pending',journal
                        with patch.dict(os.environ,env,clear=True), patch.object(target,attribute,side_effect=effect):
                            with self.assertRaises(error_type) as caught: deployment.deploy(case.root,case.release)
                        self.assertIs(caught.exception,failure)
                        self.assertFalse(case.capture.exists())
                        stages = list(case.retained.parent.glob('upload.*'))
                        pending = case.retained.parent/'pending.json'
                        if phase == 'journal_after':
                            self.assertTrue(pending.exists())
                            self.assertEqual(len(stages),1)
                            transaction = json.loads(pending.read_bytes())
                            deployment.verify_snapshot(stages[0],transaction)
                            self.assertNotEqual(case.run_script().returncode,0)
                            self.assertEqual(case.run_script(recover=True).returncode,0)
                            self.assertFalse(case.capture.exists())
                            self.assertEqual(len(list((case.retained/'chunks').iterdir())),2)
                        else:
                            self.assertFalse(pending.exists())
                            self.assertEqual(stages,[])
                            self.assertEqual(audit(case.retained)['status'],'verified')
                    finally: case.doCleanups()

    def test_cleanup_failure_does_not_mask_the_original_staging_error(self):
        self.pack(self.retained,b'old fixture bytes')
        failure = OSError('Original copy failure')
        env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
        env['WRANGLER_CAPTURE'] = str(self.capture)
        with patch.dict(os.environ,env,clear=True), patch.object(deployment.shutil,'copy2',side_effect=failure), patch.object(deployment.shutil,'rmtree',side_effect=OSError('Cleanup failed')):
            with self.assertRaises(OSError) as caught: deployment.deploy(self.root,self.release)
        self.assertIs(caught.exception,failure)
        self.assertFalse(self.capture.exists())
        self.assertFalse((self.retained.parent/'pending.json').exists())

if __name__ == '__main__': unittest.main()
