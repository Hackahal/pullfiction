"""Modern client spell graph. Schema and enums are reused from pinned WoWDBDefs.

Reads installed DB2s without modifying them. Output preserves event/attachment
metadata, including unsupported primitives, rather than pretending it is 1.12 DBC.
"""
from pathlib import Path
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


def spell_catalog(read, source):
    tables, layouts = read_tables(read)
    kinds, targets, effect_types = enum('SpellVisualEventEvent'), enum('SpellVisualEventTargetType'), enum('SpellVisualKitEffectType')
    effects = {}
    for key, row in tables['SpellVisualEffectName'].items():
        effects[key] = {'fileDataID': row['ModelFileDataID'], 'type': row['Type'],
                        'scale': f32(row['Scale']), 'alpha': f32(row['Alpha']),
                        'speed': f32(row['BaseMissileSpeed'])}
    chains = {key: chain_effect(row) for key, row in tables['SpellChainEffects'].items()}
    procedures = {key: {'type': row['Type'], 'values': [f32(v) for v in row['Value']]}
                  for key, row in tables['SpellProceduralEffect'].items()}
    kits = {key: {'effects': [], 'animations': [], 'proceduralEffects': [], 'unsupported': []}
            for key in tables['SpellVisualKit']}
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
                'positioner': a['PositionerID'], 'flags': a['Flags']})
        elif kind == 'SpellVisualAnimID' and ref in tables['SpellVisualAnim']:
            kit['animations'].append(tables['SpellVisualAnim'][ref])
        elif kind == 'SpellProceduralEffectID' and ref in procedures:
            proc = procedures[ref]
            kit['proceduralEffects'].append(dict(proc, id=ref))
            chain_id = int(proc['values'][0])
            if proc['type'] not in (0, 12) or not chains.get(chain_id, {}).get('rendererCompatible'):
                kit['unsupported'].append({'type': kind, 'id': ref})
        else:
            kit['unsupported'].append({'type': kind, 'id': ref})
    visuals = {key: {'events': [], 'missiles': [], 'hasMissile': bool(row['HasMissile']),
                     'missileSet': row['SpellVisualMissileSetID']} for key, row in tables['SpellVisual'].items()}
    for row in tables['SpellVisualEvent'].values():
        visual = visuals.get(row['SpellVisualID'])
        if visual is not None:
            visual['events'].append({'start': kinds.get(row['StartEvent'], str(row['StartEvent'])),
                'end': kinds.get(row['EndEvent'], str(row['EndEvent'])),
                'target': targets.get(row['TargetType'], str(row['TargetType'])),
                'kit': row['SpellVisualKitID'], 'delay': row['StartMinOffsetMs'],
                'maxDelay': row['StartMaxOffsetMs']})
    for row in tables['SpellVisualMissile'].values():
        for v in visuals.values():
            if row['SpellVisualMissileSetID'] == v['missileSet'] and v['missileSet']:
                v['missiles'].append({'effect': row['SpellVisualEffectNameID'],
                    'attachment': row['Attachment'], 'destination': row['DestinationAttachment'],
                    'positioner': row['CastPositionerID'], 'motion': row['SpellMissileMotionID']})
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
            'animationFallbacks': {key: row['Fallback'] for key,row in tables['AnimationData'].items()}}
