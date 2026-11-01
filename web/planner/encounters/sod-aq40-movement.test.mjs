import test from 'node:test';
import assert from 'node:assert/strict';
import { encounterJumpEvents } from './sod-aq40-movement.mjs';
import { normalizeReplay, enrichCombat, poseAt } from '../replay.mjs';

const actor = (id, type, gameID) => ({ id, type, gameID, name: String(id) });
function fixture(encounterID = 100709) {
  const source = encounterID === 100709 ? actor(67, 'NPC', 15263) : actor(120, 'NPC', 15510);
  const actors = [source, actor(1, 'Player', 0), actor(24, 'Pet', 1860), actor(71, 'NPC', 176525)];
  const fight = { id: 2, encounterID, startTime: 1000, endTime: 5000,
    gameZone: { id: 531 }, friendlyPlayers: [1], enemyNPCs: [{ id: source.id }] };
  return { gameVersion: 'sod', report: { code: 'bZX7VqdwpcmyrGzN', gameVersion: 'sod' }, fight, actors, events: [] };
}
const jump = (type, spell, sourceID = 67, targetID = 1, timestamp = 1500, extra = {}) =>
  ({ type, abilityGameID: spell, sourceID, targetID, timestamp, fight: 2, ...extra });
const extract = raw => encounterJumpEvents(normalizeReplay(raw));
// Parent integration merges these timestamps after prepareMovement. Exercise the
// actual existing consumer without editing its production implementation here.
function withJumps(raw) {
  const replay = enrichCombat(normalizeReplay(raw));
  for (const [key, records] of encounterJumpEvents(replay)) {
    const a = replay.actors.find(a => a.key === key);
    a.movement.blinks = [...a.movement.blinks, ...records.map(e => [e.t])].sort((a, b) => a[0] - b[0]);
  }
  return replay;
}

test('Skeram records source-instance casts only, with evidence and no invented landing', () => {
  const raw = fixture();
  raw.events = [jump('cast', 4801, 67, -1, 1700, { sourceInstance: 2 }),
    jump('cast', 20449), jump('cast', 8195, 67, -1, 1600), jump('begincast', 4801),
    jump('removedebuff', 4801), jump('cast', 4801, 71)];
  const before = JSON.stringify(raw), records = extract(raw);
  assert.deepEqual(records.get('67:1').map(r => [r.t, r.spell]), [[500, 20449], [600, 8195]]);
  assert.equal(records.get('67:2')[0].t, 700);
  for (const rows of records.values()) for (const r of rows) {
    assert.equal(r.kind, 'recorded-source-teleport');
    assert.ok(r.basis.includes('estimated landing'));
    assert.equal(r.encounterID, 100709);
    assert.ok(!['destination', 'position', 'height', 'route'].some(k => k in r));
  }
  assert.equal(JSON.stringify(raw), before);
});

test('Fankriss applications use player or pet recipient instance, never source or removals', () => {
  const raw = fixture(100712);
  raw.events = [jump('applydebuff', 731, 120, 24, 1500, { targetInstance: 2 }),
    jump('applydebuff', 1121, 120, 1, 1600), jump('removedebuff', 731, undefined, 24, 1700),
    jump('refreshdebuff', 1121, 120), jump('cast', 731, 120), jump('applydebuff', 720, 120),
    { type: 'removedebuff', timestamp: 1800, targetID: 24, targetInstance: 2, abilityGameID: 731, fight: 2 }];
  const records = extract(raw);
  assert.deepEqual([...records.keys()], ['24:2', '1:1']);
  assert.equal(records.get('24:2')[0].source, '120:1');
  assert.equal(records.get('24:2')[0].kind, 'recorded-target-entangle');
  assert.equal(records.has('120:1'), false);
});

test('full runs and repeated pulls use report chapters, not raw 709/712 encounter IDs', () => {
  const raw = fixture();
  const second = { ...raw.fight, id: 4, startTime: 6000, endTime: 9000 };
  raw.fight = { ...raw.fight, id: 'run', encounterID: undefined, endTime: 12000,
    chapters: [raw.fight, second, { ...second, id: 5, encounterID: 100710, startTime: 9001, endTime: 12000 }] };
  raw.events = [jump('encounterstart', 0, -1, -1, 1000, { encounterID: 709 }),
    jump('cast', 4801), jump('cast', 4801, 67, -1, 6500, { fight: 4 }),
    jump('cast', 8195, 67, -1, 7000, { fight: 2 }),
    jump('cast', 4801, 67, -1, 9500, { fight: 5 }), jump('cast', 4801, 67, -1, 5500)];
  assert.deepEqual(extract(raw).get('67:1').map(r => [r.t, r.chapterId]), [[500, 2], [5500, 4]]);
});

test('unrelated rulesets, chapters, maps and source identities cannot authorize jumps', () => {
  const mutations = [
    raw => { raw.gameVersion = raw.report.gameVersion = 'vanilla'; },
    raw => { raw.fight.encounterID = 709; },
    raw => { raw.fight.encounterID = 100712; },
    raw => { raw.fight.gameZone.id = 409; },
    raw => { raw.actors[0].gameID = 176525; },
    raw => { raw.actors[0].type = 'Player'; },
    raw => { raw.fight.enemyNPCs = []; },
    raw => { raw.events[0].fight = 99; },
    raw => { raw.events[0].sourceID = 1; },
  ];
  for (const mutate of mutations) {
    const raw = fixture(); raw.events = [jump('cast', 4801)]; mutate(raw);
    // Map/ruleset validation belongs to normalizeReplay; isolate the helper gate
    // when a deliberately unrelated map has no compatible raid fixture.
    const replay = { gameVersion: raw.gameVersion, duration: 4000, fight: raw.fight, raw,
      actors: raw.actors.map(a => ({ ...a, key: `${a.id}:1` })) };
    assert.equal(encounterJumpEvents(replay).size, 0);
  }
});

test('actual application switches below-threshold anchors at exact time for pets and players', () => {
  for (const [encounter, type, spell, source, recipient] of [
    [100709, 'cast', 20449, 67, 67], [100712, 'applydebuff', 731, 120, 24],
    [100712, 'applydebuff', 1121, 120, 1],
  ]) {
    const raw = fixture(encounter);
    raw.events = [jump('cast', 1, recipient, -1, 1100, { resourceActor: 1, x: 100, y: 100 }),
      jump(type, spell, source, recipient, 1500),
      jump('cast', 1, recipient, -1, 2100, { resourceActor: 1, x: 100, y: 700 })];
    const r = withJumps(raw), a = r.actors.find(a => a.id === recipient);
    // Six yards per second is below the generic 35 yd/s discontinuity cutoff.
    assert.deepEqual(poseAt(a, 499).pos, [1, -1, null]);
    assert.deepEqual(poseAt(a, 500).pos, [7, -1, null]);
    assert.deepEqual(poseAt(a, 501).pos, [7, -1, null]);
    assert.equal(poseAt(a, 500).positionSource, 'ability jump estimate');
    assert.equal(poseAt(a, 500).estimated, true);
    const exact = poseAt(a, 500); poseAt(a, 1000); poseAt(a, 100);
    assert.deepEqual(poseAt(a, 500), exact);
  }
});

test('mage Blink handling stays independent and duplicate events produce one annotation', () => {
  const raw = fixture();
  raw.events = [jump('cast', 1953, 1), jump('cast', 4801), jump('cast', 4801)];
  const r = withJumps(raw);
  assert.deepEqual(r.actors.find(a => a.id === 1).movement.blinks, [[500]]);
  assert.equal(encounterJumpEvents(r).get('67:1').length, 1);
  assert.deepEqual(encounterJumpEvents(r), encounterJumpEvents(r));
});

test('mixed full-run repeated Fankriss pulls retain pet instances and reject gap/removal events', () => {
  const raw = fixture(100712), first = raw.fight;
  raw.fight = { ...first, id: 'run', encounterID: undefined, endTime: 12000,
    chapters: [first, { ...first, id: 4, startTime: 6000, endTime: 9000 },
      { ...first, id: 5, encounterID: 100709, startTime: 9001, endTime: 12000 }] };
  raw.events = [jump('applydebuff', 731, 120, 24, 1500, { targetInstance: 2 }),
    jump('removedebuff', 731, 120, 24, 2100, { targetInstance: 2 }),
    jump('applydebuff', 1121, 120, 24, 6500, { fight: 4, targetInstance: 2 }),
    jump('applydebuff', 731, 120, 24, 5500),
    jump('applydebuff', 731, 120, 24, 9500, { fight: 5 })];
  assert.deepEqual(extract(raw).get('24:2').map(e => [e.t, e.spell, e.chapterId]),
    [[500, 731, 2], [5500, 1121, 4]]);
});

test('missing or conflicting source and recipient identities are rejected without mutating actors', () => {
  const raw = fixture(100712); raw.events = [jump('applydebuff', 731, 120, 24)];
  for (const mutate of [
    r => { r.actors.find(a => a.id === 120).gameID = 999; },
    r => { r.actors.find(a => a.id === 24).type = 'NPC'; },
    r => { r.actors = r.actors.filter(a => a.id !== 120); },
    r => { r.actors = r.actors.filter(a => a.id !== 24); },
    r => { r.raw.actors = r.raw.actors.map(a => a.id === 120 ? { ...a, gameID: 999 } : a); },
  ]) {
    const r = normalizeReplay(structuredClone(raw)); mutate(r);
    const before = JSON.stringify(r);
    assert.equal(encounterJumpEvents(r).size, 0);
    assert.equal(JSON.stringify(r), before);
  }
});
