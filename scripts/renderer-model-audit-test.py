#!/usr/bin/env python3
"""Synthetic audit regression tests, with no game assets or CascLib required."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from renderer_character_audit import catalog_texture_references, customization_requests
import classic_items


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load('renderer_model_audit', 'renderer-model-audit.py')
fixture = load('compat_fixtures', 'classic-compat-test.py').fixture
SOURCE = {'product': 'wow_classic_era', 'version': '1.15.9.70576', 'buildKey': 'a' * 32}


def chunk(tag, value):
    return tag + struct.pack('<I', len(value)) + value


class Storage:
    def __init__(self, files):
        self.files, self.reads = files, []

    def read(self, name):
        self.reads.append(name)
        if name not in self.files:
            raise audit.assets.AssetError('Unavailable locally')
        return self.files[name]


def model(extra=b''):
    raw, skin = fixture()
    raw += chunk(b'SFID', struct.pack('<I', 42)) + extra
    return raw, skin


class AuditTests(unittest.TestCase):
    def test_source_proven_wmo_effect_keeps_its_own_consumer_in_global_inventory(self):
        catalog = {'source':SOURCE, 'effects':{'8':{'fileDataID':44,'assetFormat':'m2'},
                   '9':{'fileDataID':55,'assetFormat':'wmo'}}}
        catalogs = [(Path('graph.json'),catalog)]
        self.assertEqual(audit.inventory(catalogs,SOURCE),{44:['spell-effect:8']})
        self.assertEqual(audit.excluded_model_consumers(catalogs)[0]['consumer'],'world-WMO')
        self.assertEqual(audit.excluded_model_consumers(catalogs)[0]['fileDataID'],55)

    def test_native_identity_checks_actual_binary_and_its_saved_source(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary, source, metadata = root/'probe', root/'probe.rs', root/'identity.json'
            binary.write_bytes(b'compiled-probe')
            source.write_bytes(b'exact-source')
            libraries = {}
            for name in ('benilla_formats','serde_json'):
                path = root / (name + '.rlib')
                path.write_bytes(name.encode())
                libraries[name] = {'path':str(path), 'sha256':audit.digest(path.read_bytes())}
            metadata.write_text(json.dumps({'binarySha256':audit.digest(binary.read_bytes()),
                'probeSourceSha256':audit.digest(source.read_bytes()), 'probeSourceSnapshot':str(source), 'rlibs':libraries}))
            self.assertEqual(audit.native_reader_identity(binary, metadata)['sourceSha256'], audit.digest(source.read_bytes()))
            source.write_bytes(b'different-source')
            with self.assertRaisesRegex(ValueError, 'source snapshot disagrees'):
                audit.native_reader_identity(binary, metadata)
            binary.write_bytes(b'different-binary')
            with self.assertRaisesRegex(ValueError, 'reader hash disagrees'):
                audit.native_reader_identity(binary, metadata)

    def test_native_identity_requires_saved_source_and_all_declared_library_bytes(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary, source, metadata = root/'probe', root/'source.rs', root/'identity.json'
            binary.write_bytes(b'compiled-probe')
            source.write_bytes(b'old combined reader uses benilla_blp::decode')
            libraries = {}
            for name in ('benilla_formats','serde_json','benilla_blp'):
                path = root / (name + '.rlib')
                path.write_bytes(name.encode())
                libraries[name] = {'path':str(path),'sha256':audit.digest(path.read_bytes())}
            record = {'binarySha256':audit.digest(binary.read_bytes()),'probeSourceSha256':audit.digest(source.read_bytes()),
                      'probeSourceSnapshot':str(source),'rlibs':libraries}
            def save(): metadata.write_text(json.dumps(record))
            save()
            self.assertEqual(audit.native_reader_identity(binary,metadata)['sourceSha256'],record['probeSourceSha256'])
            # An unrelated current helper is never substituted for the retained old source.
            (root/'current.rs').write_bytes(b'different current helper')
            self.assertEqual(audit.native_reader_identity(binary,metadata)['sourceSha256'],record['probeSourceSha256'])
            stale = Path(libraries['serde_json']['path'])
            stale.write_bytes(b'newer-library')
            with self.assertRaisesRegex(ValueError,'serde_json hash disagrees'):
                audit.native_reader_identity(binary,metadata)
            stale.write_bytes(b'serde_json')
            Path(libraries['benilla_blp']['path']).unlink()
            with self.assertRaisesRegex(ValueError,'benilla_blp is unavailable'):
                audit.native_reader_identity(binary,metadata)
            del libraries['benilla_blp']; save()
            with self.assertRaisesRegex(ValueError,'missing required library'):
                audit.native_reader_identity(binary,metadata)
            del record['probeSourceSnapshot']; save()
            with self.assertRaisesRegex(ValueError,'preserved source snapshot'):
                audit.native_reader_identity(binary,metadata)

    def test_particle_blend_and_palette_modes_are_source_evidence(self):
        source, _ = load('compat_particle_mode_fixture', 'classic-compat-test.py').particle_geometry_fixture()
        parts = audit.assets.chunks(source)
        body = bytearray(parts['MD21'])
        at = audit.read(body, '<I', 0x12c)[0]
        struct.pack_into('<BBH', body, at + 40, 5, 3, 13)
        parts['MD21'] = bytes(body)
        _, _, info, _ = audit.raw_evidence(b''.join(chunk(k.encode(), v) for k, v in parts.items()))
        self.assertEqual(info['features']['particleBlends'].get('5'), 1)
        self.assertEqual(info['features']['particleColorIndices'].get('13'), 1)
        self.assertEqual(info['features']['particleShapes'].get('3'), 1)

    def test_world_manifest_preserves_numeric_and_named_model_identity(self):
        selected = {100: ['creature:1']}
        audit.merge_model_manifest(selected, {'source': SOURCE, 'models': {'100': ['world:2']},
            'namedModels': {'World/Skybox/Test.m2': ['skybox:3']}}, SOURCE)
        self.assertEqual(selected[100], ['creature:1', 'world:2'])
        self.assertEqual(selected['world/skybox/test.m2'], ['skybox:3'])
        with self.assertRaisesRegex(ValueError, 'source disagrees'):
            audit.merge_model_manifest({}, {'source': {}}, SOURCE)

    def test_catalog_texture_leaves_include_body_regions_without_numeric_profile_fields(self):
        catalog = {'displays': {'3': {'models': [[{'file': 100, 'race': 8, 'sex': 1}]],
            'textures': [[{'file': 200, 'race': 6, 'sex': 0}]],
            'regions': {'7': [{'file': 300, 'race': 2, 'sex': 1}]}}}}
        self.assertEqual(set(catalog_texture_references([(Path('items'), catalog)])), {200, 300})

    def test_item_catalog_retains_authored_particle_color_reference(self):
        tables = {name: {} for name in classic_items.TABLES}
        tables['ItemDisplayInfo'][9] = {'ModelResourcesID': [0, 0], 'ModelMaterialResourcesID': [0, 0],
            'GeosetGroup': [0] * 6, 'HelmetGeosetVis': [0, 0], 'ItemVisual': 0,
            'ItemRangedDisplayInfoID': 0, 'ParticleColorID': 777}
        with patch.object(classic_items, 'read_tables', return_value=(tables, {})), \
             patch.object(classic_items, 'particle_colors', return_value={777: [[[0.1]*3]*3]*3}):
            self.assertEqual(classic_items.item_catalog(None, SOURCE)['displays'][9]['particleColorID'], 777)

    def test_item_rows_without_default_appearance_remain_explicit_metadata(self):
        tables = {name: {} for name in classic_items.TABLES}
        tables['Item'][41] = {'ClassID':4,'SubclassID':0,'InventoryType':6,'Material':7,
                            'SheatheType':0,'IconFileDataID':132494}
        with patch.object(classic_items, 'read_tables', return_value=(tables, {})):
            catalog = classic_items.item_catalog(None, SOURCE)
        self.assertEqual(catalog['coverage']['sourceItemRows'], 1)
        self.assertEqual(catalog['items'], {})
        self.assertEqual(catalog['unresolvedItems'][41]['display'], 0)
        self.assertEqual(catalog['unresolvedItems'][41]['iconFile'], 132494)

    def test_condition_pair_requests_preserve_both_selected_choices(self):
        graph = {'bodies': [{'modelId': 1, 'race': 1, 'sex': 0}],
            'options': {2: {'ID': 2, 'ChrModelID': 1}, 3: {'ID': 3, 'ChrModelID': 1}},
            'choices': {20: {'ChrCustomizationOptionID': 2}, 30: {'ChrCustomizationOptionID': 3}},
            'elements': {1: {'ChrCustomizationChoiceID': 20, 'RelatedChrCustomizationChoiceID': 30}}}
        requests = dict(customization_requests(graph, {'legacyConversions': []}))
        self.assertEqual(requests['related:20:30']['choices'], {'2': 20, '3': 30})

    def test_recursive_particle_ids_are_dependencies_even_when_inline_names_are_empty(self):
        source, _ = load('compat_particle_fixtures2', 'classic-compat-test.py').particle_geometry_fixture()
        source += chunk(b'RPID', struct.pack('<3I', 0, 166404, 166404))
        _, _, info, dependencies = audit.raw_evidence(source)
        self.assertEqual([d for d in dependencies if d[0] == 'RPID'], [('RPID', 166404), ('RPID', 166404)])
        self.assertEqual(info['features']['recursiveModelParticles'], 2)

    def test_geometry_particle_models_are_dependency_evidence(self):
        source, _ = load('compat_particle_fixtures', 'classic-compat-test.py').particle_geometry_fixture((101, 0, 103))
        _, _, evidence, dependencies = audit.raw_evidence(source)
        self.assertEqual([entry for entry in dependencies if entry[0] == 'GPID'], [('GPID', 101), ('GPID', 103)])
        self.assertEqual(evidence['features']['geometryModelParticles'], 2)

    def test_output_guard_follows_retained_data_symlink_to_real_installation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            game, retained = root / 'game', root / 'retained'
            (game / 'Data').mkdir(parents=True)
            retained.mkdir()
            (retained / 'Data').symlink_to(game / 'Data', target_is_directory=True)
            for output in [game, game / 'cache', game / 'Data' / 'cache', retained / 'cache']:
                with self.subTest(output=output), self.assertRaisesRegex(ValueError, 'read-only'):
                    audit.validate_output_location(retained, output.resolve())
            audit.validate_output_location(retained, (root / 'evidence').resolve())

    def test_inventory_deduplicates_categories_and_preserves_associations(self):
        catalog = {'source': SOURCE, 'models': {'1': {'fileDataID': 100}, '2': {'fileDataID': 0}},
                   'effects': {'3': {'fileDataID': 100}}, 'displays': {'4': {'models': [[{'file': 200}]]}},
                   'characterModelPaths': {'Character/test.m2': 100}}
        result = audit.inventory([(Path('catalog.json'), catalog)], SOURCE)
        self.assertEqual(list(result), [100, 200])
        self.assertEqual(result[100], ['creature:1', 'character:Character/test.m2', 'spell-effect:3'])
        with self.assertRaisesRegex(ValueError, 'build disagrees'):
            audit.inventory([(Path('catalog.json'), catalog)], dict(SOURCE, version='other'))

    def test_success_records_both_evidence_and_never_claims_rendering(self):
        raw, skin = model()
        result = audit.audit_model(Storage({'id:1': raw, 'id:42': skin}), 1, ['explicit'])
        self.assertEqual(result['status'], 'adapted')
        self.assertTrue(all(result['adapted']['checks'].values()))
        self.assertEqual(result['source']['counts']['bones'], 1)
        self.assertEqual(result['source']['sequenceDurations'], [1000, 1000])
        self.assertEqual(result['dependencies'][0]['sha256'], audit.digest(skin))
        report = audit.summary([result])
        self.assertEqual((report['rendered'], report['visuallyChecked']), (0, 0))

    def test_appearance_textures_are_read_and_preserve_missing_status(self):
        catalogs = [(Path('creatures'), {'source': SOURCE, 'models': {'3': {'fileDataID': 100}},
                    'displays': {'4': {'modelID': 3, 'textures': [55, 0], 'extraDisplayID': 7}},
                    'extras': {'7': {'bakeFileDataID': 56}}}),
                    (Path('items'), {'source': SOURCE, 'displays': {'5': {
                        'models': [[{'file': 100}]], 'textures': [[{'file': 57}]]}}})]
        textures = audit.appearance_dependencies(catalogs)
        self.assertEqual(textures, {100: {55, 56, 57}})
        raw, skin = model()
        result = audit.audit_model(Storage({'id:100': raw, 'id:42': skin, 'id:55': b'BLP2'}),
                                   100, [], appearance_textures=textures[100])
        self.assertEqual(result['status'], 'adapted')
        self.assertEqual(result['missingDependencies'], 2)
        self.assertEqual([d['fileDataID'] for d in result['dependencies'] if d['kind'] == 'appearance-texture'], [55, 56, 57])

    def test_valid_wmo_effect_is_a_different_pipeline_not_corrupt_m2(self):
        raw = chunk(b'REVM', struct.pack('<I', 17)) + chunk(b'DHOM', bytes(64))
        result = audit.audit_model(Storage({'id:1': raw}), 1, ['spell-effect:5'])
        self.assertEqual(result['status'], 'other-format')
        self.assertEqual(result['source']['format'], 'WMO')
        self.assertEqual(result['otherFormatDependencies'], [])

    def test_nonfinite_vertex_is_invalid_before_json_evidence_publication(self):
        _, skin = model()
        raw, _ = fixture()
        body = bytearray(audit.assets.chunks(raw)['MD21'])
        offset = len(body)
        body.extend(bytes(48))
        struct.pack_into('<II', body, 0x3c, 1, offset)
        struct.pack_into('<f', body, offset + 28, float('nan'))
        result = audit.audit_model(Storage({'id:1': chunk(b'MD21', body), 'id:42': skin}), 1, [])
        self.assertEqual(result['status'], 'invalid')
        self.assertIn('Non-finite', result['error'])

    def test_missing_texture_is_separate_from_successful_conversion(self):
        raw, skin = model(chunk(b'TXID', struct.pack('<I', 43)))
        result = audit.audit_model(Storage({'id:1': raw, 'id:42': skin}), 1, [])
        self.assertEqual(result['status'], 'adapted')
        self.assertEqual(result['dependencyStatus'], 'unavailable')
        self.assertEqual(result['missingDependencies'], 1)
        self.assertFalse(result['dependencies'][-1]['available'])

    def test_missing_skin_is_unavailable_dependency_and_missing_model_is_unavailable(self):
        raw, _ = model()
        store = Storage({'id:1': raw})
        self.assertEqual(audit.audit_model(store, 1, [])['status'], 'unavailable-dependency')
        self.assertEqual(audit.audit_model(store, 2, [])['status'], 'unavailable')

    def test_external_animation_stays_unsupported_with_dependency_evidence(self):
        raw, skin = model(chunk(b'AFID', struct.pack('<HHI', 10, 0, 44)))
        result = audit.audit_model(Storage({'id:1': raw, 'id:42': skin, 'id:44': b'animation'}), 1, [])
        self.assertEqual(result['status'], 'unsupported')
        self.assertIn('External modern', result['family'])
        self.assertEqual(result['dependencies'][-1]['fileDataID'], 44)
        self.assertIn('skinFeatures', result)

    def test_corrupt_array_is_invalid_and_does_not_pass_preservation(self):
        raw, skin = model()
        raw = bytearray(raw)
        struct.pack_into('<II', raw, 8 + 0x3c, 1, len(raw) + 1)
        result = audit.audit_model(Storage({'id:1': bytes(raw), 'id:42': skin}), 1, [])
        self.assertEqual(result['status'], 'invalid')
        self.assertNotIn('adapted', result)

    def test_preservation_detects_position_and_sequence_corruption(self):
        raw, skin = model()
        body = bytearray(audit.assets.chunks(raw)['MD21'])
        offset = len(body)
        body.extend(bytes(48))
        struct.pack_into('<II', body, 0x3c, 1, offset)
        struct.pack_into('<3f', body, offset, 2, -3, 4)
        adapted = bytearray(audit.adapt_model(chunk(b'MD21', body), [skin]))
        self.assertTrue(all(audit.preservation(body, [skin], adapted).values()))
        _, vertices = audit.read(adapted, '<II', 0x44)
        struct.pack_into('<f', adapted, vertices, 999)
        _, sequences = audit.read(adapted, '<II', 0x1c)
        struct.pack_into('<I', adapted, sequences + 8, 999)
        checks = audit.preservation(body, [skin], adapted)
        self.assertFalse(checks['verticesExact'])
        self.assertFalse(checks['sequenceDurationsExact'])


if __name__ == '__main__':
    unittest.main()
