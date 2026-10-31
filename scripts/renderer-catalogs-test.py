#!/usr/bin/env python3
"""Synthetic catalog snapshot/provenance tests; no client, network or CascLib."""
import ctypes as ct
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('catalog_snapshot',Path(__file__).with_name('renderer-catalogs.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
SOURCE={'product':'wow_classic_era','version':'1.15.9.70576','buildKey':'a'*32}
TABLE=b'WDC5'+bytes(152)+struct.pack('<I',0x12345678)
HEADER=b'MD21'+struct.pack('<I',100)+b'MD20'


def exporters(failure=None,mismatch=None):
    def exporter(name):
        def run(read,source,**kwargs):
            raw=read('dbfilesclient/curve.db2')
            if name==failure:raise ValueError('Unsupported synthetic layout')
            out={'source':dict(source),'layouts':{'Curve':'12345678'},'rows':[len(raw)]}
            if name=='spells':
                prefix=kwargs['read_header']
                out['prefixes']=[prefix('id:7',0,12).hex(),prefix('id:7',0,12).hex()]
            if name=='items':out.update(itemVisuals={'3':[8]},enchantments={'9':3})
            if name==mismatch:out['source']['buildKey']='b'*32
            return out
        return run
    return {name:exporter(name) for name in c.CATALOGS}


class CatalogTests(unittest.TestCase):
    def snapshot(self,**kwargs):
        reads,headers=[],[]
        def read(name):reads.append(name);return TABLE
        def header(name,offset,size):headers.append((name,offset,size));return HEADER
        return c.snapshot_catalogs(read,SOURCE,header,exporters=exporters(**kwargs)),reads,headers

    def test_five_exporters_share_immutable_hashed_source_and_deduplicated_bounded_probes(self):
        snapshot,reads,headers=self.snapshot()
        self.assertEqual(reads,['dbfilesclient/curve.db2'])
        self.assertEqual(headers,[('id:7',0,12)])
        manifest=snapshot['manifest'];row=manifest['sourceTableReads'][reads[0]]
        self.assertEqual(manifest['status'],'complete')
        self.assertEqual(row['calls'],5)
        self.assertEqual(set(row['catalogs']),set(c.CATALOGS))
        self.assertEqual(row['sha256'],c.digest(TABLE))
        self.assertEqual(row['headerLayout'],'12345678')
        self.assertIn('definitionSha256',row)
        self.assertEqual(manifest['totals']['requestedPrefixBytes'],12)
        self.assertEqual(manifest['spellFormatProbes']['id:7']['calls'],2)
        for name,catalog in snapshot['catalogs'].items():
            self.assertEqual(catalog['source'],SOURCE)
            self.assertEqual(manifest['catalogs'][name]['sha256'],c.digest(c.json_bytes(catalog)))
        self.assertEqual(snapshot['catalogs']['items']['enchantments'],{'9':3})

    def test_failure_is_partial_without_an_empty_catalog_substitute(self):
        snapshot,_,_=self.snapshot(failure='items')
        self.assertEqual(snapshot['manifest']['status'],'partial')
        self.assertNotIn('items',snapshot['catalogs'])
        self.assertEqual(snapshot['manifest']['catalogs']['items']['status'],'failed')
        self.assertEqual(len(snapshot['catalogs']),4)

    def test_source_mismatch_and_unidentified_source_are_fatal(self):
        with self.assertRaisesRegex(ValueError,'source identity'):
            self.snapshot(mismatch='items')
        def forbidden(*args):self.fail('An unidentified source must not be read')
        with self.assertRaises(ValueError):c.snapshot_catalogs(forbidden,{},forbidden)

    def test_missing_table_is_cached_and_never_fabricated(self):
        calls=[]
        def absent(name):calls.append(name);raise FileNotFoundError('not installed')
        result=c.snapshot_catalogs(absent,SOURCE,lambda *args:HEADER,exporters=exporters())
        self.assertEqual(len(calls),1)
        self.assertEqual(result['catalogs'],{})
        self.assertEqual(result['manifest']['sourceTableReads'][calls[0]]['status'],'unavailable')
        self.assertEqual(result['manifest']['status'],'partial')

    def test_short_probe_fails_once_without_full_model_fallback(self):
        calls=[]
        def short(*args):calls.append(args);return HEADER[:-1]
        result=c.snapshot_catalogs(lambda name:TABLE,SOURCE,short,exporters=exporters())
        self.assertEqual(calls,[('id:7',0,12)])
        self.assertEqual(result['manifest']['spellFormatProbes']['id:7']['returnedBytes'],11)
        self.assertEqual(result['manifest']['spellFormatProbes']['id:7']['status'],'unavailable')
        self.assertEqual(result['manifest']['catalogs']['spells']['status'],'failed')

    def test_cli_rejects_a_build_info_change_before_writing_any_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);build=root/'.build.info';build.write_bytes(b'before')
            def capture(*args,**kwargs):
                build.write_bytes(b'after')
                return {'catalogs':{},'manifest':{'status':'partial'}}
            with patch.object(c,'output_path',return_value=root/'result'), \
                 patch.object(c.assets,'client_build',return_value=SOURCE), \
                 patch.object(c.assets,'CascStorage'), \
                 patch.object(c,'snapshot_catalogs',side_effect=capture), \
                 patch.object(c,'write_snapshot') as write:
                with self.assertRaisesRegex(ValueError,'identity changed'):
                    c.main(['--install',str(root),'--output',str(root/'result')])
                write.assert_not_called()

    def test_only_catalog_json_and_manifest_are_written_to_a_fresh_ignored_directory(self):
        snapshot,_,_=self.snapshot()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);output=root/'.agent/work/snapshot'
            c.write_snapshot(snapshot,output,root=root)
            self.assertEqual({p.name for p in output.iterdir()},{'manifest.json'}|{n+'.json' for n in c.CATALOGS})
            for name in c.CATALOGS:
                raw=(output/(name+'.json')).read_bytes()
                self.assertEqual(c.digest(raw),snapshot['manifest']['catalogs'][name]['sha256'])
                self.assertEqual(json.loads(raw)['source'],SOURCE)
            with self.assertRaises(FileExistsError):c.write_snapshot(snapshot,output,root=root)
            with self.assertRaisesRegex(ValueError,'ignored'):c.write_snapshot(snapshot,root/'tracked',root=root)
            snapshot['catalogs']['items']['rows'].append(99)
            with self.assertRaisesRegex(ValueError,'changed after'):c.write_snapshot(snapshot,root/'.agent/work/new',root=root)
            self.assertFalse((root/'.agent/work/new').exists())

    def test_actual_prefix_reader_uses_strict_local_flags_and_closes_failed_reads(self):
        class Lib:
            def __init__(self):self.opens=[];self.closes=0;self.short=False
            def CascOpenFile(self,storage,resource,locale,flags,handle):
                self.opens.append((resource.value,locale,flags));handle._obj.value=10;return True
            def CascReadFile(self,handle,data,size,count):
                self.assert_size=size;ct.memmove(data,HEADER,12);count._obj.value=11 if self.short else 12;return True
            def CascCloseFile(self,handle):self.closes+=1
        class Storage:pass
        storage=Storage();storage.lib=Lib();storage.handle=ct.c_void_p(1)
        read=c.prefix_reader(storage)
        self.assertEqual(read('id:7',0,12),HEADER)
        self.assertEqual(storage.lib.opens,[(7,2,0x13)])
        self.assertEqual(storage.lib.assert_size,12)
        storage.lib.short=True
        with self.assertRaises(c.assets.AssetError) as error:read('id:7',0,12)
        self.assertEqual(error.exception.returned_bytes,11)
        self.assertEqual(storage.lib.closes,2)
        for args in [('id:7',0,13),('id:7',1,12),('model.m2',0,12)]:
            with self.assertRaises(ValueError):read(*args)
        self.assertEqual(len(storage.lib.opens),2)


if __name__=='__main__':unittest.main()
