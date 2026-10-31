"""Client-derived item appearances; uses the pinned community DB2 definitions."""
from collections import defaultdict
from classic_spells import read_tables

TABLES=['Item','ItemModifiedAppearance','ItemAppearance','ItemDisplayInfo','ModelFileData',
        'TextureFileData','ItemDisplayInfoMaterialRes','ComponentModelFileData','ComponentTextureFileData','ItemRangedDisplayInfo']

def item_catalog(read, source):
    t,layouts=read_tables(read,TABLES)
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
            'rangedVisual':t['ItemRangedDisplayInfo'].get(row['ItemRangedDisplayInfoID'],{}).get('CastSpellVisualID',0)}
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
    return {'schema':1,'source':source,'layouts':layouts,'items':items,'displays':displays}
