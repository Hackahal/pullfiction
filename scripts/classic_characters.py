"""Modern character appearance recipes from the selected client's DB2 tables.

Relationships follow wow.export's MIT-licensed DBCharacterCustomization and
character-appearance pipeline. See third_party/wowexport/SOURCE.md.
No CharSections, legacy client data, atlas coordinates or texture files are bundled.
"""
from collections import defaultdict
import math
from classic_db2 import creature_catalog, DB2Error
from classic_items import item_catalog
from classic_spells import read_tables
from classic_compat import read as read_field, span, table

TABLES = ['ChrRaceXChrModel', 'ChrModel', 'ChrCustomizationOption',
          'ChrCustomizationChoice', 'ChrCustomizationElement', 'ChrCustomizationMaterial',
          'ChrCustomizationGeoset', 'ChrModelMaterial', 'ChrModelTextureLayer',
          'CharComponentTextureLayouts', 'CharComponentTextureSections', 'TextureFileData',
          'ComponentTextureFileData', 'ChrCustomizationConversion']

# Adapted from wow.export EquipmentSlots and DBItemGeosets, MIT.
# Copyright (c) Kruithne and Marlamin. Full notices: third_party/wowexport/LICENSE.
# Keys are Warcraft Logs' zero-based equipment slots, not InventoryType values.
GEAR_GROUPS = {0: (27, 21), 2: (26,), 3: (8, 10), 4: (8, 10, 13, 22, 28),
               5: (18,), 6: (11, 9, 13), 7: (5, 20), 8: (), 9: (4, 23),
               14: (15,), 18: (12,)}
GEAR_PRIORITY = {8: (9, 4, 3), 10: (4, 3), 13: (4, 6)}
GEAR_LAYER = {3: 10, 6: 10, 0: 11, 7: 11, 2: 13, 4: 13, 18: 17,
              5: 18, 8: 19, 9: 20, 15: 21, 16: 22, 14: 23, 17: 21}
NONVISUAL_SLOTS = {1, 10, 11, 12, 13}
SLOT_INVENTORIES = {0: {1}, 2: {3}, 3: {4}, 4: {5, 20}, 5: {6}, 6: {7},
                    7: {8}, 8: {9}, 9: {10}, 14: {16}, 15: {13, 17, 21},
                    16: {13, 14, 22, 23}, 17: {15, 25, 26, 28}, 18: {19}}


def visible_geosets(ids, overrides):
    """Apply model defaults and explicit customization group overrides.

    An authored override can name no submesh in a group, meaning hide the group.
    Model submesh zero always remains visible, as in the reference consumer.
    """
    visible = []
    for id in sorted(set(ids)):
        text = str(id)
        enabled = (id == 0 or text.endswith('01') or text.startswith('32')) and not text.startswith(('17', '35'))
        if id != 0 and id // 100 in overrides:
            enabled = id in overrides[id // 100]
        if enabled:
            visible.append(id)
    return visible


class Characters:
    def __init__(self, read, source):
        self.read = read
        self.geoset_ids = {}
        self.model_data = {}
        self.item_data = None
        self.source = source
        self.tables, self.layouts = read_tables(read, TABLES)
        self.legacy_conversions = defaultdict(list)
        for row in self.tables['ChrCustomizationConversion'].values():
            self.legacy_conversions[row['ChrRacesID'], row['Sex']].append(row)
        self.creatures = creature_catalog(read('dbfilesclient/creaturedisplayinfo.db2'),
                                          read('dbfilesclient/creaturemodeldata.db2'))
        t = self.tables
        self.races = {(r['ChrRacesID'], r['Sex']): r['ChrModelID']
                      for r in t['ChrRaceXChrModel'].values()}
        self.options, self.choices, self.elements = defaultdict(list), defaultdict(list), defaultdict(list)
        for row in t['ChrCustomizationOption'].values():
            self.options[row['ChrModelID']].append(row)
        for row in t['ChrCustomizationChoice'].values():
            self.choices[row['ChrCustomizationOptionID']].append(row)
        for row in t['ChrCustomizationElement'].values():
            self.elements[row['ChrCustomizationChoiceID']].append(row)
        self.texture_files = defaultdict(list)
        for key, row in t['TextureFileData'].items():
            if row['UsageType'] == 0:
                resource = row['MaterialResourcesID']
                file = row.get('FileDataID', key)
                self.texture_files[resource].append((file, t['ComponentTextureFileData'].get(file, {})))
        self.materials = {(r['CharComponentTextureLayoutsID'], r['TextureType']): r
                          for r in t['ChrModelMaterial'].values()}
        self.layers = {(r['CharComponentTextureLayoutsID'], r['ChrModelTextureTargetID'][0]): r
                       for r in t['ChrModelTextureLayer'].values()}
        self.sections = defaultdict(list)
        for row in t['CharComponentTextureSections'].values():
            self.sections[row['CharComponentTextureLayoutID']].append(row)

    def supported(self):
        return [{'race': race, 'sex': sex, 'model': model}
                for (race, sex), model in sorted(self.races.items())]

    def texture_file(self, resource, race, sex, class_id=0):
        candidates = []
        for file, component in self.texture_files[resource]:
            r, s, c = (component.get(k, default) for k, default in
                       [('RaceID', 0), ('GenderIndex', -1), ('ClassID', 0)])
            if r not in (0, race) or s not in (-1, sex) or c not in (0, class_id):
                continue
            candidates.append(((r == race, s == sex, c != 0), file))
        if not candidates:
            return None
        rank = max(value[0] for value in candidates)
        files = {file for score, file in candidates if score == rank}
        if len(files) != 1:
            raise DB2Error('Ambiguous customization texture resource for this character.')
        return files.pop()

    def model_geosets(self, file):
        if file not in self.geoset_ids:
            parts = self.model_parts(file)
            if b'MD21' not in parts or len(parts.get(b'SFID', b'')) < 4:
                raise DB2Error('Character model has no modern skin profile.')
            skin = self.read('id:'+str(read_field(parts[b'SFID'], '<I', 0)[0]))
            if skin[:4] != b'SKIN':
                raise DB2Error('Invalid character skin profile.')
            self.geoset_ids[file] = sorted({read_field(row, '<H', 0)[0] for row in table(skin, 28, 48)})
        return self.geoset_ids[file]

    def model_parts(self, file):
        if file not in self.model_data:
            data, parts, cursor = self.read('id:'+str(file)), {}, 0
            while cursor < len(data):
                tag, size = read_field(data, '<4sI', cursor)
                if tag in parts:
                    raise DB2Error('Duplicate modern model chunk.')
                parts[tag] = span(data, cursor+8, size)
                cursor += 8+size
            self.model_data[file] = parts
        return self.model_data[file]

    def attachment_point(self, file, id):
        data = self.model_parts(file).get(b'MD21', b'')
        lookup = table(data, 0xF8, 2)
        records = table(data, 0xF0, 40)
        if id >= len(lookup):
            return None
        index = read_field(lookup[id], '<H', 0)[0]
        if index >= len(records):
            return None
        row = records[index]
        bone = read_field(row, '<H', 4)[0]
        position = read_field(row, '<3f', 8)
        if bone >= read_field(data, '<I', 0x2C)[0] or any(not math.isfinite(v) for v in position):
            raise DB2Error('Invalid authored character attachment point.')
        return {'id': id, 'bone': bone, 'position': list(position)}

    def select_gear_file(self, candidates, race, sex, class_id, *, texture=False, position=None):
        ranked = []
        for row in candidates:
            file = row['file']
            component = self.tables['ComponentTextureFileData'].get(file, {}) if texture else row
            r = component.get('RaceID', row.get('race', 0))
            s = component.get('GenderIndex', row.get('sex', -1))
            c = component.get('ClassID', 0)
            wildcard = (-1, 3) if texture else (-1, 2)
            if r not in (0, race) or s not in (*wildcard, sex) or c not in (0, class_id):
                continue
            if position is not None and row.get('position', -1) not in (-1, position):
                continue
            if texture and self.tables['TextureFileData'].get(file, {}).get('UsageType', 0) != 0:
                continue
            ranked.append(((r == race, s == sex, c != 0, row.get('position') == position), file))
        if not ranked:
            return None
        rank = max(score for score, _ in ranked)
        files = {file for score, file in ranked if score == rank}
        if len(files) != 1:
            raise DB2Error('Ambiguous equipment resource for the selected character.')
        return files.pop()

    def equipment(self, request, race, sex, class_id, layout_id, body_file, textures, groups, unsupported):
        gear = request.get('gear', [])
        display_only = 'bodyDisplays' in request
        if display_only:
            ids = request['bodyDisplays']
            if gear or not isinstance(ids, list) or len(ids) != 8 or any(type(v) is not int or not 0 <= v < 2**32 for v in ids):
                raise DB2Error('Invalid original body display list.')
            gear = [{'id': 0, 'display': display, 'slot': slot}
                    for slot, display in zip((3, 4, 5, 6, 7, 8, 9, 18), ids) if display]
        if not isinstance(gear, list) or len(gear) > 19:
            raise DB2Error('Invalid equipment list.')
        slots = set()
        for entry in gear:
            if not isinstance(entry, dict) or type(entry.get('id')) is not int or not 0 <= entry['id'] < 2**31 or \
                    type(entry.get('slot')) is not int or not 0 <= entry['slot'] <= 18 or entry['slot'] in slots:
                raise DB2Error('Invalid equipment item or duplicate slot.')
            slots.add(entry['slot'])
        gear = [entry for entry in gear if (entry['id'] or entry.get('display')) and entry['slot'] not in NONVISUAL_SLOTS]
        if not gear:
            return [], []
        if self.item_data is None:
            self.item_data = item_catalog(self.read, self.source)
            # The shared catalog intentionally retains only its legacy consumer's
            # first three groups. Appearance preparation uses the complete row.
            self.gear_tables, _ = read_tables(self.read, ['ItemDisplayInfo', 'HelmetGeosetData'])
        resolved, attachments, geoset_values = [], [], defaultdict(list)
        for entry in sorted(gear, key=lambda r: (GEAR_LAYER.get(r['slot'], 0), r['slot'])):
            item, slot = entry['id'], entry['slot']
            info = {'display': entry['display']} if display_only else self.item_data['items'].get(item)
            display = self.item_data['displays'].get(info['display']) if info else None
            if display is None:
                if display_only:
                    raise DB2Error('Original body display is absent from the modern client.')
                unsupported.append({'type': 'gear-item', 'id': item, 'slot': slot,
                                    'reason': 'No modern default item appearance.'})
                continue
            if not display_only and info['inventory'] not in SLOT_INVENTORIES[slot]:
                unsupported.append({'type': 'gear-slot-mismatch', 'id': item, 'slot': slot,
                                    'inventory': info['inventory']})
                continue
            resolved.append({'id': item, 'slot': slot, 'display': info['display']})
            full = self.gear_tables['ItemDisplayInfo'][info['display']]
            values = full['GeosetGroup']
            for index, group in enumerate(GEAR_GROUPS.get(slot, ())):
                value = values[index] if index < len(values) else 0
                value = (value or 2) if slot == 7 and group == 20 else value + 1
                geoset_values[group].append((slot, group * 100 + value))

            for section_type, candidates in sorted(display['regions'].items()):
                file = self.select_gear_file(candidates, race, sex, class_id, texture=True)
                sections = [r for r in self.sections[layout_id] if r['SectionType'] == section_type]
                layers = [r for (layout, _), r in self.layers.items() if layout == layout_id and
                          r['TextureSectionTypeBitMask'] != -1 and
                          r['TextureSectionTypeBitMask'] & (1 << section_type) and r['TextureType'] in (1, 8)]
                if not layers:
                    layers = [r for (layout, _), r in self.layers.items() if layout == layout_id and
                              r['TextureSectionTypeBitMask'] == -1 and r['TextureType'] == 1]
                if not file or len(sections) != 1 or not layers:
                    unsupported.append({'type': 'gear-texture-region', 'id': item, 'slot': slot, 'section': section_type})
                    continue
                layer, section = layers[0], sections[0]
                texture_type = layer['TextureType']
                definition = self.materials.get((layout_id, texture_type))
                if definition is None:
                    raise DB2Error('Equipment texture has no atlas material.')
                width, height = definition['Width'], definition['Height']
                if width <= 0 or height <= 0 or width * height > 4096 * 4096:
                    raise DB2Error('Invalid equipment atlas dimensions.')
                x, y, w, h = (section[k] for k in ('X', 'Y', 'Width', 'Height'))
                if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
                    raise DB2Error('Equipment atlas section exceeds its material.')
                target = textures.setdefault(texture_type, {'type': texture_type, 'width': width,
                    'height': height, 'composite': True, 'layers': []})
                target['layers'].append({'file': file, 'target': GEAR_LAYER.get(slot, 0) * 100 + section_type,
                    'order': layer['Layer'], 'blend': 15 if layer['BlendMode'] in (0, 1) else layer['BlendMode'],
                    'rect': [x, y, w, h], 'item': item, 'slot': slot})

            # The original renderer still handles equipment models. This operation supplies
            # only its composited body atlas, so unrelated model-variant ambiguity cannot
            # prevent an otherwise complete garment texture from being prepared.
            if display_only:
                continue
            bindings = []
            for index, candidates in enumerate(display['textures']):
                file = self.select_gear_file(candidates, race, sex, class_id, texture=True)
                if file:
                    bindings.extend([{'type': 2 + index, 'file': file}, {'type': 11 + index, 'file': file}])
            if slot == 14 and bindings:
                textures[2] = {'type': 2, 'width': 0, 'height': 0, 'composite': False,
                               'layers': [{'file': bindings[0]['file'], 'target': 0, 'order': 0, 'blend': 0, 'rect': [0, 0, 0, 0]}]}
            points = () if display_only else {0: (11,), 2: (6, 5), 15: (2 if info['class'] == 2 and info['subclass'] == 2 else 1,),
                      16: (0 if info['inventory'] == 14 else 2,),
                      17: (2 if info['class'] == 2 and info['subclass'] == 2 else 1,)}.get(slot, ())
            for index, candidates in enumerate(display['models']):
                if not candidates:
                    continue
                position = index if slot == 2 and any(r.get('position', -1) >= 0 for r in candidates) else None
                file = self.select_gear_file(candidates, race, sex, class_id, position=position)
                point = self.attachment_point(body_file, points[index]) if index < len(points) else None
                if not file or point is None:
                    unsupported.append({'type': 'gear-model-attachment', 'id': item, 'slot': slot,
                                        'file': file, 'reason': 'No supported authored attachment or race/body model.'})
                    continue
                attachments.append({'item': item, 'slot': slot, 'file': file, 'point': point, 'textures': bindings,
                                    'mode': 'ranged' if slot == 17 else 'melee' if slot in (15, 16) else 'armor'})

            if not display['regions'] and not any(display['models']) and not bindings and info.get('inventory') != 28:
                unsupported.append({'type': 'gear-no-visual-data', 'id': item, 'slot': slot,
                                    'reason': 'No authored body texture, model, or replaceable texture.'})

            if slot == 0:
                visibility = full['HelmetGeosetVis'][sex]
                hidden = []
                for row in self.gear_tables['HelmetGeosetData'].values():
                    if row['HelmetGeosetVisDataID'] == visibility and row['RaceID'] == race:
                        hidden.append(row['HideGeosetGroup'])
                for group in hidden:
                    groups[group] = set()
        for group, candidates in geoset_values.items():
            priority = GEAR_PRIORITY.get(group, tuple(slot for slot, _ in candidates))
            chosen = min(candidates, key=lambda pair: priority.index(pair[0]) if pair[0] in priority else len(priority))
            groups[group] = {chosen[1]}
        return resolved, attachments

    def appearance(self, request):
        if not isinstance(request, dict):
            raise DB2Error('Invalid character appearance request.')
        race, sex = request.get('race'), request.get('sex')
        if type(race) is not int or type(sex) is not int or (race, sex) not in self.races:
            raise DB2Error('Unsupported character race/body combination.')
        class_id = request.get('class', 0)
        if type(class_id) is not int or not 0 <= class_id <= 13:
            raise DB2Error('Invalid character class.')
        model_id = self.races[race, sex]
        model = self.tables['ChrModel'][model_id]
        display = self.creatures['displays'].get(model['DisplayID'])
        if display is None:
            raise DB2Error('Character display does not resolve to a modern model.')
        geometry = self.creatures['models'][display['modelID']]
        layout_id = model['CharComponentTextureLayoutID']
        overrides = request.get('choices', {})
        if 'legacyLook' in request:
            look = request['legacyLook']
            if not isinstance(look, list) or len(look) != 5 or any(type(v) is not int or not 0 <= v <= 255 for v in look):
                raise DB2Error('Invalid legacy character look.')
            if overrides:
                raise DB2Error('Choose either legacy appearance bytes or modern choices.')
            overrides = {}
            for option, value in enumerate(look, 1):
                matches = [row for row in self.legacy_conversions[race, sex]
                           if row['OptionID'] == option and row['Data'] == value
                           and (not row['DependentOptionID'] or
                                look[row['DependentOptionID'] - 1] == row['DependentData'])]
                if len(matches) != 1:
                    raise DB2Error('Legacy character look has no unambiguous modern conversion.')
                choice = self.tables['ChrCustomizationChoice'].get(matches[0]['ChrCustomizationChoiceID'])
                if choice is None:
                    raise DB2Error('Legacy character conversion names an absent choice.')
                overrides[choice['ChrCustomizationOptionID']] = choice['ID']
        if not isinstance(overrides, dict) or len(overrides) > 64:
            raise DB2Error('Invalid character customization choices.')
        try:
            overrides = {int(k): v for k, v in overrides.items()}
        except (ValueError, TypeError):
            raise DB2Error('Invalid character customization option ID.')
        options = sorted(self.options[model_id], key=lambda r: (r['OrderIndex'], r['ID']))
        if any(key not in {r['ID'] for r in options} for key in overrides):
            raise DB2Error('Customization option does not belong to the selected character.')
        selected, active_options = set(), []
        for option in options:
            if option['Flags'] & 0x20 and option['ID'] not in overrides:
                continue
            choices = sorted(self.choices[option['ID']], key=lambda r: (r['OrderIndex'], r['ID']))
            if not choices:
                continue
            choice = overrides.get(option['ID'], choices[0]['ID'])
            if type(choice) is not int or choice not in {r['ID'] for r in choices}:
                raise DB2Error('Customization choice does not belong to the selected option.')
            selected.add(choice)
            active_options.append({'option': option['ID'], 'choice': choice})

        textures, groups, unsupported = {}, defaultdict(set), []
        active = [element for choice in selected for element in self.elements[choice]
                  if not element['RelatedChrCustomizationChoiceID'] or
                  element['RelatedChrCustomizationChoiceID'] in selected]
        for element in active:
            geoset = self.tables['ChrCustomizationGeoset'].get(element['ChrCustomizationGeosetID'])
            if geoset:
                groups[geoset['GeosetType']].add(geoset['GeosetType'] * 100 + geoset['GeosetID'])
            for field in ('ChrCustomizationSkinnedModelID', 'ChrCustomizationBoneSetID',
                          'ChrCustomizationCondModelID', 'ChrCustomizationDisplayInfoID',
                          'ChrCustItemGeoModifyID', 'ParticleColorID'):
                if element.get(field):
                    unsupported.append({'type': field, 'id': element[field]})
            material = self.tables['ChrCustomizationMaterial'].get(element['ChrCustomizationMaterialID'])
            if material is None:
                continue
            target = material['ChrModelTextureTargetID']
            layer = self.layers.get((layout_id, target))
            if layer is None:
                raise DB2Error('Customization material has no texture layer for its model layout.')
            slot = layer['TextureType']
            definition = self.materials.get((layout_id, slot))
            file = self.texture_file(material['MaterialResourcesID'], race, sex, class_id)
            if definition is None or not file:
                raise DB2Error('Customization material has no atlas definition or texture file.')
            width, height = definition['Width'], definition['Height']
            if width <= 0 or height <= 0 or width * height > 4096 * 4096:
                raise DB2Error('Invalid character atlas dimensions.')
            if slot not in textures:
                textures[slot] = {'type': slot, 'width': width, 'height': height,
                                  'composite': slot in (1, 8), 'layers': []}
            mask = layer['TextureSectionTypeBitMask']
            sections = [{'X': 0, 'Y': 0, 'Width': width, 'Height': height}] if mask == -1 else [
                r for r in self.sections[layout_id] if mask & (1 << r['SectionType'])]
            if len(sections) != 1:
                raise DB2Error('Customization texture layer needs an unambiguous atlas section.')
            section = sections[0]
            x, y, w, h = (section[k] for k in ('X', 'Y', 'Width', 'Height'))
            if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
                raise DB2Error('Customization atlas section exceeds its material.')
            textures[slot]['layers'].append({'file': file, 'target': target,
                'order': layer['Layer'], 'blend': layer['BlendMode'], 'rect': [x, y, w, h]})
        gear, attachments = self.equipment(request, race, sex, class_id, layout_id,
                                          geometry['fileDataID'], textures, groups, unsupported)
        for texture in textures.values():
            # wow.export orders authored texture targets, not user selection order.
            texture['layers'].sort(key=lambda r: (r['target'], r['order'], r['file']))
        if 1 not in textures:
            raise DB2Error('Selected character choices do not supply a body texture.')
        return {'schema': 1, 'source': self.source, 'race': race, 'sex': sex,
                'model': model_id, 'display': model['DisplayID'], 'file': geometry['fileDataID'],
                'scale': display['scale'] * geometry['scale'], 'layout': layout_id,
                'choices': active_options, 'geosetOverrides': {str(k): sorted(v) for k, v in groups.items()},
                'visibleGeosets': visible_geosets(self.model_geosets(geometry['fileDataID']), groups),
                'textures': sorted(textures.values(), key=lambda r: r['type']),
                'gear': gear, 'attachments': attachments,
                'unsupported': unsupported}
