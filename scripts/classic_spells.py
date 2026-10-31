"""Modern client spell graph. Schema and enums are reused from pinned WoWDBDefs.

Reads installed DB2s without modifying them. Output preserves event/attachment
metadata, including unsupported primitives, rather than pretending it is 1.12 DBC.
"""
from pathlib import Path
import hashlib
import math
import re
from classic_db2 import decode, DB2Error, f32
from classic_spell_presentations import SUMMON_CUES

DEFINITIONS = Path(__file__).resolve().parent.parent / 'third_party/wowdbdefs'
TABLES = ['SpellXSpellVisual', 'SpellVisual', 'SpellVisualEvent', 'SpellVisualKit',
          'SpellVisualKitEffect', 'SpellVisualKitModelAttach', 'SpellVisualEffectName',
          'SpellVisualAnim', 'SpellVisualMissile', 'SpellMisc', 'SpellCastTimes', 'SpellDuration', 'AnimationData', 'SpellName',
          'SpellProceduralEffect', 'SpellChainEffects']


def schema(name, layout):
    text = (DEFINITIONS / (name + '.dbd')).read_text()
    for block in text.split('\n\n'):
        lines = block.splitlines()
        if not lines or not lines[0].startswith('LAYOUT ') or layout.upper() not in lines[0][7:].split(', '):
            continue
        fields, parent, types = [], None, {}
        for line in lines[1:]:
            if not line or line.startswith(('BUILD ', 'COMMENT ')):
                continue
            if '$noninline' in line:
                if 'relation' in line:
                    parent = re.sub(r'\$[^$]+\$', '', line).split('<')[0]
                continue
            name = re.sub(r'\$[^$]+\$', '', line).split('<')[0].split('[')[0]
            fields.append(name)
            width = re.search(r'<(u?)(\d+)>', line)
            if width:
                types[name] = (int(width[2]), not width[1])
        return fields, parent, types
    raise DB2Error(f'Unsupported {name} layout {layout}. Update the pinned definitions explicitly.')


def read_tables(read, names=None):
    tables, layouts = {}, {}
    for name in TABLES if names is None else names:
        if name == 'SpellName':
            # Import after this module initializes: the shared string decoder uses schema().
            from classic_table_strings import named_table
            tables[name], layouts[name] = named_table(read('dbfilesclient/spellname.db2'), name)
            continue
        layout, rows = decode(read('dbfilesclient/' + name.lower() + '.db2'), relationships=True)
        fields, parent, types = schema(name, layout)
        named = {}
        for key, values in rows.items():
            if len(values) != len(fields) + 1:
                raise DB2Error(f'{name} field count disagrees with pinned schema.')
            row = dict(zip(fields, values[:-1]))
            # Uncompressed WDC storage can include padding or neighboring bits.
            # The pinned schema owns signedness and the actual scalar width.
            for field, (bits, signed) in types.items():
                def scalar(v):
                    v &= (1 << bits) - 1
                    return v - (1 << bits) if signed and v & (1 << (bits - 1)) else v
                value = row[field]
                row[field] = [scalar(v) for v in value] if isinstance(value, list) else scalar(value)
            if parent:
                row[parent] = values[-1]
            row['ID'] = key
            named[key] = row
        tables[name], layouts[name] = named, layout
    return tables, layouts


def enum(name):
    return {int(line.split()[0]): ' '.join(line.split()[1:]).split(' //')[0]
            for line in (DEFINITIONS / (name + '.dbde')).read_text().splitlines() if line.strip()}


def particle_colors(read):
    """ParticleColor palettes: slot 11/12/13 × start/mid/end × RGB.

    The three DB2 fields each contain three slots, not three time keys. Alpha
    bytes are intentionally excluded; model alpha and key times remain authored.
    WhiteoutFlakes particle_color_table.cpp, BSD-3-Clause (third_party notice).
    """
    tables, _ = read_tables(read, ['ParticleColor'])
    def rgb(value):
        return [((value >> shift) & 255) / 255 for shift in (16, 8, 0)]
    return {key: [[rgb(row[field][slot]) for field in ('Start', 'MID', 'End')]
                  for slot in range(3)] for key, row in tables['ParticleColor'].items()}


def authored_extra(row, mapped):
    """Retain nondefault fields outside the normalized renderer subset.

    Sparse metadata avoids duplicating every normalized/default value in the
    browser graph. Zero and -1 are absent/default references in these tables.
    """
    def present(value):
        return any(present(v) for v in value) if isinstance(value, list) else value not in (0, -1)
    return {key:value for key,value in row.items()
            if key not in mapped and key != 'ID' and present(value)}


REFERENCE_TABLES = frozenset({'Curve','CurvePoint','Positioner','PositionerState',
    'PositionerStateEntry','TransformMatrix','SpellMissileMotion','AnimKit',
    'AnimKitSegment','AnimKitConfig','AnimKitConfigBoneSet','AnimKitBoneSet',
    'AnimKitBoneSetAlias','AnimKitPriority','AnimationData'})
REFERENCE_CHILDREN = {'Curve':[('CurvePoint','CurveID')],
    'AnimKit':[('AnimKitSegment','ParentAnimKitID')],
    'AnimKitConfig':[('AnimKitConfigBoneSet','ParentAnimKitConfigID')],
    'AnimKitBoneSet':[('AnimKitBoneSetAlias','AnimKitBoneSetID')]}


def reference_columns(name):
    """Only declared foreign keys plus the two named missile positioners.

    Param/SrcVal/DstVal fields are context dependent; an ID-shaped integer is
    not automatically a foreign key. DBD float types preserve raw bit evidence.
    """
    text=(DEFINITIONS/(name+'.dbd')).read_text()
    links, floats={},set()
    for line in text.split('\n\n')[0].splitlines():
        match=re.match(r'int<([A-Za-z0-9_]+)::ID>\s+(\w+)',line)
        if match and match[1] in REFERENCE_TABLES:
            links[match[2]]=match[1]
        match=re.match(r'float\s+(\w+)',line)
        if match:floats.add(match[1])
    if name=='SpellVisualMissile':
        links.update(CastPositionerID='Positioner',ImpactPositionerID='Positioner')
    return links,sorted(floats)


def reference_definitions(read, roots):
    """Sparse declared-reference closure, not runtime interpretation.

    Decode each needed table once, export only reachable records and child
    entries, retain exact layout/source/definition hashes and unresolved edges.
    Unavailable/undecodable tables remain explicit, without blocking ordinary
    spell rendering or substituting records. Strings such as motion scripts
    are inert local metadata and are never evaluated.
    """
    from classic_table_strings import named_table
    from collections import deque
    loaded, output, references, missing, seeds = {}, {}, [], [], []
    reverse, pending, visited, columns={},deque(),set(),{}

    def column_spec(name):
        if name not in columns:columns[name]=reference_columns(name)
        return columns[name]

    def load(name):
        if name in loaded:return loaded[name]
        entry={'rows':{},'definitionSha256':hashlib.sha256(
            (DEFINITIONS/(name+'.dbd')).read_bytes()).hexdigest()}
        output[name]=entry
        try:
            raw=read('dbfilesclient/'+name.lower()+'.db2')
            entry.update(sourceSha256=hashlib.sha256(raw).hexdigest(),sourceBytes=len(raw))
            rows,layout=named_table(raw,name)
            entry.update(layout=layout,availableRecords=len(rows),status='decoded')
        except Exception as error:
            # Diagnostic metadata must not make an otherwise renderable spell
            # disappear. Preserve the failure class and never invent rows.
            rows={};entry.update(status='unavailable',error=type(error).__name__,reason=str(error))
        loaded[name]=rows
        return rows

    def add(owner,field,target,value,root=False):
        for index,ident in enumerate(value if isinstance(value,list) else [value]):
            # AnimationData 0 is the valid Stand animation. Other families use
            # zero as no-reference, and negative animation IDs are sentinels.
            if not isinstance(ident,int) or ident < (0 if target=='AnimationData' else 1):continue
            edge={'owner':owner,'field':field,'table':target,'id':ident}
            if isinstance(value,list):edge['index']=index
            (seeds if root else references).append(edge)
            pending.append((target,ident,edge))

    for name,rows in roots.items():
        if not name.startswith('Spell'):continue
        links,_=column_spec(name)
        for ident,row in rows.items():
            for field,target in links.items():
                if field in row:add(f'{name}:{ident}',field,target,row[field],True)
    while pending:
        name,ident,edge=pending.popleft()
        rows=load(name)
        if ident not in rows:
            missing.append(dict(edge,reason='record-absent' if output[name]['status']=='decoded' else 'table-unavailable'))
            continue
        if (name,ident) in visited:continue
        visited.add((name,ident));row=rows[ident]
        links,floats=column_spec(name)
        normalized=dict(row);bits={}
        for field in floats:
            if field not in row:continue
            def finite(value):
                result=f32(value)
                return result if math.isfinite(result) else None
            value=row[field];bits[field]=value
            normalized[field]=[finite(v) for v in value] if isinstance(value,list) else finite(value)
        if bits:normalized['floatBits']=bits
        output[name]['rows'][ident]=normalized
        for field,target in links.items():
            if field in row:add(f'{name}:{ident}',field,target,row[field])
        for child,field in REFERENCE_CHILDREN.get(name,[]):
            key=(child,field)
            if key not in reverse:
                index={}
                for child_id,child_row in load(child).items():
                    index.setdefault(child_row.get(field),[]).append(child_id)
                reverse[key]=index
            for child_id in reverse[key].get(ident,[]):
                add(f'{name}:{ident}','children:'+child+'.'+field,child,child_id)
            if output[child]['status']!='decoded':
                missing.append({'owner':f'{name}:{ident}','field':'children:'+child+'.'+field,
                    'table':child,'reason':'table-unavailable'})
    return {'schema':1,'tables':output,'roots':seeds,'references':references,'missingReferences':missing,
        'scope':{'families':sorted(REFERENCE_TABLES),'reverseChildren':REFERENCE_CHILDREN,
            'definitionsSource':'https://github.com/wowdev/WoWDBDefs/tree/12ce70d5fef13370f0edf08889f01c05321d2e28',
            'unresolvedSemantics':['Positioner source/destination type/value and state timing',
                'AnimKit conditions/configuration and context-selected replacement sets',
                'SpellMissileMotion script runtime/client API','Curve type/flags and caller input units'],
            'proof':'Declared reachable metadata closure only; no runtime behavior or GPU acceptance.'}}


def chain_effect(row):
    """Export the authored simple-chain subset the retained renderer implements.

    Flag4 selects the original lightning ribbon. Joint, wave, arc, pulse, color,
    multi-texture and width-curve variants retain their data and remain explicit.
    """
    advanced = ['JointCount', 'JointOffsetRadius', 'JointsPerMinorJoint',
        'MinorJointsPerMajorJoint', 'MinorJointScale', 'MajorJointScale',
        'JointMoveSpeed', 'JointSmoothness', 'MinDurationBetweenJointJumps',
        'MaxDurationBetweenJointJumps', 'WaveHeight', 'WaveFreq', 'WaveSpeed',
        'MinWaveAngle', 'MaxWaveAngle', 'MinWaveSpin', 'MaxWaveSpin', 'ArcHeight',
        'MinArcAngle', 'MaxArcAngle', 'MinArcSpin', 'MaxArcSpin', 'DelayBetweenEffects',
        'MinFlickerOnDuration', 'MaxFlickerOnDuration', 'MinFlickerOffDuration',
        'MaxFlickerOffDuration', 'PulseSpeed', 'PulseOnLength', 'PulseFadeLength',
        'WidthScaleCurveID', 'NumFlipFramesU', 'NumFlipFramesV',
        'TextureParticleFileDataID', 'RenderLayer']
    compatible = (row['Flags'] == 4
        and not any(row.get(key, 0) for key in advanced)
        and not any(row.get('SpellChainEffectID', []))
        and row['StartWidth'] == row['EndWidth']
        and all(row[key] == 255 for key in ['Alpha', 'Red', 'Green', 'Blue'])
        and row['BlendMode'] == 3
        and row['TextureFileDataID'][0] > 0
        and not any(row['TextureFileDataID'][1:])
        and row['TextureCoordScaleU'] == [0x3f800000] * 3
        and not any(row['TextureCoordScaleV'] + row['TextureRepeatLengthU'] + row['TextureRepeatLengthV']))
    return {'avgSegLen': f32(row['AvgSegLen']), 'halfWidth': f32(row['StartWidth']),
        'noiseScale': f32(row['NoiseScale']), 'scrollPeriod': f32(row['TexCoordScale']),
        'boltLifeMs': row['SegDuration'], 'boltStaggerMs': row['SegDelay'],
        'textureFileDataIDs': row['TextureFileDataID'], 'rendererCompatible': compatible,
        'authored': row}


def chain_procedure_id(proc):
    """Resolve only the finite integral chain parameters consumed by the renderer.

    Value is float[4] in the pinned schema; classic_db2 deliberately returns its
    raw words. Other procedure types may use fractional or negative values.
    """
    values = proc.get('values', [])
    if proc.get('type') not in (0, 12) or len(values) != 4:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
               and math.isfinite(v) for v in values):
        return None
    if not all(0 <= v <= 0xffffffff and int(v) == v for v in values[:3]):
        return None
    return int(values[0]) or None


def procedure(row):
    values = [f32(v) for v in row['Value']]
    result = {'type': row['Type'], 'values': values}
    if not all(math.isfinite(v) for v in values):
        # JSON has no NaN/Infinity. Keep the exact authored bits for diagnosis,
        # while preventing an invalid procedure from entering native dispatch.
        result.update(values=[v if math.isfinite(v) else None for v in values],
                      rawValueBits=row['Value'], rendererCompatible=False)
    elif row['Type'] in (0, 12) and chain_procedure_id(result) is None:
        result['rendererCompatible'] = False
    return result


def trail_procedure_compatible(proc):
    values = proc.get('values', [])
    return (proc.get('type') == 8 and len(values) == 4
        and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v) for v in values)
        and all(0 <= values[i] <= limit and int(values[i]) == values[i]
                for i, limit in [(0, 0xffffff), (2, 0x7fffffff), (3, 255)]))


def model_asset_format(header):
    """Identify a model family from a bounded strict archive header read."""
    if len(header) != 12:
        return 'unknown'
    if header[:4] == b'MD21' and header[8:12] == b'MD20':
        return 'm2'
    if header[:4] == b'MD20':
        return 'm2'
    if (header[:4] == b'REVM' and int.from_bytes(header[4:8], 'little') == 4
            and int.from_bytes(header[8:12], 'little') == 17):
        return 'wmo'
    return 'unknown'


def spell_catalog(read, source, read_header=None):
    tables, layouts = read_tables(read)
    kinds, targets, effect_types = enum('SpellVisualEventEvent'), enum('SpellVisualEventTargetType'), enum('SpellVisualKitEffectType')
    effects, formats = {}, {}
    for key, row in tables['SpellVisualEffectName'].items():
        effects[key] = {'fileDataID': row['ModelFileDataID'], 'type': row['Type'],
                        'scale': f32(row['Scale']), 'alpha': f32(row['Alpha']),
                        'speed': f32(row['BaseMissileSpeed']), 'authored': authored_extra(row,
                            {'ModelFileDataID','Type','Scale','Alpha','BaseMissileSpeed'})}
        file_id = row['ModelFileDataID']
        if read_header is not None and file_id > 0:
            if file_id not in formats:
                try:
                    value = read_header(f'id:{file_id}', 0, 12)
                    if value is False:
                        raise DB2Error('Archive header unavailable without its section key')
                    header = bytes(value)
                    formats[file_id] = {'assetFormat': model_asset_format(header),
                        'assetFormatEvidence': {'probeBytes': len(header),
                            'headerSha256': hashlib.sha256(header).hexdigest()}}
                except Exception as error:
                    # Unavailable/opaque source remains explicit. Never fall
                    # back to reading a complete model during catalog startup.
                    formats[file_id] = {'assetFormat': 'unknown',
                        'assetFormatEvidence': {'probeBytes': 0, 'unavailable': type(error).__name__}}
            effects[key].update(formats[file_id])
    chains = {key: chain_effect(row) for key, row in tables['SpellChainEffects'].items()}
    procedures = {key: procedure(row)
                  for key, row in tables['SpellProceduralEffect'].items()}
    kits = {key: {'effects': [], 'animations': [], 'proceduralEffects': [], 'unsupported': [], 'authored': authored_extra(row,set())}
            for key, row in tables['SpellVisualKit'].items()}
    for key, row in tables['SpellVisualKitEffect'].items():
        kit = kits.get(row['ParentSpellVisualKitID'])
        if kit is None:
            continue
        kind, ref = effect_types.get(row['EffectType'], 'Unknown'), row['Effect']
        if kind == 'SpellVisualKitModelAttachID' and ref in tables['SpellVisualKitModelAttach']:
            a = tables['SpellVisualKitModelAttach'][ref]
            kit['effects'].append({'id': ref, 'effect': a['SpellVisualEffectNameID'],
                'attachment': a['AttachmentID'], 'offset': [f32(v) for v in a['Offset']],
                'rotation': [f32(a[n]) for n in ['Yaw', 'Pitch', 'Roll']],
                'scale': f32(a['Scale']) * effects.get(a['SpellVisualEffectNameID'],{}).get('scale',1), 'delay': f32(a['StartDelay']),
                'positioner': a['PositionerID'], 'flags': a['Flags'], 'authored': authored_extra(a,
                    {'SpellVisualEffectNameID','AttachmentID','PositionerID','Offset','Yaw','Pitch','Roll',
                     'Scale','StartDelay','Flags','ParentSpellVisualKitID'}),
                'animation': {phase: a.get(field) if a.get(field, -1) >= 0 else None
                    for phase, field in [('start','StartAnimID'),('loop','AnimID'),('end','EndAnimID')]}})
        elif kind == 'SpellVisualAnimID' and ref in tables['SpellVisualAnim']:
            kit['animations'].append(tables['SpellVisualAnim'][ref])
        elif kind == 'SpellProceduralEffectID' and ref in procedures:
            proc = procedures[ref]
            kit['proceduralEffects'].append(dict(proc, id=ref))
            chain_id = chain_procedure_id(proc)
            if not (trail_procedure_compatible(proc) or
                    chain_id is not None and chains.get(chain_id, {}).get('rendererCompatible')):
                kit['unsupported'].append({'type': kind, 'id': ref})
        else:
            kit['unsupported'].append({'type': kind, 'id': ref})
    visuals = {key: {'events': [], 'missiles': [], 'hasMissile': bool(row['HasMissile']),
                     'missileSet': row['SpellVisualMissileSetID'], 'authored': authored_extra(row,
                        {'HasMissile','SpellVisualMissileSetID'})} for key, row in tables['SpellVisual'].items()}
    for row in tables['SpellVisualEvent'].values():
        visual = visuals.get(row['SpellVisualID'])
        if visual is not None:
            visual['events'].append({'start': kinds.get(row['StartEvent'], str(row['StartEvent'])),
                'end': kinds.get(row['EndEvent'], str(row['EndEvent'])),
                'target': targets.get(row['TargetType'], str(row['TargetType'])),
                'kit': row['SpellVisualKitID'], 'delay': row['StartMinOffsetMs'],
                'maxDelay': row['StartMaxOffsetMs'], 'authored': authored_extra(row,
                    {'StartEvent','EndEvent','TargetType','SpellVisualKitID','SpellVisualID','StartMinOffsetMs','StartMaxOffsetMs'})})
    for missile_id,row in tables['SpellVisualMissile'].items():
        for v in visuals.values():
            if row['SpellVisualMissileSetID'] == v['missileSet'] and v['missileSet']:
                v['missiles'].append({'id':missile_id,'effect': row['SpellVisualEffectNameID'],
                    'attachment': row['Attachment'], 'destination': row['DestinationAttachment'],
                    'positioner': row['CastPositionerID'], 'motion': row['SpellMissileMotionID'], 'authored': authored_extra(row,
                        {'SpellVisualEffectNameID','Attachment','DestinationAttachment','CastPositionerID',
                         'SpellMissileMotionID','SpellVisualMissileSetID'})})
    spells = {}
    for key, row in tables['SpellName'].items():
        spells[key] = {'name': row['Name_lang'], 'visuals': []}
    for row in tables['SpellXSpellVisual'].values():
        spells.setdefault(row['SpellID'], {'visuals': []})['visuals'].append({
            'id': row['SpellVisualID'], 'priority': row['Priority'], 'difficulty': row['DifficultyID'],
            'conditions': [row[n] for n in ['ViewerUnitConditionID', 'ViewerPlayerConditionID', 'CasterUnitConditionID', 'CasterPlayerConditionID']]})
    for row in tables['SpellMisc'].values():
        if row['DifficultyID']:
            continue
        spell = spells.setdefault(row['SpellID'], {'visuals': []})
        ct = tables['SpellCastTimes'].get(row['CastingTimeIndex'], {})
        duration = tables['SpellDuration'].get(row['DurationIndex'], {})
        spell.update({'attributes': [v & 0xffffffff for v in row['Attributes'][:5]], 'iconFile': row['SpellIconFileDataID'], 'schoolMask': row['SchoolMask'], 'speed': f32(row['Speed']),
            'castMs': ct.get('Base', 0), 'durationMs': duration.get('Duration', 0),
            'channel': bool(row['Attributes'][1] & (4 | 64))})
    for spell_id, cue in SUMMON_CUES.items():
        if spell_id in spells:
            spells[spell_id]['summonCue'] = dict(cue)
    return {'schema': 1, 'source': source, 'layouts': layouts, 'spells': spells,
            'visuals': visuals, 'kits': kits, 'effects': effects,
            'chainEffects': chains,
            'referenceDefinitions': reference_definitions(read,tables),
            'animationFallbacks': {key: row['Fallback'] for key,row in tables['AnimationData'].items()}}
