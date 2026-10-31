#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('texture_audit', Path(__file__).with_name('renderer-texture-audit.py'))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class Storage:
    def __init__(self, data): self.data = data
    def read(self, resource): return self.data


def raw_texture():
    data = bytearray(1176)
    struct.pack_into('<4sI4BII', data, 0, b'BLP2', 1, 3, 8, 0, 0, 1, 1)
    struct.pack_into('<I', data, 20, 1172)
    struct.pack_into('<I', data, 84, 4)
    data[1172:] = bytes([3, 2, 1, 128])
    return bytes(data)


class TextureAuditTests(unittest.TestCase):
    def test_texture_build_identity_requires_its_saved_source_and_both_native_libraries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary, source, metadata = root/'probe', root/'source.rs', root/'identity.json'
            binary.write_bytes(b'texture-probe'); source.write_bytes(b'old texture-only source')
            libraries = {}
            for name in ('benilla_blp','serde_json'):
                path = root/(name+'.rlib');path.write_bytes(name.encode())
                libraries[name] = {'path':str(path),'sha256':audit.models.digest(path.read_bytes())}
            record = {'binarySha256':audit.models.digest(binary.read_bytes()),'probeSourceSnapshot':str(source),
                'probeSourceSha256':audit.models.digest(source.read_bytes()),'rlibs':libraries}
            metadata.write_text(json.dumps(record))
            self.assertEqual(audit.texture_native_identity(binary,metadata)['probeSourceSha256'],record['probeSourceSha256'])
            Path(libraries['serde_json']['path']).write_bytes(b'stale')
            with self.assertRaisesRegex(ValueError,'serde_json hash disagrees'):
                audit.texture_native_identity(binary,metadata)
            Path(libraries['serde_json']['path']).write_bytes(b'serde_json')
            del libraries['benilla_blp'];metadata.write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError,'missing required library'):
                audit.texture_native_identity(binary,metadata)

    def test_named_and_numeric_aliases_decode_once_after_each_source_is_verified(self):
        raw = raw_texture()
        calls = []
        def native(data):
            calls.append(data)
            return {'status':'decoded','assetType':'texture','width':1,'height':1,'mips':1,
                    'rgbaBytes':4,'nativeBytes':4,'nativeTexels':'Rgba8Unorm'}
        cache = {}
        expected = {'fileDataID':7,'sha256':audit.models.digest(raw)}
        first = audit.audit_texture(Storage(raw), expected, native, cache)
        second = audit.audit_texture(Storage(raw), dict(expected,resource='A\\B.BLP'), native, cache)
        self.assertEqual((first['status'],second['status']),('decoded','decoded'))
        self.assertEqual(len(calls),1)
        self.assertTrue(second['nativeDecodeReused'])
        self.assertEqual(second['resource'],'a/b.blp')

    def test_manifest_union_retains_associations_and_rejects_conflicting_source_hashes(self):
        merged = audit.merge_rows([{'fileDataID':7,'sha256':'a','references':['gear:1']},
                                   {'resource':'id:7','sha256':'a','references':['world:2']}])
        self.assertEqual(merged[0]['references'],['gear:1','world:2'])
        with self.assertRaisesRegex(ValueError,'source hashes disagree'):
            audit.merge_rows([{'fileDataID':7,'sha256':'a'},{'fileDataID':7,'sha256':'b'}])

    def test_model_texture_closure_uses_typed_dependencies_and_native_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'models.jsonl'
            path.write_text(json.dumps({'fileDataID':44,'dependencies':[
                {'kind':'TXID','fileDataID':7}, {'kind':'GPID','fileDataID':12,'format':'MD21'},
                {'kind':'other','fileDataID':9,'format':'BLP2'}],
                'nativeParser':{'texturePaths':['__classic/8.blp']}})+'\n')
            self.assertEqual({audit.resource_key(r) for r in audit.model_texture_rows(path)}, {'id:7','id:8','id:9'})

    def test_manifest_rejects_duplicate_and_invalid_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.jsonl'
            for rows in ([{'fileDataID': 7}]*2, [{'fileDataID': True}], [{'fileDataID': 0}]):
                path.write_text('\n'.join(json.dumps(r) for r in rows))
                with self.assertRaises(ValueError): audit.manifest_rows(path)

    def test_source_mismatch_never_enters_native_decoder(self):
        row = audit.audit_texture(Storage(b'BLP2'), {'fileDataID': 7, 'sha256': 'wrong'},
            lambda _: self.fail('Source mismatch must not be decoded.'))
        self.assertEqual(row['status'], 'source-mismatch')

    def test_native_decoder_errors_and_dimension_mismatch_remain_failures(self):
        data = raw_texture()
        expected = {'fileDataID': 7, 'sha256': audit.models.digest(data), 'header': {'width': 1, 'height': 1}}
        for result, status in [({'status': 'panic'}, 'panic'),
            ({'status': 'decoded', 'assetType': 'texture', 'width': 2, 'height': 1, 'mips': 1, 'rgbaBytes': 8}, 'invalid-native-response')]:
            self.assertEqual(audit.audit_texture(Storage(data), expected, lambda _: result)['status'], status)

    @unittest.skipUnless(os.environ.get('PULLFICTION_NATIVE_TEXTURE_READER'), 'Compiled production probe required.')
    def test_production_decoder_expands_authored_bgra_and_rejects_truncation(self):
        data = raw_texture()
        expected = {'fileDataID': 7, 'sha256': audit.models.digest(data), 'header': {'width': 1, 'height': 1}}
        with audit.models.NativeReader(Path(os.environ['PULLFICTION_NATIVE_TEXTURE_READER'])) as native:
            row = audit.audit_texture(Storage(data), expected, native.check)
            self.assertEqual(row['status'], 'decoded')
            self.assertEqual(row['nativeDecoder']['firstPixel'], [1, 2, 3, 128])
            self.assertEqual(row['nativeDecoder']['rgbaBytes'], 4)
            self.assertEqual(row['nativeDecoder']['nativeTexels'], 'Rgba8Unorm')
            self.assertEqual(native.check(data[:148])['status'], 'decode-error')


if __name__ == '__main__': unittest.main()
