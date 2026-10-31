#!/usr/bin/env python3
"""Inventory every retained spell route and required effect mode without visual claims.

The graph is the production classic_spells export. Optional offline M2 inspection
adds particle requirements; the existing renderer-model-audit JSONL supplies
conversion evidence. Implementation classifications are explicit and conservative:
an adapted asset or mapped ID never earns GPU/lifecycle/visual acceptance.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
import math
from pathlib import Path

from classic_compat import read, table
from classic_spells import chain_procedure_id, trail_procedure_compatible
from classic_db2 import f32

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('classic_assets', ROOT / 'scripts/classic-assets.py')
assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assets)

# These are the production modern resolver's actual stage/owner choices. Area,
# caster-impact and end-event paths require additional routing context.
MAPPED_EVENTS = {('Precast Start', 'Caster'), ('Cast', 'Caster'),
                 ('Cast', 'Target'), ('Cast', 'Target (Not Caster)'),
                 ('Impact', 'Target'), ('Impact', 'Target (Not Caster)'),
                 ('Aura Start', 'Target'), ('Aura Start', 'Target (Not Caster)'),
                 ('Channel Start', 'Caster'), ('Channel Start', 'Target'),
                 ('Channel Start', 'Target (Not Caster)')}
PARTICLE_MAPPED_BITS = {0, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15,
                        17, 18, 19, 23, 28, 29, 30}
NATIVE = 'crates/benilla-formats/src/spell_visual/modern.rs'
PARTICLES = 'crates/benilla-world/src/particles'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def capability_tests(key):
    if key=='reference:missing-effect':
        return ['python3 scripts/renderer-spell-audit-test.py AuditTest.test_missing_missile_effect_is_an_unresolved_requirement_for_its_spell']
    if key.startswith('effect:asset-format:'):
        return ['python3 scripts/classic-spells-test.py',
                'modern_effect_paths_use_probed_formats_and_do_not_guess_unknown_headers']
    if key=='attachment:animation-phases':
        return ['python3 scripts/classic-spells-test.py',
                'modern_attachment_animation_override_keeps_explicit_stand_zero',
                'authored_attachment_phases_reuse_hold_decay_backend_and_preserve_zero_id']
    if key=='procedure:type:8':
        return ['python3 scripts/classic-spells-test.py',
            'modern_weapon_trails_preserve_all_slots_and_combined_event_kits',
            'modern_trails_reach_cast_and_channel_dispatch_without_rearming_each_frame']
    if key.startswith(('procedure:type:0','procedure:type:12','chain:')):
        return ['modern_procedural_chains_keep_full_ids_and_combined_stage_kits']
    if key=='particle:color-replacement':
        return ['python3 scripts/classic-compat-test.py',
            'display_particle_palette_preserves_authored_key_times_and_shared_curve',
            'recursive_children_inherit_instance_palette_without_changing_shared_defs',
            'display_particle_palettes_clone_definitions_without_mutating_shared_m2']
    if key.startswith('event:') and any(x in key for x in ('Impact','Cast:Target')):
        return ['modern_cast_target_uses_hits_and_contextual_impacts_wait_for_arrival',
            'modern_impact_owner_predicates_do_not_guess_missing_casters_or_duplicate_self_targets',
            'modern_common_impact_pairs_do_not_invent_a_second_caster_explosion',
            'missed_arrival_words_the_target_deflects_a_parry_and_plays_dodge_or_block']
    if key.startswith('particle:TXAC:') or key=='particle:recursionFileDataID':
        return ['python3 scripts/classic-compat-test.py']
    return []


def source_paths(source):
    result=[]
    for path in source.split(' + '):
        if path.startswith(('entities/','creature_anim/')):path='crates/benilla-app/src/'+path
        elif path.startswith('formats/'):path='crates/benilla-formats/src/'+path[8:]
        elif path.startswith(('particles/','shaders/')):path='crates/benilla-world/src/'+path
        if (ROOT/path).exists():result.append(path)
    return result


def requirement_kind(key):
    if key.startswith('mode:particleFlags:'):
        return 'classification'
    if key.startswith(('lifecycle:','target:')) and key!='lifecycle:flight':
        return 'classification'
    if key in ('catalog-primitive:SoundKitID','catalog-primitive:UnitSoundType'):
        return 'optional-audio'
    if key in ('effect:scale-bounds', 'particle:color-replacement'):
        return 'conditional'
    if key in ('event:Impact:Caster','event:Aura Start:Caster'):
        return 'conditional'
    if key.startswith(('authored:', 'attachment:flags:', 'particle:flag:')):
        # Presence of an unclassified metadata bit is not proof that it selects
        # an additional required operation for this render request.
        return 'unclassified-metadata'
    return 'required'


def audit(graph, model_records=(), particle_records=()):
    groups = {k: graph.get(k, {}) for k in ('spells', 'visuals', 'kits', 'effects', 'chainEffects')}
    # A global audit also contains name-only skyboxes. Spell effect roots are
    # numeric FDIDs; preserve global input provenance without inventing IDs.
    models = {r['fileDataID']:r for r in model_records if isinstance(r.get('fileDataID'),int)}
    particles = {int(r['fileDataID']): r for r in particle_records}
    ledger, spells, missing = {}, {}, []
    record_modes, record_families = defaultdict(dict), defaultdict(set)

    def mode(key, record, status, source, note='', tests=()):
        requirement=requirement_kind(key)
        entry = ledger.setdefault(key, {'required': requirement=='required',
            'requirement':requirement,'implementation': status,
            'mapped': status in ('implemented', 'partial'), 'automaticallyTested': False,
            'testEvidence': list(tests) or capability_tests(key), 'source': source, 'limitation': note,
            'records': set(), 'recordImplementations': {}, 'spellIds': set(), 'modelFileDataIDs': set()})
        entry['records'].add(record)
        entry['recordImplementations'][record] = status
        record_modes[record][key]=status
        if record.startswith(('visual:','model:')):
            record_families[':'.join(record.split(':')[:2])].add(record)
        statuses = set(entry['recordImplementations'].values())
        entry['implementation'] = next(iter(statuses)) if len(statuses) == 1 else 'partial'
        entry['mapped'] = any(s in ('implemented', 'partial') for s in statuses)
        return key

    def extra_modes(row, table_name, record):
        return {mode(f'authored:{table_name}:{field}', record, 'unknown', NATIVE,
            'Nondefault authored field is retained but its production behavior is not established.')
            for field in row.get('authored', {})
            if field not in ('MissileDestinationAttachment','AreaModel','MinAllowedScale','MaxAllowedScale')
            and not (table_name=='SpellVisualKitModelAttach' and row.get('animation')
                     and field in ('StartAnimID','AnimID','EndAnimID'))}

    visual_modes, kit_modes, effect_modes, model_modes = {}, {}, {}, {}
    for fid, row in particles.items():
        caps = set()
        if row.get('error'):
            caps.add(mode('particle:source-unavailable', f'model:{fid}', 'unknown', 'local CASC', row['error']))
        for emitter in row.get('emitters', []):
            record = f'model:{fid}:particle:{emitter["index"]}'
            flags = emitter['flags']
            multi = bool(flags & 0x10000000)
            caps.add(mode(f'mode:particleFlags:{flags}', record, 'partial', PARTICLES,
                'Individual flag bits are classified separately; an aggregate is not full support.'))
            for bit in range(32):
                if flags & (1 << bit):
                    caps.add(mode(f'particle:flag:0x{1 << bit:08x}', record,
                        'implemented' if bit in PARTICLE_MAPPED_BITS else 'unknown',
                        'scripts/classic_compat.py + ' + PARTICLES,
                        '' if bit in PARTICLE_MAPPED_BITS else 'No proven production mapping for this bit.'))
            shape = emitter['shape']
            caps.add(mode(f'particle:shape:{shape}', record,
                'implemented' if shape in (1, 2, 3) else 'unsupported', PARTICLES))
            caps.add(mode(f'particle:blend:{emitter["blend"]}', record,
                'implemented' if emitter['blend'] in range(8) else 'unknown',
                'crates/benilla-formats/src/particles.rs + particles/render.rs'))
            if multi:
                caps.add(mode('particle:multi-texture', record, 'implemented',
                    'scripts/classic_compat.py + particles/quads.rs + shaders/wow_effect.wgsl',
                    'TXAC, geometry and runtime texture restrictions remain separate.'))
                if emitter['txac']:
                    caps.add(mode(f'particle:TXAC:0x{emitter["txac"]:04x}', record, 'unsupported',
                        'scripts/classic_compat.py',
                        'Shader polar transform is observed; CPU TXAC byte-to-uniform assignment remains unproven.'))
            elif flags & 0x100000:
                caps.add(mode('particle:refraction', record, 'partial', PARTICLES,
                    'Current ordinary color pass is renderable approximation; no scene-color distortion pass.'))
            if emitter['colorIndex']:
                compatible=emitter['colorIndex'] in (11,12,13) and emitter['colorKeyCount']==3
                caps.add(mode('particle:color-replacement', record, 'partial' if compatible else 'unsupported',
                    'scripts/classic_compat.py + formats/particles.rs + entities/display.rs',
                    'Three-key slot RGB replacement and per-display binding implemented; runtime evidence and display palette availability remain separate.'))
            for name in ('geometryFileDataID', 'recursionFileDataID'):
                if emitter[name]:
                    caps.add(mode('particle:' + name, record, 'partial', PARTICLES,
                        'Native model/child emitter backend exists; reference preservation and preparation must also succeed.'))
        model_modes[fid] = caps
        for key in caps:
            ledger[key]['modelFileDataIDs'].add(fid)
    # Requirements propagate through actual GPID/RPID edges. A cycle adds no
    # new requirements after the finite model capability sets stabilize.
    model_children={fid:{p[field] for p in row.get('emitters', [])
                        for field in ('geometryFileDataID','recursionFileDataID') if p[field]}
                    for fid,row in particles.items()}
    for fid,row in particles.items():
        for emitter in row.get('emitters',[]):
            child_id=emitter.get('geometryFileDataID')
            child=particles.get(child_id,{})
            if not child_id or emitter.get('emitsPotentially') is False:
                continue
            for feature,required in [('emitters',bool(child.get('emitters'))),
                                     ('animation',bool(child.get('animatedBoneChannels'))),
                                     ('ribbons',bool(child.get('ribbonCount')))]:
                if required:
                    cap=mode('particle:geometry-model-'+feature,
                        f'model:{fid}:particle:{emitter["index"]}','unsupported',
                        'crates/benilla-world/src/particles/model.rs',
                        'GPID output currently instances static submeshes only. Full child-model actor clocks/bones/effects are distinct from the RPID shared trail-emitter backend.')
                    model_modes[fid].add(cap)
                    ledger[cap]['modelFileDataIDs'].update((fid,child_id))
    for _ in range(len(model_modes)):
        changed=False
        for fid, children in model_children.items():
            combined=model_modes.get(fid,set()) | set().union(*(model_modes.get(c,set()) for c in children))
            if combined!=model_modes.get(fid,set()):model_modes[fid]=combined;changed=True
        if not changed:break
    for key, row in groups['effects'].items():
        ty = row.get('type')
        caps = {mode(f'effect:type:{ty}', f'effect:{key}',
            'implemented' if ty == 0 else 'unsupported', NATIVE,
            '' if ty == 0 else 'Modern resolver only maps type0 to M2.')}
        if row.get('alpha', 1) != 1:
            caps.add(mode('effect:authored-alpha', f'effect:{key}', 'unsupported', NATIVE,
                'Exported alpha is not consumed by EffectPlacement.'))
        if row.get('assetFormat'):
            fmt=row['assetFormat']
            caps.add(mode(f'effect:asset-format:{fmt}',f'effect:{key}',
                'implemented' if fmt in ('m2','wmo') else 'unknown',NATIVE,
                'Header-derived model family; WMO subfeatures/lifecycle and native/GPU execution are separate checks.'))
        authored=row.get('authored',{})
        if 'MinAllowedScale' in authored or 'MaxAllowedScale' in authored:
            bounds=[f32(authored.get('MinAllowedScale',0)), f32(authored.get('MaxAllowedScale',0))]
            cap=mode('effect:scale-bounds',f'effect:{key}','unknown',NATIVE,
                'Conditional scaling bounds. Schema does not establish clamp input/order; nominal scale inside bounds does not require a clamp. Dynamic host/request scaling needs context.')
            ledger[cap].setdefault('contexts',{})[f'effect:{key}']={
                'nominalEffectScale':row.get('scale',1),'bounds':bounds,
                'nominalInsideBounds':bounds[0]<=row.get('scale',1)<=bounds[1]}
            caps.add(cap)
        effect_modes[key] = caps | model_modes.get(row.get('fileDataID'), set()) | extra_modes(row,'SpellVisualEffectName',f'effect:{key}')
    for key, row in groups['kits'].items():
        caps = extra_modes(row,'SpellVisualKit',f'kit:{key}')
        for attach in row.get('effects', []):
            caps |= extra_modes(attach,'SpellVisualKitModelAttach',f'attachment:{attach.get("id")}')
            eid = str(attach.get('effect'))
            if eid not in groups['effects']:
                missing.append({'owner': f'kit:{key}', 'dependency': f'effect:{eid}'})
            caps |= effect_modes.get(eid, set())
            caps.add(mode('attachment:world' if attach.get('attachment') == -1 else 'attachment:bone',
                f'attachment:{attach.get("id")}', 'implemented', NATIVE,
                'Missing bone uses existing attachment cascade; exact bone availability is model dependent.'))
            for field in ('positioner', 'flags'):
                if attach.get(field):
                    caps.add(mode(f'attachment:{field}:{attach[field]}', f'attachment:{attach.get("id")}',
                        'unknown', NATIVE, 'Authored field is exported but not consumed by placement.'))
            if attach.get('delay'):
                caps.add(mode('attachment:start-delay', f'attachment:{attach.get("id")}', 'implemented',
                    'creature_anim/spell_visual.rs + entities/spell_fx/mod.rs'))
            if any(value is not None for value in attach.get('animation',{}).values()):
                caps.add(mode('attachment:animation-phases',f'attachment:{attach.get("id")}',
                    'implemented','entities/spell_fx/lifecycle.rs + entities/spell_fx/mod.rs',
                    'Explicit start/loop/end IDs reuse the existing stage lifecycle; AnimKit controller graphs remain separate.'))
            if attach.get('authored',{}).get('AnimKitID'):
                caps.add(mode('attachment:anim-kit',f'attachment:{attach.get("id")}',
                    'unsupported',NATIVE,'The attachment requires an AnimKit graph; individual phase IDs do not implement it.'))
        for proc in row.get('proceduralEffects', []):
            chain_id=chain_procedure_id(proc)
            chain = groups['chainEffects'].get(str(chain_id), {})
            zero_beams=chain_id is not None and proc['values'][1]==0
            if chain_id is not None and str(chain_id) not in groups['chainEffects']:
                reference={'owner':f'procedure:{proc.get("id")}','dependency':f'chain:{chain_id}',
                           'renderContext':'zero-beams' if zero_beams else 'potential-draw'}
                if reference not in missing:missing.append(reference)
            supported = trail_procedure_compatible(proc) or zero_beams or chain.get('rendererCompatible') is True
            caps.add(mode(f'procedure:type:{proc.get("type")}', f'procedure:{proc.get("id")}',
                'implemented' if supported else 'unsupported', NATIVE,
                'Only exact simple-chain0/12 and validated weapon-trail8 subsets are mapped.'))
            if proc.get('type') in (0, 12):
                if zero_beams:
                    caps.add(mode('procedure:chain-zero-beams',f'procedure:{proc.get("id")}',
                        'implemented',NATIVE,'Authored zero beam count draws nothing; numeric chain reference is still audited.'))
                    continue
                compat = chain.get('rendererCompatible', False)
                caps.add(mode(f'chain:compatible:{compat}', f'chain:{chain_procedure_id(proc)}',
                    'implemented' if compat else 'unsupported', NATIVE,
                    '' if compat else 'Advanced authored chain joints/waves/arcs/color/texture modes remain unmapped.'))
        for primitive in row.get('unsupported', []):
            if primitive.get('type') == 'SpellProceduralEffectID':
                continue  # More precise procedure classification above.
            caps.add(mode('catalog-primitive:' + primitive.get('type', 'unknown'),
                f'primitive:{primitive.get("type")}:{primitive.get("id")}', 'unsupported', NATIVE))
        for anim in row.get('animations', []):
            initial,loop=anim.get('InitialAnimID',-1),anim.get('LoopAnimID',-1)
            single=not anim.get('AnimKitID') and ((initial<0<=loop) or (loop<0<=initial))
            caps.add(mode('host:animation', f'animation:{anim.get("ID")}', 'implemented' if single else 'partial', NATIVE,
                'Single authored animation ID uses existing host animation path. Multiple phases or AnimKitID remain separate unimplemented requirements.'))
        kit_modes[key] = caps
    for key, row in groups['visuals'].items():
        caps = extra_modes(row,'SpellVisual',f'visual:{key}')
        for i, event in enumerate(row.get('events', [])):
            kid = str(event.get('kit'))
            if event.get('kit') and kid not in groups['kits']:
                missing.append({'owner': f'visual:{key}', 'dependency': f'kit:{kid}'})
            caps |= kit_modes.get(kid, set())
            record = f'visual:{key}:event:{i}'
            caps |= extra_modes(event,'SpellVisualEvent',record)
            mapped = (event.get('start'), event.get('target')) in MAPPED_EVENTS
            unproved_caster=event.get('start')=='Impact' and event.get('target')=='Caster'
            expected_end={'Precast Start':'Precast End','Cast':'One-Shot','Impact':'One-Shot',
                          'Aura Start':'Aura End','Channel Start':'Channel End'}.get(event.get('start'))
            standard_timing=(not event.get('delay') and not event.get('maxDelay')
                             and event.get('end')==expected_end
                             and not any(event.get('authored',{}).get(f) for f in ('EndMinOffsetMs','EndMaxOffsetMs')))
            caps.add(mode('event:' + str(event.get('start')) + ':' + str(event.get('target')), record,
                'unknown' if unproved_caster else ('implemented' if standard_timing else 'partial') if mapped else 'unsupported', NATIVE,
                'Identical Caster/Target pairs exist on ordinary projectiles; extra caster dispatch is gated until target-context semantics are established.' if unproved_caster else
                ('Channel Caster wins over Target; event end/timing and caller context are separate requirements.'
                 if event.get('start')=='Channel Start' else
                 'Independent lifecycle/target predicate; event timing and actual source/target context are separate requirements.') if mapped else
                'No production lifecycle/owner routing for this event pair.'))
            caps.add(mode('lifecycle:' + str(event.get('start')), record, 'partial', NATIVE,
                'See exact event+target pair; lifecycle name alone is insufficient.'))
            caps.add(mode('target:' + str(event.get('target')), record, 'partial', NATIVE,
                'See exact lifecycle+target pair and available replay context.'))
            if event.get('delay') or event.get('maxDelay'):
                caps.add(mode('event:start-offset', record, 'unsupported', NATIVE,
                    'Event StartMinOffsetMs/StartMaxOffsetMs are exported but ignored.'))
            if event.get('end') not in ('One-Shot', 'Aura End', 'Channel End', 'Precast End'):
                caps.add(mode('event:end:' + str(event.get('end')), record, 'unknown', NATIVE,
                    'Modern end events are not independently dispatched.'))
        for i, missile in enumerate(row.get('missiles', [])):
            record = f'visual:{key}:missile:{i}'
            caps |= extra_modes(missile,'SpellVisualMissile',record)
            effect_id=missile.get('effect',0)
            eid=str(effect_id)
            if isinstance(effect_id,int) and effect_id>0 and eid not in groups['effects']:
                missing.append({'owner':f'visual:{key}','dependency':f'effect:{eid}'})
                caps.add(mode('reference:missing-effect',record,'unknown',NATIVE,
                    'A positive missile effect ID has no exported effect definition; flight routing alone cannot resolve its visual.'))
            caps |= effect_modes.get(eid, set())
            caps.add(mode('lifecycle:flight', record,
                'partial' if missile.get('motion') or missile.get('positioner') else 'implemented', 'entities/missile.rs',
                'Shared straight/homing travel/layers implemented; authored motion/source attachment/positioner separately classified.'))
            for field in ('motion', 'positioner'):
                if missile.get(field):
                    caps.add(mode(f'missile:{field}:{missile[field]}', record, 'unsupported', NATIVE,
                        'Authored modifier is exported but not consumed.'))
            if missile.get('attachment', -1) != -1:
                caps.add(mode('missile:source-attachment', record, 'unsupported', NATIVE,
                    'Authored source attachment is not consumed by modern routing.'))
        visual_modes[key] = caps
    for sid, row in groups['spells'].items():
        caps, v_ids, k_ids, e_ids, f_ids = set(), set(), set(), set(), set()
        for choice in row.get('visuals', []):
            vid = str(choice.get('id'))
            v_ids.add(vid)
            if choice.get('id') and vid not in groups['visuals']:
                missing.append({'owner': f'spell:{sid}', 'dependency': f'visual:{vid}'})
            visual = groups['visuals'].get(vid, {})
            caps |= visual_modes.get(vid, set())
            k_ids.update(str(e.get('kit')) for e in visual.get('events', []))
            e_ids.update(str(e.get('effect')) for e in visual.get('missiles', []))
            if choice.get('difficulty') or any(choice.get('conditions', [])):
                caps.add(mode('routing:conditional', f'spell:{sid}', 'unknown',
                    'crates/benilla-formats/src/spells/mod.rs', 'No replay condition evaluator.'))
        for kid in k_ids:
            e_ids.update(str(e.get('effect')) for e in groups['kits'].get(kid, {}).get('effects', []))
        f_ids.update(groups['effects'][e]['fileDataID'] for e in e_ids
                     if e in groups['effects'] and groups['effects'][e].get('fileDataID'))
        root_f_ids=set(f_ids);pending=list(f_ids)
        while pending:
            for child in model_children.get(pending.pop(),set())-f_ids:
                f_ids.add(child);pending.append(child)
        for cap in caps:
            ledger[cap]['spellIds'].add(int(sid))
        required={c for c in caps if ledger[c]['required']}
        records={f'spell:{sid}',*(f'kit:{kid}' for kid in k_ids),*(f'effect:{eid}' for eid in e_ids)}
        records.update(f'visual:{vid}' for vid in v_ids)
        for owner in [*(f'visual:{vid}' for vid in v_ids),*(f'model:{fid}' for fid in f_ids)]:
            records.update(record_families.get(owner,()))
        for kid in k_ids:
            kit=groups['kits'].get(kid,{})
            records.update(f'attachment:{a.get("id")}' for a in kit.get('effects',[]))
            records.update(f'animation:{a.get("ID")}' for a in kit.get('animations',[]))
            for proc in kit.get('proceduralEffects',[]):
                records.add(f'procedure:{proc.get("id")}')
                records.add(f'chain:{chain_procedure_id(proc)}')
            records.update(f'primitive:{p.get("type")}:{p.get("id")}' for p in kit.get('unsupported',[]))
        states_by_cap=defaultdict(set)
        for record in records:
            for cap,state in record_modes.get(record,{}).items():
                if cap in caps:states_by_cap[cap].add(state)
        support={}
        for cap in caps:
            states=states_by_cap[cap]
            support[cap]=next(iter(states)) if len(states)==1 else 'partial' if states else 'unknown'
        spells[sid] = {'name': row.get('name'), 'channel': row.get('channel', False),
            'visualIds': sorted(v_ids, key=int), 'kitIds': sorted(k_ids, key=int),
            'effectIds': sorted(e_ids, key=int), 'modelFileDataIDs': sorted(f_ids),
            'rootModelFileDataIDs':sorted(root_f_ids),
            'renderCapabilities': sorted(caps),
            'requiredRenderCapabilities':sorted(required),
            'capabilitySupport':support,
            'conditionalRenderCapabilities':sorted(c for c in caps if ledger[c]['requirement']=='conditional'),
            'optionalCapabilities':sorted(c for c in caps if ledger[c]['requirement']=='optional-audio'),
            'unclassifiedMetadata':sorted(c for c in caps if ledger[c]['requirement']=='unclassified-metadata'),
            'modelConversion': dict(Counter(models.get(f, {}).get('status', 'not-audited') for f in f_ids)),
            'hasUnimplementedOrUnknownModes': any(support[c] != 'implemented' for c in required),
            'hasUnclassifiedMetadata':any(ledger[c]['requirement']=='unclassified-metadata' for c in caps),
            'gpuExecuted': False, 'lifecycleExecuted': False, 'visuallyApproved': False}
    for entry in ledger.values():
        for field in ('records', 'spellIds', 'modelFileDataIDs'):
            entry[field] = sorted(entry[field])
        entry['requiredRecords'] = len(entry['records'])
        entry['impactedSpells'] = len(entry['spellIds'])
    definitions=graph.get('referenceDefinitions',{})
    for reference in definitions.get('missingReferences',[]):
        missing.append(dict(reference,source='referenceDefinitions'))
    definition_tables=definitions.get('tables',{})
    definition_summary={'present':bool(definitions),
        'complete':bool(definitions) and not definitions.get('missingReferences') and
                   all(t.get('status')=='decoded' for t in definition_tables.values()),
        'rootEdges':len(definitions.get('roots',[])),
        'internalEdges':len(definitions.get('references',[])),
        'includedRecords':sum(len(t.get('rows',{})) for t in definition_tables.values()),
        'tables':{name:{k:t[k] for k in ('layout','sourceSha256','definitionSha256',
                    'sourceBytes','status','availableRecords') if k in t} |
                    {'includedRecords':len(t.get('rows',{}))} for name,t in definition_tables.items()},
        'scope':definitions.get('scope'),
        'proof':'Metadata reference closure only; runtime semantics and renderer support are separate.'}
    return {'schema': 1, 'source': graph.get('source'), 'recordCounts': {k:len(v) for k,v in groups.items()},
        'spellsProcessed':len(spells), 'uniqueEffectFileDataIDs':len({r.get('fileDataID') for r in groups['effects'].values() if r.get('fileDataID')}),
        'missingReferences':missing,
        'missingReferencesScope':'Nonzero spell→visual→kit→effect, eligible procedure→chain links, and the declared referenceDefinitions scope when present. Other primitive/condition graphs and untyped context-selected IDs are not enumerated here.',
        'referenceDefinitionClosure':definition_summary,
        'capabilityLedger':dict(sorted(ledger.items())), 'spells':spells,
        'proofBoundary':'All potential catalog choices, not a claim every lifecycle is reachable for each spell. '
            'Mapped/implemented refers to identified source paths. Automatic native/GPU/lifecycle and visual acceptance require separate evidence.'}


def inspect_particles(storage, ids):
    rows, seen, pending = [], set(), sorted(ids)
    for fid in pending:
        if fid in seen:continue
        seen.add(fid)
        result = {'fileDataID':fid, 'emitters':[]}
        try:
            data = storage.read(f'id:{fid}')
            result['sourceSha256'] = sha(data)
            parts = assets.chunks(data)
            body = parts.get('MD21', b'')
            if body[:4] != b'MD20' or read(body, '<I', 4)[0] != 274:
                result['error'] = 'Not an inspected modern274 particle body'
            else:
                txac = parts.get('TXAC', b'')
                # These are emitter-indexed arrays: retain zero slots. assets.ids
                # intentionally removes zero for dependency discovery instead.
                def indexed(tag):
                    data = parts.get(tag,b'')
                    return [read(data,'<I',i)[0] for i in range(0,len(data),4)]
                gp, rp = indexed('GPID'), indexed('RPID')
                pending.extend(sorted(set(gp+rp)-seen-{0}))
                result['ribbonCount']=read(body,'<I',0x120)[0]
                def track_values(record,offset,fmt):
                    _,_,_,_,n,at=read(record,'<Hh4I',offset)
                    values=[]
                    stride=4 if fmt=='<f' else 1
                    for j in range(n):
                        count,keys=read(body,'<II',at+j*8)
                        if not count:
                            values.append(1 if fmt=='<B' else 0.)
                        values.extend(read(body,fmt,keys+k*stride)[0] for k in range(count))
                    return values
                result['animatedBoneChannels']=sum(
                    any(read(body,'<I',at+j*8)[0]>1 for j in range(n))
                    for bone in table(body,0x2c,88) for off in (16,36,56)
                    for _,_,_,_,n,at in [read(bone,'<Hh4I',off)])
                for i, particle in enumerate(table(body,0x128,492)):
                    colors, _ = read(particle,'<II',260)
                    rate=max(track_values(particle,176,'<f'),default=0.)
                    if not math.isfinite(rate):raise ValueError('Non-finite particle rate')
                    enabled=track_values(particle,456,'<B')
                    result['emitters'].append({'index':i, 'flags':read(particle,'<I',4)[0],
                        'blend':particle[40], 'shape':particle[41], 'colorIndex':read(particle,'<H',42)[0],
                        'colorKeyCount':colors, 'txac':read(txac,'<H',i*2)[0] if txac else 0,
                        'rateMax':rate,'emitsPotentially':rate>0 and (not enabled or any(enabled)),
                        'geometryFileDataID':gp[i] if i<len(gp) else 0,
                        'recursionFileDataID':rp[i] if i<len(rp) else 0})
        except (ValueError, assets.AssetError) as error:
            result['error'] = str(error)
        rows.append(result)
    return rows


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--graph',type=Path,required=True)
    parser.add_argument('--model-audit',type=Path)
    parser.add_argument('--install',type=Path)
    parser.add_argument('--library',type=Path,default=assets.DEFAULT_LIBRARY)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    raw=args.graph.read_bytes(); graph=json.loads(raw)
    model_raw=args.model_audit.read_bytes() if args.model_audit else b''
    model_rows=[json.loads(line) for line in model_raw.splitlines()]
    particle_rows=[]
    if args.install:
        if assets.client_build(args.install) != graph.get('source'):
            raise ValueError('Graph and retained client source identity disagree')
        with assets.CascStorage(args.install,args.library) as storage:
            particle_rows=inspect_particles(storage,{r['fileDataID'] for r in graph['effects'].values() if r.get('fileDataID')})
    result=audit(graph,model_rows,particle_rows)
    result['inputs']={'graph':str(args.graph),'graphSha256':sha(raw),'auditSha256':sha(Path(__file__).read_bytes()),
        'converterSha256':sha((ROOT/'scripts/classic_spells.py').read_bytes())}
    if args.model_audit:
        result['inputs'].update(modelAudit=str(args.model_audit),modelAuditSha256=sha(model_raw),
            modelAuditRecords=len(model_rows),
            modelAuditNamedRecords=sum(not isinstance(r.get('fileDataID'),int) for r in model_rows))
    result['particleModels']=particle_rows
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    capabilities=[{'id':key,'implementation':row['implementation'],
        'consumers':row['records'],'sourcePaths':source_paths(row['source']),
        'tests':row['testEvidence'],'requiredBy':[f'spell:{sid}' for sid in row['spellIds']],
        'reason':row['limitation'],'automaticallyTested':row['automaticallyTested'],
        'requirement':row['requirement'],'requiredForRendering':row['required'],
        'recordImplementations':row['recordImplementations']}
        for key,row in result['capabilityLedger'].items()]
    args.output.with_name('spells-capabilities.json').write_text(json.dumps({
        'schema':1,'source':result['source'],'rows':capabilities,
        'proofBoundary':result['proofBoundary']},indent=2,allow_nan=False)+'\n')
    print(json.dumps({'spellsProcessed':result['spellsProcessed'],'recordCounts':result['recordCounts'],
        'capabilities':len(result['capabilityLedger']),'missingReferences':len(result['missingReferences']),
        'particleModelsInspected':len(particle_rows),'output':str(args.output)},indent=2))


if __name__=='__main__':
    main()
