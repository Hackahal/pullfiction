#!/usr/bin/env python3
"""Publication rules with synthetic bytes; no installed game data or credentials."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
spec = importlib.util.spec_from_file_location('repository_audit', Path(__file__).with_name('repository-audit.py'))
audit = importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


class PublicationTests(unittest.TestCase):
    def test_local_paths_and_binary_assets_rejected(self):
        for path in ['.agent/work/log.json','target/a.rs','web/editor/node_modules/lib/index.js','WoW/Data/a',
                     'web/editor/.env','.env.local','.probe-identity','data/game.BLP','viewer.wasm','report.har',
                     '.agents/skills/impeccable/SKILL.md','.agents/design-skills.lock.json',
                     '.codex/config.toml','.claude/settings.json','AGENTS.md','CLAUDE.md',
                     'docs/PERFORMANCE-REVIEW-2026-09-10.md']:
            with self.subTest(path=path):self.assertIsNotNone(audit.path_problem(path))

    def test_source_templates_and_project_files_allowed(self):
        for path in ['web/editor/.env.example','web/editor/.env.sample','crates/benilla-app/assets/ui/OptionsFrame.xml',
                     'DESIGN.md','third_party/wowdbdefs/SpellMisc.dbd','scripts/repository-audit.py']:
            with self.subTest(path=path):self.assertIsNone(audit.path_problem(path))

    def test_current_tree_scope_still_rejects_forced_tracked_local_tooling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'.agents').mkdir()
            (root/'.agents/lock.json').write_text('{}')
            with patch.object(audit,'ROOT',root), patch.object(audit,'git',return_value=b'.agents/lock.json\0') as git:
                report=audit.audit(history=False)
            git.assert_called_once_with('ls-files','-z','--cached','--others','--exclude-standard')
            self.assertEqual(report['scope'],{'current':True,'history':False})
            self.assertEqual(report['findings'][0]['path'],'.agents/lock.json')

    def test_default_audit_retains_history_scanning(self):
        with patch.object(audit,'git',return_value=b''), patch.object(audit,'audit_history',return_value=([{'scope':'history'}],2)) as history:
            report=audit.audit()
        history.assert_called_once_with('HEAD',[],0)
        self.assertEqual(report['scope'],{'current':True,'history':True})
        self.assertEqual(report['findings'],[{'scope':'history'}])

    def test_signature_and_magic_checks(self):
        self.assertIn('GitHub token',audit.content_problems(('ghp_'+'a'*36).encode()))
        self.assertIn('private key',audit.content_problems(('-----BEGIN '+'OPENSSH PRIVATE KEY-----\n'+'YQ=='*16).encode()))
        self.assertIn('game or WebAssembly payload magic',audit.content_problems(b'BLP2'+bytes(20)))
        self.assertIn('game or WebAssembly payload magic',audit.content_problems(bytes([0,97,115,109,1,0,0,0])))
        self.assertEqual(audit.content_problems(b'const publicClientId = "1234567890";'),[])


if __name__ == '__main__':unittest.main()
