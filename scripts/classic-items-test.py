#!/usr/bin/env python3
import unittest
from unittest.mock import patch
import classic_items


def tables():
    rows = {name:{} for name in classic_items.TABLES}
    rows['ItemDisplayInfo'][8] = {'ModelResourcesID':[0,0], 'ModelMaterialResourcesID':[0,0],
        'GeosetGroup':[0]*6,'HelmetGeosetVis':[0,0], 'ItemVisual':7,'ParticleColorID':0,'ItemRangedDisplayInfoID':0}
    rows['ItemVisuals'][7] = {'Slot':[0,77,0,-1,88]}
    rows['SpellItemEnchantment'][9] = {'ItemVisual':7,'Flags':1}
    return rows


def catalog(rows):
    names = {key:{'Name_lang':'Authored enchant','HordeName_lang':'Authored alternate'}
             for key in rows['SpellItemEnchantment']}
    with patch.object(classic_items,'read_tables',return_value=(rows,{'SpellItemEnchantment':'test'})), \
         patch.object(classic_items,'named_table',return_value=(names,'test')):
        return classic_items.item_catalog(lambda _:b'',{'buildKey':'test'})


class ItemVisualTests(unittest.TestCase):
    def test_slots_keep_positions_and_enchantments_join_authored_ids(self):
        result = catalog(tables())
        self.assertEqual(result['itemVisuals'][7],[0,77,0,-1,88])
        self.assertEqual(result['displays'][8]['visual'],7)
        self.assertEqual(result['enchantments'][9],{'visual':7,'flags':1,'name':'Authored enchant','hordeName':'Authored alternate'})
        self.assertEqual(result['unresolvedVisualReferences'],[])

    def test_unresolved_references_remain_explicit_and_do_not_replace_ids(self):
        rows = tables()
        rows['ItemDisplayInfo'][8]['ItemVisual'] = 99
        rows['SpellItemEnchantment'][9]['ItemVisual'] = 100
        result = catalog(rows)
        self.assertEqual(result['displays'][8]['visual'],99)
        self.assertEqual(result['enchantments'][9]['visual'],100)
        self.assertEqual(result['coverage']['unresolvedVisualReferences'],2)

    def test_zero_visual_and_signed_flag_bits_are_retained(self):
        rows = tables()
        rows['SpellItemEnchantment'][9].update(ItemVisual=0,Flags=-1)
        result = catalog(rows)
        self.assertEqual(result['enchantments'][9]['visual'],0)
        self.assertEqual(result['enchantments'][9]['flags'],0xffffffff)
        self.assertEqual(result['unresolvedVisualReferences'],[])

    def test_visual_attachment_slots_are_not_compacted_or_padded(self):
        rows = tables()
        rows['ItemVisuals'][7]['Slot'] = [77,88]
        with self.assertRaisesRegex(ValueError,'five authored attachment slots'):
            catalog(rows)


if __name__ == '__main__': unittest.main()
