"""Replay character metadata from actual modern tables, for the original selectors.

CharSections is not invented. Texture recipes are a separate preparation input.
The five legacy look bytes use the client's explicit conversion table, never UI
sort order or arithmetic on modern choice IDs.
"""
from collections import defaultdict
from classic_db2 import DB2Error
from classic_creatures import source_check
from classic_table_strings import named_table

LAYOUTS = {'ChrRaces':'47a2e62f', 'ChrRaceXChrModel':'a203bc29', 'ChrModel':'03fab755',
           'ChrCustomizationConversion':'98d50cbd', 'ChrCustomizationChoice':'9559c358',
           'ChrCustomizationOption':'ef4b96c5', 'CharHairGeosets':'0dfa0f80',
           'CharacterFacialHairStyles':'7d8b51fb', 'HelmetGeosetData':'103b3b37',
           'ChrModelMaterial':'22469480', 'ChrCustomizationElement':'d68dcdea',
           'ChrCustomizationMaterial':'e61f7a35', 'ChrModelTextureLayer':'31f57e28'}
HELMET_GROUPS = [0, 1, 2, 3, 7]


def section_texture_types(tables, bodies, conversions):
    """Texture slots reached by playable converted choices, rather than layout capabilities."""
    layers = {}
    for row in tables['ChrModelTextureLayer'].values():
        targets = row['ChrModelTextureTargetID']
        if len(targets) != 2 or targets[1] != 0:
            raise DB2Error('Unsupported customization texture-layer targets.')
        key = row['CharComponentTextureLayoutsID'], targets[0]
        if key in layers:
            raise DB2Error('Ambiguous customization texture layer.')
        layers[key] = row['TextureType']
    result = []
    for body in bodies.values():
        race, sex = body['race'], body['sex']
        choices = {r['choiceId']:r for r in conversions if (r['race'],r['sex'])==(race,sex)}
        used = set()
        for element in tables['ChrCustomizationElement'].values():
            choice = choices.get(element['ChrCustomizationChoiceID'])
            if choice is None:
                continue
            related = element['RelatedChrCustomizationChoiceID']
            if related:
                other = choices.get(related)
                if other is None or (other['option']==choice['option'] and other['data']!=choice['data']):
                    continue
            material_id = element['ChrCustomizationMaterialID']
            if not material_id:
                continue
            material = tables['ChrCustomizationMaterial'].get(material_id)
            if material is None:
                raise DB2Error('Customization element names an absent material.')
            texture_type = layers.get((body['textureLayoutId'],material['ChrModelTextureTargetID']))
            if texture_type is None or texture_type not in body['textureTypes']:
                raise DB2Error('Customization material has no authored body texture layer.')
            used.add(texture_type)
        if 1 not in used:
            raise DB2Error('Playable body has no authored body-skin texture section.')
        result.append({'race':race,'sex':sex,'types':sorted(used)})
    return result


def character_catalog(read, source):
    source_check(source)
    tables, layouts = {}, {}
    for name, expected in LAYOUTS.items():
        rows, layout = named_table(read('dbfilesclient/' + name.lower() + '.db2'), name)
        if layout != expected:
            raise DB2Error(f'Unsupported {name} character layout {layout}; expected {expected}.')
        tables[name], layouts[name] = rows, layout
    bodies = {}
    for row in tables['ChrRaceXChrModel'].values():
        race, sex = row['ChrRacesID'], row['Sex']
        if sex not in (0, 1):
            raise DB2Error('Unsupported character body sex.')
        key = race, sex
        if key in bodies:
            raise DB2Error('Ambiguous race/body model mapping.')
        model = tables['ChrModel'].get(row['ChrModelID'])
        if model is None or model['Sex'] != sex:
            raise DB2Error('Character body names an absent or mismatched model.')
        layout = model['CharComponentTextureLayoutID']
        texture_types = sorted({r['TextureType'] for r in tables['ChrModelMaterial'].values()
                                if r['CharComponentTextureLayoutsID'] == layout})
        if not texture_types or any(not 0 <= value <= 0xffffffff for value in texture_types):
            raise DB2Error('Character body texture layout has no valid material types.')
        bodies[key] = {'race':race, 'sex':sex, 'modelId':row['ChrModelID'], 'displayId':model['DisplayID'],
                       'textureLayoutId':layout, 'textureTypes':texture_types}
    races = []
    for key, row in tables['ChrRaces'].items():
        prefix = row['ClientFileString']
        if not prefix or not prefix.isascii() or not prefix.isalnum():
            raise DB2Error('Invalid character race file prefix.')
        displays = [row['MaleDisplayID'], row['FemaleDisplayID']]
        for sex in (0, 1):
            if (key, sex) in bodies and bodies[key, sex]['displayId'] != displays[sex]:
                if 1 <= key <= 8:
                    raise DB2Error('ChrRaces and ChrModel playable body displays disagree.')
                # NPC race/model links can use a model other than the race's default body.
                # They do not identify replay player bodies (Goblin is one such case).
                del bodies[key, sex]
        races.append({'id':key, 'flags':row['Flags'] & 0xffffffff, 'faction':row['FactionID'],
                      'prefix':prefix, 'name':row['Name_lang'], 'displays':displays})
    conversions, keys = [], set()
    for row in tables['ChrCustomizationConversion'].values():
        race, sex, option, data = (row[n] for n in ('ChrRacesID','Sex','OptionID','Data'))
        if not 1 <= race <= 8:
            # The replay player contract covers the eight Classic playable races.
            # NPC-only customization (including Goblin) does not select player bodies.
            continue
        dependent, dependent_data = row['DependentOptionID'], row['DependentData']
        if not 1 <= option <= 5 or not 0 <= data <= 255 or not 0 <= dependent <= 5 or not 0 <= dependent_data <= 255:
            raise DB2Error('Unsupported legacy character conversion input.')
        if row['Field_3_4_0_45166_007'] != -1:
            raise DB2Error('Unsupported character conversion mode.')
        choice = tables['ChrCustomizationChoice'].get(row['ChrCustomizationChoiceID'])
        modern_option = tables['ChrCustomizationOption'].get(choice['ChrCustomizationOptionID']) if choice else None
        if modern_option is None or (race, sex) not in bodies or modern_option['ChrModelID'] != bodies[race, sex]['modelId']:
            raise DB2Error('Legacy conversion does not belong to its body model.')
        key = race, sex, option, data, dependent, dependent_data
        if key in keys:
            raise DB2Error('Ambiguous legacy character conversion.')
        keys.add(key)
        conversions.append({'race':race, 'sex':sex, 'option':option, 'data':data,
                            'dependentOption':dependent, 'dependentData':dependent_data,
                            'modernOptionId':modern_option['ID'], 'choiceId':choice['ID']})
    for race in range(1, 9):
        for sex in (0, 1):
            if (race, sex) not in bodies or not bodies[race, sex]['displayId']:
                raise DB2Error('Missing playable race/body display.')
            for option in range(1, 6):
                values = {r['data'] for r in conversions if (r['race'],r['sex'],r['option']) == (race,sex,option)}
                if not values or values != set(range(len(values))):
                    raise DB2Error('Missing or non-contiguous authored legacy dial conversion.')
    hair = []
    for row in tables['CharHairGeosets'].values():
        if row['VariationType'] != 3 or row['GeosetType'] != 0:
            raise DB2Error('Unsupported legacy hair geoset row.')
        hair.append({'race':row['RaceID'], 'sex':row['SexID'], 'variation':row['VariationID'], 'geoset':row['GeosetID']})
    facial = [{'race':row['RaceID'], 'sex':row['SexID'], 'variation':row['VariationID'], 'geosets':row['Geoset'][:3]}
              for row in tables['CharacterFacialHairStyles'].values()]
    masks = defaultdict(lambda: [0]*5)
    for row in tables['HelmetGeosetData'].values():
        group, race = row['HideGeosetGroup'], row['RaceID']
        if group not in HELMET_GROUPS or not 0 < race < 32 or row['RaceBitSelection'] or row['Field_10_0_0_46047_003'] != -1:
            raise DB2Error('Unsupported helmet geoset visibility row.')
        masks[row['HelmetGeosetVisDataID']][HELMET_GROUPS.index(group)] |= 1 << race
    return {'schema':1, 'source':source, 'layouts':layouts, 'races':races, 'bodies':list(bodies.values()),
            'sectionTextureTypes':section_texture_types(tables,bodies,conversions),
            'legacyConversions':conversions, 'hair':hair, 'facialHair':facial,
            'helmetMasks':[{'id':key, 'masks':value} for key,value in sorted(masks.items())],
            'coverage':{'replayMetadata':True, 'characterCreation':False, 'charSections':False,
                        'playableRaces':list(range(1,9)), 'npcCustomization':False,
                        'reason':'Creation outfits, name generation and creation UI tokens are outside the replay planner. Texture recipes are prepared separately.'}}
