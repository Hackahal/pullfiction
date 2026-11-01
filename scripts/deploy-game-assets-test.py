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
        for name in ('deploy-game-assets.sh','hosted_assets.py'):
            shutil.copy2(ROOT/'scripts'/name,self.root/'scripts'/name)
        # Same real pack auditor, without loading unrelated native client tools.
        (self.root/'scripts/prepare-hosted-assets.py').write_text(
            'import sys\nfrom hosted_assets import audit\nprint(audit(sys.argv[2]))\n')
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

    def run_script(self,first=None,ci=False):
        env = {k:v for k,v in os.environ.items() if k not in ('CI','GITHUB_ACTIONS','HOSTED_ASSETS_FIRST_DEPLOY')}
        env['WRANGLER_CAPTURE'] = str(self.capture)
        if first is not None: env['HOSTED_ASSETS_FIRST_DEPLOY'] = first
        if ci: env['CI'] = '1'
        return subprocess.run(['bash',str(self.root/'scripts/deploy-game-assets.sh'),str(self.release)],
                              cwd=self.root,env=env,text=True,capture_output=True)

    def assert_not_uploaded(self,result):
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(self.capture.exists())
        self.assertEqual(list((self.root/'.agent/work/hosted-assets').glob('upload.*')),[])

    def test_missing_retention_fails_closed_without_staging_or_cli(self):
        result = self.run_script()
        self.assert_not_uploaded(result)
        self.assertIn('Restore the retained generation',result.stderr)
        self.assertIn('HOSTED_ASSETS_FIRST_DEPLOY=1',result.stderr)

    def test_first_generation_requires_exact_opt_in(self):
        for value in ('0','true'):
            self.assert_not_uploaded(self.run_script(first=value))
        result = self.run_script(first='1')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(self.capture.exists())
        self.assertEqual(audit(self.retained)['revision'],audit(self.release)['revision'])
        self.assert_not_uploaded_after_existing_first_flag()

    def assert_not_uploaded_after_existing_first_flag(self):
        before = self.capture.read_bytes()
        result = self.run_script(first='1')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('existing retained generation',result.stderr)
        self.assertEqual(self.capture.read_bytes(),before)

    def test_valid_retention_is_audited_and_union_is_uploaded(self):
        self.pack(self.retained,b'old fixture bytes')
        old = {p.name:p.read_bytes() for p in (self.retained/'chunks').iterdir()}
        result = self.run_script()
        self.assertEqual(result.returncode,0,result.stderr)
        args = self.capture.read_text().splitlines()
        self.assertEqual(args[:3],['deploy','--config','wrangler.game-assets.jsonc'])
        self.assertEqual(args[3],'--assets')
        stage = self.root/args[4]
        self.assertEqual(audit(stage)['revision'],audit(self.release)['revision'])
        for name,data in old.items():
            self.assertEqual((stage/'chunks'/name).read_bytes(),data)
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


if __name__ == '__main__': unittest.main()
