"""Client-derived item appearances; uses the pinned community DB2 definitions."""
from collections import defaultdict
from classic_spells import read_tables, particle_colors
from classic_table_strings import named_table

TABLES=['Item','ItemModifiedAppearance','ItemAppearance','ItemDisplayInfo','ModelFileData',
        'TextureFileData','ItemDisplayInfoMaterialRes','ComponentModelFileData','ComponentTextureFileData','ItemRangedDisplayInfo',
        'ItemVisuals','SpellItemEnchantment']

def item_catalog(read, source):
    t,layouts=read_tables(read,TABLES)
    palettes = None
    models,textures=defaultdict(list),defaultdict(list)
    for key,row in t['ModelFileData'].items():
        component=t['ComponentModelFileData'].get(key,{})
        models[row['ModelResourcesID']].append({'file':key,'race':component.get('RaceID',0),
            'sex':component.get('GenderIndex',-1),'position':component.get('PositionIndex',-1)})
    for key,row in t['TextureFileData'].items():
        component=t['ComponentTextureFileData'].get(key,{})
        textures[row['MaterialResourcesID']].append({'file':key,'race':component.get('RaceID',0),'sex':component.get('GenderIndex',-1)})
    displays={}
    for key,row in t['ItemDisplayInfo'].items():
        displays[key]={'models':[models[i] for i in row['ModelResourcesID']],
            'textures':[textures[i] for i in row['ModelMaterialResourcesID']],
            'geosets':row['GeosetGroup'][:3],'helmet':row['HelmetGeosetVis'],'regions':{},'visual':row['ItemVisual'],
            'particleColorID':row['ParticleColorID'],
            'rangedVisual':t['ItemRangedDisplayInfo'].get(row['ItemRangedDisplayInfoID'],{}).get('CastSpellVisualID',0)}
        if row['ParticleColorID']:
            if palettes is None: palettes = particle_colors(read)
            if row['ParticleColorID'] not in palettes:
                raise ValueError('Item display references an unavailable ParticleColor palette.')
            displays[key]['particleColors'] = palettes[row['ParticleColorID']]
    for row in t['ItemDisplayInfoMaterialRes'].values():
        if row['ItemDisplayInfoID'] in displays:
            displays[row['ItemDisplayInfoID']]['regions'][row['ComponentSection']]=textures[row['MaterialResourcesID']]
    items={}
    for row in t['ItemModifiedAppearance'].values():
        if row['ItemAppearanceModifierID'] or row['ItemID'] not in t['Item']:
            continue
        a=t['ItemAppearance'].get(row['ItemAppearanceID'])
        if not a:continue
        item=t['Item'][row['ItemID']]
        items[row['ItemID']]={'display':a['ItemDisplayInfoID'],'class':item['ClassID'],
            'subclass':item['SubclassID'],'inventory':item['InventoryType'],'material':item['Material'],
            'sheath':item['SheatheType'],'iconFile':a['DefaultIconFileDataID']}
    unresolved = {}
    for key, item in t['Item'].items():
        if key not in items:
            unresolved[key] = {'display':0,'class':item['ClassID'],'subclass':item['SubclassID'],
                'inventory':item['InventoryType'],'material':item['Material'],'sheath':item['SheatheType'],
                'iconFile':item['IconFileDataID'], 'reason':'No resolvable authored default item appearance.'}
    visuals = {key:list(row['Slot']) for key,row in t['ItemVisuals'].items()}
    if any(len(slots) != 5 for slots in visuals.values()):
        raise ValueError('ItemVisuals must retain all five authored attachment slots.')
    names = {}
    if t['SpellItemEnchantment']:
        names, name_layout = named_table(read('dbfilesclient/spellitemenchantment.db2'), 'SpellItemEnchantment')
        if name_layout != layouts['SpellItemEnchantment']:
            raise ValueError('Enchantment metadata and string layouts disagree.')
    enchantments = {key:{'visual':row['ItemVisual'],'flags':row['Flags'] & 0xffffffff,
                         'name':names[key].get('Name_lang',''),
                         'hordeName':names[key].get('HordeName_lang','')}
                    for key,row in t['SpellItemEnchantment'].items()}
    unresolved_visuals = [dict(type='display',id=key,visual=row['visual']) for key,row in displays.items()
                          if row['visual'] > 0 and row['visual'] not in visuals]
    unresolved_visuals += [dict(type='enchantment',id=key,visual=row['visual']) for key,row in enchantments.items()
                           if row['visual'] > 0 and row['visual'] not in visuals]
    return {'schema':1,'source':source,'layouts':layouts,'items':items,'unresolvedItems':unresolved,
            'itemVisuals':visuals,'enchantments':enchantments,'unresolvedVisualReferences':unresolved_visuals,
            'coverage':{'sourceItemRows':len(t['Item']),'defaultAppearanceItems':len(items),
                        'unresolvedDefaultAppearances':len(unresolved), 'itemVisualRows':len(visuals),
                        'enchantmentRows':len(enchantments), 'unresolvedVisualReferences':len(unresolved_visuals)},'displays':displays}
