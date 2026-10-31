#!/usr/bin/env python3
"""Snapshot the five production renderer catalogs from one offline client.

Only catalog JSON and provenance are written, under a fresh .agent/work folder.
DB2 reads are hashed/cached across exporters; model format reads are deduplicated
12-byte prefixes. No client model, texture or table bytes are exported.
"""
import argparse
import ctypes as ct
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct

from classic_character_catalog import character_catalog
from classic_creatures import creature_catalog, source_check
from classic_items import item_catalog
from classic_spells import DEFINITIONS, spell_catalog
from classic_world_catalog import world_catalog

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('catalog_assets', ROOT/'scripts/classic-assets.py')
assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assets)
CATALOGS = {'spells':spell_catalog, 'creatures':creature_catalog, 'items':item_catalog,
            'characters':character_catalog, 'world':world_catalog}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()


def snapshot_catalogs(read, source, read_header, *, exporters=None):
    """Pure injected-I/O entry point; production exporters are the default.

    Exporter failures are recorded as partial snapshots, never empty substitute
    catalogs. A mismatched source identity is fatal. No files are written here.
    """
    source_check(source)
    source=dict(source)
    exporters=CATALOGS if exporters is None else exporters
    if set(exporters)!=set(CATALOGS):
        raise ValueError('Exactly the five renderer catalog exporters are required')
    table_cache, table_reads, probes, probe_cache={}, {}, {}, {}
    outputs, results={}, {}
    active=None
    definitions={p.stem.lower():p for p in DEFINITIONS.glob('*.dbd')}

    def table_read(resource):
        name=assets.resource(resource)
        if not re.fullmatch(r'dbfilesclient/[a-z0-9_]+\.db2',name):
            raise ValueError('Catalog full reads are restricted to DB2 source tables')
        row=table_reads.setdefault(name,{'calls':0,'catalogs':[]})
        row['calls']+=1
        if active not in row['catalogs']:row['catalogs'].append(active)
        if name not in table_cache:
            try:
                raw=read(name)
                if not isinstance(raw,(bytes,bytearray,memoryview)):
                    raise TypeError('Table callback must return actual bytes')
                raw=bytes(raw);table_cache[name]=raw
                row.update(status='read',bytes=len(raw),sha256=digest(raw))
                if raw[:4]==b'WDC5' and len(raw)>=160:
                    row['headerLayout']=f'{struct.unpack_from("<I",raw,156)[0]:08x}'
                definition=definitions.get(Path(name).stem)
                if definition:
                    row.update(table=definition.stem,definitionPath=str(definition.relative_to(ROOT)),
                        definitionSha256=digest(definition.read_bytes()))
            except Exception as error:
                table_cache[name]=error
                row.update(status='unavailable',error=type(error).__name__,reason=str(error))
        value=table_cache[name]
        if isinstance(value,Exception):raise value
        return value

    def header_read(resource,offset,size):
        name=assets.resource(resource)
        if not name.startswith('id:') or offset!=0 or size!=12:
            raise ValueError('Spell format probes require one 12-byte file-ID prefix')
        row=probes.setdefault(name,{'offset':0,'requestedBytes':12,'returnedBytes':0,'calls':0})
        row['calls']+=1
        if name not in probe_cache:
            try:
                raw=read_header(name,0,12)
                if not isinstance(raw,(bytes,bytearray,memoryview)):
                    raise TypeError('Header callback must return actual bytes')
                raw=bytes(raw)
                row.update(returnedBytes=len(raw),sha256=digest(raw))
                if len(raw)!=12:raise ValueError('Incomplete model format prefix')
                probe_cache[name]=raw;row['status']='read'
            except Exception as error:
                probe_cache[name]=error
                if hasattr(error,'returned_bytes'):row['returnedBytes']=error.returned_bytes
                row.update(status='unavailable',error=type(error).__name__,reason=str(error))
        value=probe_cache[name]
        if isinstance(value,Exception):raise value
        return value

    for active,exporter in exporters.items():
        try:
            catalog=(exporter(table_read,dict(source),read_header=header_read) if active=='spells'
                     else exporter(table_read,dict(source)))
        except Exception as error:
            results[active]={'status':'failed','error':type(error).__name__,'reason':str(error)}
            continue
        if catalog.get('source')!=source:
            raise ValueError(f'{active} catalog source identity disagrees with the snapshot')
        try:
            payload=json_bytes(catalog)
        except (TypeError,ValueError) as error:
            results[active]={'status':'failed','error':type(error).__name__,'reason':str(error)}
            continue
        outputs[active]=catalog
        results[active]={'status':'exported','file':active+'.json','bytes':len(payload),
            'sha256':digest(payload),'layouts':catalog.get('layouts',{}),
            'collections':{k:len(v) for k,v in catalog.items()
                           if isinstance(v,(dict,list)) and k not in ('source','layouts')}}
    manifest={'schema':1,'source':source,
        'status':'complete' if len(outputs)==5 else 'partial',
        'statusMeaning':'All five exporters returned identified JSON; source/probe availability is recorded separately.',
        'catalogs':results,'sourceTableReads':table_reads,'spellFormatProbes':probes,
        'totals':{'uniqueSourceTables':len(table_reads),
            'sourceTableBytes':sum(r.get('bytes',0) for r in table_reads.values()),
            'uniqueSpellFormatProbes':len(probes),'requestedPrefixBytes':12*len(probes),
            'returnedPrefixBytes':sum(r.get('returnedBytes',0) for r in probes.values())},
        'definitionsSource':'https://github.com/wowdev/WoWDBDefs/tree/12ce70d5fef13370f0edf08889f01c05321d2e28',
        'toolSha256':digest(Path(__file__).read_bytes()),
        'proof':'Production catalog snapshots and source/probe provenance only. No model/texture/table bytes are written. Rendering, runtime lifecycle and visual approval are separate.'}
    return {'catalogs':outputs,'manifest':manifest}


def output_path(path,root=ROOT):
    path=Path(path).resolve()
    if not path.is_relative_to((root/'.agent/work').resolve()):
        raise ValueError('Catalog output must be an ignored .agent/work directory')
    if path.exists():raise FileExistsError('Catalog output must be a fresh directory')
    return path


def write_snapshot(snapshot,output,*,root=ROOT):
    output=output_path(output,root)
    payloads={}
    for name,catalog in snapshot['catalogs'].items():
        if name not in CATALOGS:raise ValueError('Unknown renderer catalog artifact')
        payload=json_bytes(catalog)
        if digest(payload)!=snapshot['manifest']['catalogs'][name]['sha256']:
            raise ValueError('Catalog changed after its snapshot hash was recorded')
        payloads[name]=payload
    output.mkdir(parents=True,exist_ok=False)
    for name,payload in payloads.items():(output/(name+'.json')).write_bytes(payload)
    (output/'manifest.json').write_bytes(json_bytes(snapshot['manifest']))


def prefix_reader(storage):
    """Use the same strict offline CascLib storage, without full model reads."""
    def read_header(resource,offset,size):
        resource=assets.resource(resource)
        if not resource.startswith('id:') or offset!=0 or size!=12:
            raise ValueError('Only 12-byte file-ID prefixes are allowed')
        handle=ct.c_void_p()
        if not storage.lib.CascOpenFile(storage.handle,ct.c_void_p(int(resource[3:])),2,0x13,ct.byref(handle)):
            raise assets.AssetError(f'Header unavailable locally: {resource}')
        try:
            data=ct.create_string_buffer(12);count=ct.c_uint32()
            if not storage.lib.CascReadFile(handle,data,12,ct.byref(count)) or count.value!=12:
                error=assets.AssetError(f'Incomplete, encrypted or corrupt local header: {resource}')
                error.returned_bytes=count.value
                raise error
            return data.raw[:12]
        finally:storage.lib.CascCloseFile(handle)
    return read_header


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install',type=Path,required=True)
    parser.add_argument('--library',type=Path,default=assets.DEFAULT_LIBRARY)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(argv)
    output=output_path(args.output)
    source=assets.client_build(args.install)
    build_info=(args.install/'.build.info').read_bytes()
    with assets.CascStorage(args.install,args.library) as storage:
        snapshot=snapshot_catalogs(storage.read,source,prefix_reader(storage))
    if assets.client_build(args.install)!=source or (args.install/'.build.info').read_bytes()!=build_info:
        raise ValueError('Client build identity changed during catalog extraction')
    snapshot['manifest']['buildInfoSha256']=digest(build_info)
    write_snapshot(snapshot,output)
    print(json.dumps({'output':str(output),'source':source,
        'status':snapshot['manifest']['status'],'totals':snapshot['manifest']['totals']},indent=2))
    return 0 if snapshot['manifest']['status']=='complete' else 1


if __name__=='__main__':
    raise SystemExit(main())
