#!/usr/bin/env python3
"""Portable fixtures for hosted chunks. No client game bytes are needed."""
import gzip
import importlib.util
from unittest.mock import patch
import json
from pathlib import Path
import tempfile
import unittest
from hosted_assets import ChunkWriter, audit, digest, json_bytes, revision

BUILD = {'product':'wow_classic_era','version':'1.15.9.70576','buildKey':'a'*32}

class HostedTests(unittest.TestCase):
    def make(self, path):
        writer = ChunkWriter(path, BUILD, chunk_bytes=8)
        writer.add('read:id:1', b'abcdefghijklmnopq')
        writer.add('catalog:test', b'{}')
        writer.add('read:empty', b'')
        return writer, writer.finish(status='complete', appearanceInputs=['read:id:1'])

    def rewrite(self, path, manifest):
        manifest['revision'] = revision(manifest)
        (path/'manifest.json').write_bytes(json_bytes(manifest))

    def test_split_and_determinism(self):
        with tempfile.TemporaryDirectory() as temp:
            a,b = Path(temp)/'a',Path(temp)/'b'
            _, first = self.make(a); _, second = self.make(b)
            self.assertEqual(first,second)
            self.assertEqual(len(first['files']['read:id:1']['parts']),3)
            self.assertEqual(audit(a)['files'],3)
            for chunk in first['chunks']:
                self.assertEqual((a/'chunks'/(chunk+'.bin.gz')).read_bytes(), (b/'chunks'/(chunk+'.bin.gz')).read_bytes())

    def test_identical_payload_aliases_share_pending_and_flushed_parts(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'
            writer = ChunkWriter(path,BUILD,chunk_bytes=8,max_bytes=17)
            payload = b'abcdefghijklmnopq'
            writer.add('read:first',payload)
            pending = bytes(writer.pending)
            writer.add('model:second',payload)
            self.assertEqual(writer.total,len(payload))
            self.assertEqual(bytes(writer.pending),pending)
            first = writer.manifest['files']['read:first']
            second = writer.manifest['files']['model:second']
            self.assertEqual(first,second)
            self.assertIsNot(first['parts'],second['parts'])
            self.assertTrue(all(a is not b for a,b in zip(first['parts'],second['parts'])))
            manifest = writer.finish()
            self.assertEqual(first,second)
            self.assertTrue(all(part['chunk'] for part in second['parts']))
            self.assertEqual(sum(row['rawBytes'] for row in manifest['chunks'].values()),len(payload))
            self.assertEqual(audit(path)['files'],2)

    def test_resumed_writer_rebuilds_dedup_index_and_handles_empty_aliases(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'
            writer = ChunkWriter(path,BUILD,chunk_bytes=8,max_bytes=9)
            writer.add('read:first',b'abcdefghi')
            writer.add('read:empty',b'')
            writer.flush()
            before = {p.name:p.read_bytes() for p in (path/'chunks').iterdir()}
            # Match the existing producer checkpoint restore, including absence
            # of fields introduced by later ChunkWriter versions.
            restored = ChunkWriter.__new__(ChunkWriter)
            restored.output, restored.limit = path, writer.limit
            restored.max_bytes, restored.max_files = writer.max_bytes, writer.max_files
            restored.pending, restored.references, restored.total = bytearray(), [], writer.total
            restored.manifest = json.loads(json_bytes(writer.manifest))
            restored.add('model:alias',b'abcdefghi')
            restored.add('read:also-empty',b'')
            manifest = restored.finish()
            self.assertEqual(restored.total,9)
            self.assertEqual(manifest['files']['read:first'],manifest['files']['model:alias'])
            self.assertEqual(manifest['files']['read:also-empty']['parts'],[])
            self.assertEqual(before,{p.name:p.read_bytes() for p in (path/'chunks').iterdir()})
            self.assertEqual(audit(path)['files'],4)

    def test_fresh_integer_catalog_keys_retain_creature_skin_and_bake_closure(self):
        spec = importlib.util.spec_from_file_location('prepare_catalog_fixture',Path(__file__).with_name('prepare-hosted-assets.py'))
        producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)
        creature = {'source':BUILD,'models':{205:{'fileDataID':101}},
            'displays':{8269:{'modelID':205,'textures':[124950,0],'extraDisplayID':30}},
            'extras':{30:{'bakeFileDataID':88}}}
        pairs = producer.normalized_catalog_pairs({'creatures':creature})
        self.assertIn(101,producer.model_tools.inventory(pairs,BUILD))
        self.assertEqual(producer.model_tools.appearance_dependencies(pairs),{101:{124950,88}})
        self.assertEqual(producer.creature_texture_resources(creature),[88,124950])
        # Source textures still seed when an optional display model is absent.
        creature['models'] = {}
        self.assertEqual(producer.creature_texture_resources(creature),[88,124950])

    def test_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'; _, manifest = self.make(path)
            chunk = next(iter(manifest['chunks']))
            (path/'chunks'/(chunk+'.bin.gz')).write_bytes(b'broken')
            with self.assertRaisesRegex(ValueError,'integrity'): audit(path)

    def test_bounds_and_resource_hash(self):
        for mutation in ('bounds','hash','length'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'out'; _, manifest = self.make(path)
                entry = manifest['files']['read:id:1']
                if mutation=='bounds': entry['parts'][0]['offset']=999
                elif mutation=='hash': entry['sha256']='0'*64
                else: entry['bytes']+=1
                self.rewrite(path,manifest)
                with self.assertRaises(ValueError): audit(path)

    def test_revision_and_missing_appearance(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'; _, manifest = self.make(path)
            manifest['appearanceInputs'].append('read:absent')
            (path/'manifest.json').write_bytes(json_bytes(manifest))
            with self.assertRaisesRegex(ValueError,'revision'): audit(path)
            self.rewrite(path, manifest)
            with self.assertRaisesRegex(ValueError,'appearance'): audit(path)

    def test_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'; self.make(path)
            (path/'link').symlink_to(path/'manifest.json')
            with self.assertRaisesRegex(ValueError,'Symlinks'): audit(path)

    def test_limits_and_changed_resource(self):
        with tempfile.TemporaryDirectory() as temp:
            writer = ChunkWriter(Path(temp)/'out',BUILD,chunk_bytes=8,max_bytes=10,max_files=2)
            writer.add('read:id:1',b'12345')
            with self.assertRaisesRegex(ValueError,'changed'): writer.add('read:id:1',b'54321')
            with self.assertRaisesRegex(ValueError,'budget'): writer.add('read:id:2',b'123456')
            writer.add('read:id:2',b'12345')
            with self.assertRaisesRegex(ValueError,'budget'): writer.add('read:id:3',b'')

    def test_required_source_failure_has_no_manifest(self):
        spec = importlib.util.spec_from_file_location('prepare_hosted_fixture',Path(__file__).with_name('prepare-hosted-assets.py'))
        producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)
        catalogs = {kind:{'source':BUILD} for kind in ('spells','creatures','items','characters','world')}
        catalogs['creatures']['characterModelPaths'] = {}
        snapshot = {'manifest':{'status':'complete'},'catalogs':catalogs}
        class Storage:
            def read(self,name):
                if name=='fonts/frizqt__.ttf': raise producer.assets.AssetError('Missing required font')
                return b'fixture table'
        class Appearance:
            def __init__(self,*args):
                self.tables = {'ChrCustomizationMaterial':{},'TextureFileData':{}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'
            with patch.object(producer.catalog_tools,'snapshot_catalogs',return_value=snapshot), patch.object(producer.catalog_tools,'prefix_reader',return_value=None), patch.object(producer.model_tools,'inventory',return_value={77:[]}), patch.object(producer.model_tools,'appearance_dependencies',return_value={}), patch.object(producer.model_tools,'excluded_model_consumers',return_value=[]), patch.object(producer,'lighting_catalog',return_value={'source':BUILD}), patch.object(producer,'talent_catalog',return_value={'source':BUILD}), patch.object(producer,'Characters',Appearance), patch.object(producer,'named_table',return_value=({},'')):
                with self.assertRaisesRegex(producer.assets.AssetError,'Missing required'):
                    producer.prepare(Storage(),BUILD,path,[])
            self.assertFalse((path/'manifest.json').exists())
            self.assertEqual(json.loads(Path(str(path)+'.failure.json').read_bytes())['status'],'failed')
            # The same build can resume after the required local input becomes
            # available; globally missing optional models remain explicit.
            class RepairedStorage:
                def read(self,name):
                    if name=='id:77': raise producer.assets.AssetError('Missing optional model')
                    return b'fixture table'
            with patch.object(producer.catalog_tools,'snapshot_catalogs',return_value=snapshot), patch.object(producer.catalog_tools,'prefix_reader',return_value=None), patch.object(producer.model_tools,'inventory',return_value={77:['creature:fixture']}), patch.object(producer.model_tools,'appearance_dependencies',return_value={}), patch.object(producer.model_tools,'excluded_model_consumers',return_value=[]), patch.object(producer,'lighting_catalog',return_value={'source':BUILD}), patch.object(producer,'talent_catalog',return_value={'source':BUILD}), patch.object(producer,'Characters',Appearance), patch.object(producer,'named_table',return_value=({},'')):
                manifest, report = producer.prepare(RepairedStorage(),BUILD,path,[],resume=True)
            self.assertEqual(manifest['status'],'ready')
            self.assertEqual(manifest['unsupported']['id:77']['references'],['creature:fixture'])
            self.assertNotIn('model:id:77',manifest['files'])
            self.assertTrue(Path(str(path)+'.report.json').is_file())
            self.assertEqual(report['status'],'verified')
            self.assertEqual(audit(path)['status'],'verified')

    def test_prepared_output_removes_unsupported_only_chunks_and_preserves_shared_slices(self):
        spec = importlib.util.spec_from_file_location('prepare_pruning_fixture',Path(__file__).with_name('prepare-hosted-assets.py'))
        producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)
        for shared_pending in (False,True):
            with self.subTest(shared_pending=shared_pending), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'prepared'
                writer = ChunkWriter(path,BUILD,chunk_bytes=4)
                writer.add('model:unsupported',b'DROP')
                exclusive = writer.manifest['files']['model:unsupported']['parts'][0]['chunk']
                writer.add('model:unsupported-shared',b'KEEP')
                writer.add('model:supported-shared',b'KEEP')
                shared = writer.manifest['files']['model:supported-shared']['parts'][0]['chunk']
                writer.add('read:supported',b'GOOD')
                writer.add('model:unsupported-mixed',b'BAD')
                writer.add('read:supported-mixed',b'g')
                mixed = writer.manifest['files']['read:supported-mixed']['parts'][0]['chunk']
                writer.add('model:unsupported-pending',b'xx')
                if shared_pending: writer.add('read:supported-pending',b'xx')
                # A resumed producer may have written a chunk after its last
                # checkpoint; it is also unreferenced fresh output, not history.
                orphan = gzip.compress(b'authored checkpoint orphan',mtime=0)
                orphan_sha = digest(orphan)
                (path/'chunks'/(orphan_sha+'.bin.gz')).write_bytes(orphan)
                for key in ('model:unsupported','model:unsupported-shared','model:unsupported-mixed','model:unsupported-pending'):
                    writer.manifest['files'].pop(key)
                producer.prune_prepared_chunks(writer)
                manifest = writer.finish(appearanceInputs=[])
                reachable = {part['chunk'] for entry in manifest['files'].values() for part in entry['parts']}
                physical = {p.name[:-7] for p in (path/'chunks').iterdir()}
                self.assertEqual(physical,reachable)
                self.assertEqual(set(manifest['chunks']),reachable)
                self.assertNotIn(exclusive,physical)
                self.assertNotIn(orphan_sha,physical)
                self.assertIn(shared,physical)
                self.assertIn(mixed,physical)
                self.assertEqual(len(physical),4 if shared_pending else 3)
                self.assertEqual(audit(path)['status'],'verified')
                producer.prune_prepared_chunks(writer)  # Safe to resume/repeat.
                self.assertEqual({p.name[:-7] for p in (path/'chunks').iterdir()},reachable)

    def test_unexpected_public_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'out'; self.make(path)
            (path/'report.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'public'): audit(path)

    def test_header_template(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'; self.make(path)
            template = Path(__file__).resolve().parent.parent/'cloudflare/game-asset-headers'
            (path/'_headers').write_bytes(template.read_bytes())
            self.assertEqual(audit(path)['status'],'verified')
            (path/'_headers').write_text('unsafe')
            with self.assertRaisesRegex(ValueError,'headers'): audit(path)

    def test_retained_chunks(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'out'; self.make(path)
            extra = gzip.compress(b'previous generation',mtime=0)
            file = path/'chunks'/(digest(extra)+'.bin.gz'); file.write_bytes(extra)
            self.assertEqual(audit(path)['status'],'verified')
            file.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'Retained'): audit(path)

if __name__=='__main__': unittest.main()
