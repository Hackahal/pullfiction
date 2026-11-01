#!/usr/bin/env python3
"""Synthetic checks for conservative all-catalog spell capability accounting."""
import importlib.util
from pathlib import Path
import struct
import unittest

spec=importlib.util.spec_from_file_location('spell_audit',Path(__file__).with_name('renderer-spell-audit.py'))
a=importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def graph():
    return {'source':{'version':'fixture'},'spells':{
        '1':{'name':'Instant','channel':False,'visuals':[{'id':10}]},
        '2':{'name':'Empty','visuals':[{'id':0}]},
        '3':{'name':'Unknown','visuals':[{'id':999}]}},
        'visuals':{'10':{'events':[
            {'start':'Impact','target':'Caster','kit':4,'end':'One-Shot'},
            {'start':'Impact','target':'Target','kit':0,'end':'One-Shot'},
            {'start':'Channel Start','target':'Target','kit':4,'end':'Channel End'}]}},
        'kits':{'4':{'effects':[],'proceduralEffects':[
            {'id':1,'type':0,'values':[8,1,0,0]},
            {'id':2,'type':0,'values':[9,1,0,0]},
            {'id':3,'type':8,'values':[123,20,600,100]}]}},
        'effects':{},'chainEffects':{'8':{'rendererCompatible':True},'9':{'rendererCompatible':False}}}


class AuditTest(unittest.TestCase):
    def test_animation_rate_support_is_record_specific_not_a_blanket_body_mapping(self):
        g=graph()
        g['kits']['4']['proceduralEffects']=[
            {'id':11,'type':11,'values':[0,0,0,0]},
            {'id':12,'type':11,'values':[0,2,0,0]}]
        result=a.audit(g)
        records=result['capabilityLedger']['procedure:type:11']['recordImplementations']
        self.assertEqual(records['procedure:11'],'implemented')
        self.assertEqual(records['procedure:12'],'unsupported')

    def test_freeze_parameter_compatibility_does_not_implement_cast_or_shared_lifecycles(self):
        g={'spells':{'1':{'visuals':[{'id':1}]},'2':{'visuals':[{'id':2}]},'3':{'visuals':[{'id':3}]}},
           'effects':{},'kits':{'4':{'effects':[],'proceduralEffects':[{'id':11,'type':11,'values':[0,0,0,0]}]}},
           'visuals':{
               '1':{'events':[{'start':'Cast','target':'Caster','end':'One-Shot','kit':4}]},
               '2':{'events':[{'start':'Aura Start','target':'Target','end':'Aura End','kit':4}]},
               '3':{'events':[{'start':'Cast','target':'Caster','end':'One-Shot','kit':4},
                              {'start':'Aura Start','target':'Target','end':'Aura End','kit':4}]}}}
        result=a.audit(g)
        self.assertTrue(result['spells']['1']['hasUnimplementedOrUnknownModes'])
        self.assertFalse(result['spells']['2']['hasUnimplementedOrUnknownModes'])
        self.assertTrue(result['spells']['3']['hasUnimplementedOrUnknownModes'])
        records=result['capabilityLedger']['procedure:freeze-consumer']['recordImplementations']
        self.assertEqual(records['visual:1:event:0:procedure:11'],'unsupported')
        self.assertEqual(records['visual:2:event:0:procedure:11'],'implemented')
        self.assertEqual(records['visual:3:event:0:procedure:11'],'unsupported')
        self.assertEqual(records['visual:3:event:1:procedure:11'],'implemented')

    def test_missing_missile_effect_is_an_unresolved_requirement_for_its_spell(self):
        g={'spells':{'1':{'visuals':[{'id':10}]},'2':{'visuals':[{'id':20}]}},
           'visuals':{'10':{'missiles':[{'effect':999}]},'20':{'missiles':[{'effect':0}]}},
           'effects':{}}
        out=a.audit(g)
        self.assertEqual(out['missingReferences'],[{'owner':'visual:10','dependency':'effect:999'}])
        broken,empty=out['spells']['1'],out['spells']['2']
        self.assertTrue(broken['hasUnimplementedOrUnknownModes'])
        self.assertIn('reference:missing-effect',broken['requiredRenderCapabilities'])
        self.assertEqual(broken['capabilitySupport']['reference:missing-effect'],'unknown')
        self.assertEqual(out['capabilityLedger']['reference:missing-effect']['spellIds'],[1])
        self.assertFalse(empty['hasUnimplementedOrUnknownModes'])
        self.assertNotIn('reference:missing-effect',empty['renderCapabilities'])
        g['effects']['999']={'type':0,'fileDataID':42}
        repaired=a.audit(g)
        self.assertEqual(repaired['missingReferences'],[])
        self.assertNotIn('reference:missing-effect',repaired['spells']['1']['renderCapabilities'])
        self.assertFalse(repaired['spells']['1']['hasUnimplementedOrUnknownModes'])

    def test_global_named_skybox_rows_do_not_invent_numeric_spell_roots(self):
        g=graph();g['kits']['4']['effects']=[{'id':6,'effect':5}]
        g['effects']['5']={'fileDataID':42,'type':0}
        out=a.audit(g,[{'fileDataID':None,'resource':'environments/stars/stars.m2','status':'adapted'},
                       {'fileDataID':42,'status':'adapted'}])
        self.assertEqual(out['spells']['1']['modelConversion'],{'adapted':1})
        self.assertEqual(out['spells']['1']['rootModelFileDataIDs'],[42])

    def test_definition_closure_is_reported_separately_from_render_implementation(self):
        g=graph();g['referenceDefinitions']={'tables':{'Curve':{'status':'decoded','layout':'1234',
            'availableRecords':10,'rows':{1:{'Type':0}}}},'roots':[{'table':'Curve','id':1}],
            'references':[],'missingReferences':[],'scope':{'families':['Curve']}}
        out=a.audit(g)
        self.assertTrue(out['referenceDefinitionClosure']['complete'])
        self.assertEqual(out['referenceDefinitionClosure']['includedRecords'],1)
        self.assertFalse(out['spells']['1']['gpuExecuted'])
        g['referenceDefinitions']['missingReferences']=[{'owner':'Curve:1','table':'Curve','id':2,'reason':'record-absent'}]
        out=a.audit(g)
        self.assertFalse(out['referenceDefinitionClosure']['complete'])
        self.assertEqual(out['missingReferences'][-1]['source'],'referenceDefinitions')

    def test_active_gpid_child_effects_cannot_be_credited_as_rpid_or_static_meshes(self):
        g=graph();g['kits']['4']['effects']=[{'id':7,'effect':5}]
        g['effects']['5']={'type':0,'fileDataID':203987}
        emit={'index':4,'flags':0,'blend':2,'shape':1,'txac':0,'colorIndex':0,
              'geometryFileDataID':189134,'recursionFileDataID':0,'emitsPotentially':True}
        child=dict(emit,index=0,geometryFileDataID=0)
        particles=[{'fileDataID':203987,'emitters':[emit]},
                   {'fileDataID':189134,'emitters':[child],'animatedBoneChannels':1}]
        r=a.audit(g,particle_records=particles)
        for key in ('particle:geometry-model-emitters','particle:geometry-model-animation'):
            self.assertEqual(r['capabilityLedger'][key]['implementation'],'unsupported')
            self.assertIn(key,r['spells']['1']['requiredRenderCapabilities'])
        emit['emitsPotentially']=False
        self.assertNotIn('particle:geometry-model-emitters',a.audit(g,particle_records=particles)['capabilityLedger'])

    def test_audio_bounds_and_unclassified_flags_are_not_unconditional_render_requirements(self):
        g=graph();g['kits']['4']['effects']=[{'id':7,'effect':5,'flags':4,'scale':1}]
        g['kits']['4']['unsupported']=[{'type':'SoundKitID','id':9},{'type':'UnitSoundType','id':2}]
        g['effects']['5']={'type':0,'fileDataID':42,'scale':1,
            'authored':{'MinAllowedScale':0x3f000000,'MaxAllowedScale':0x3fc00000}}
        r=a.audit(g);s=r['spells']['1']
        self.assertIn('catalog-primitive:SoundKitID',s['optionalCapabilities'])
        self.assertIn('catalog-primitive:UnitSoundType',s['optionalCapabilities'])
        self.assertIn('effect:scale-bounds',s['conditionalRenderCapabilities'])
        self.assertIn('attachment:flags:4',s['unclassifiedMetadata'])
        for key in ('catalog-primitive:SoundKitID','catalog-primitive:UnitSoundType','effect:scale-bounds','attachment:flags:4'):
            self.assertNotIn(key,s['requiredRenderCapabilities'])
        context=r['capabilityLedger']['effect:scale-bounds']['contexts']['effect:5']
        self.assertEqual(context,{'nominalEffectScale':1,'bounds':[.5,1.5],'nominalInsideBounds':True})
        self.assertNotIn('Channel',r['capabilityLedger']['event:Impact:Caster']['limitation'])

    def test_mixed_global_mode_does_not_give_an_unrelated_spell_the_wrong_status(self):
        g=graph()
        g['kits']['4']['proceduralEffects']=g['kits']['4']['proceduralEffects'][:1]
        g['kits']['5']={'proceduralEffects':[{'id':2,'type':0,'values':[9,1,0,0]}]}
        g['visuals']['20']={'events':[{'start':'Cast','target':'Caster','kit':5,'end':'One-Shot'}]}
        g['spells']['2']['visuals']=[{'id':20}]
        r=a.audit(g)
        self.assertEqual(r['capabilityLedger']['procedure:type:0']['implementation'],'partial')
        self.assertEqual(r['spells']['1']['capabilitySupport']['procedure:type:0'],'implemented')
        self.assertEqual(r['spells']['2']['capabilitySupport']['procedure:type:0'],'unsupported')

    def test_all_spell_denominator_and_zero_sentinel_do_not_fabricate_missing_references(self):
        r=a.audit(graph())
        self.assertEqual(r['spellsProcessed'],3)
        self.assertEqual(r['missingReferences'],[{'owner':'spell:3','dependency':'visual:999'}])
        self.assertFalse(r['spells']['1']['channel'])
        self.assertFalse(r['spells']['1']['lifecycleExecuted'])
        self.assertFalse(r['spells']['1']['visuallyApproved'])
        ledger=r['capabilityLedger']
        self.assertEqual(ledger['event:Impact:Caster']['implementation'],'unknown')
        self.assertEqual(ledger['event:Impact:Target']['implementation'],'implemented')
        delayed=graph();delayed['visuals']['10']['events'][1]['delay']=25
        self.assertEqual(a.audit(delayed)['capabilityLedger']['event:Impact:Target']['implementation'],'partial')

    def test_supported_and_unsupported_procedure_records_keep_their_individual_status(self):
        r=a.audit(graph())
        p=r['capabilityLedger']['procedure:type:0']
        self.assertEqual(p['implementation'],'partial')
        self.assertEqual(p['recordImplementations'],{'procedure:1':'implemented','procedure:2':'unsupported'})
        self.assertEqual(p['spellIds'],[1])
        self.assertEqual(r['capabilityLedger']['procedure:type:8']['implementation'],'implemented')
        self.assertFalse(p['automaticallyTested'],'source classification never invents runtime evidence')

    def test_refraction_is_renderable_partial_and_unknown_flags_do_not_earn_support(self):
        g=graph();g['kits']['4']['effects']=[{'effect':5,'id':6}]
        g['effects']['5']={'type':0,'fileDataID':42}
        emit={'index':0,'flags':0x100002,'blend':2,'shape':1,'txac':0,
              'colorIndex':0,'geometryFileDataID':0,'recursionFileDataID':0}
        r=a.audit(g,[{'fileDataID':42,'status':'adapted'}],[{'fileDataID':42,'emitters':[emit]}])
        self.assertEqual(r['spells']['1']['modelConversion'],{'adapted':1})
        p=r['capabilityLedger']['particle:refraction']
        self.assertEqual((p['implementation'],p['mapped']),('partial',True))
        self.assertEqual(p['modelFileDataIDs'],[42])
        self.assertEqual(r['capabilityLedger']['particle:flag:0x00000002']['implementation'],'unknown')
        self.assertTrue(r['spells']['1']['hasUnimplementedOrUnknownModes'])

    def test_particle_dependency_slots_keep_zero_indices(self):
        body=bytearray(0x130+2*492);body[:4]=b'MD20'
        struct.pack_into('<I',body,4,274);struct.pack_into('<II',body,0x128,2,0x130)
        chunk=lambda tag,data:tag+struct.pack('<I',len(data))+data
        raw=chunk(b'MD21',body)+chunk(b'RPID',struct.pack('<II',0,123))
        class Store:
            def read(self,_):return raw
        rows=a.inspect_particles(Store(),[7])
        self.assertEqual([p['recursionFileDataID'] for p in rows[0]['emitters']],[0,123])

    def test_missing_procedural_chain_refs_remain_visible_even_for_zero_beam_context(self):
        g=graph();g['kits']['4']['proceduralEffects']=[
            {'id':361886,'type':0,'values':[7067,1,1,0]},
            {'id':364283,'type':0,'values':[566,0,1,0]},
            {'id':364644,'type':0,'values':[610,0,0,0]}]
        r=a.audit(g)
        refs=[m for m in r['missingReferences'] if m['dependency'].startswith('chain:')]
        self.assertEqual(refs,[
            {'owner':'procedure:361886','dependency':'chain:7067','renderContext':'potential-draw'},
            {'owner':'procedure:364283','dependency':'chain:566','renderContext':'zero-beams'},
            {'owner':'procedure:364644','dependency':'chain:610','renderContext':'zero-beams'}])
        self.assertEqual(r['capabilityLedger']['procedure:chain-zero-beams']['requiredRecords'],2)


if __name__=='__main__':unittest.main()
