import { validatePlan } from '../web/planner/plan.mjs';

export const MAX_SHARE_BYTES = 256 * 1024;
export const SHARE_ID = /^[A-Za-z0-9_-]{32}$/;
export const DELETE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

// Construct every field explicitly. Project backups, replay streams, credentials,
// cache identities and unknown extension fields are never part of a share.
export function validateShare(value) {
  if (!value || value.version !== 1 || bytes(value) > MAX_SHARE_BYTES)
    throw new Error('Share exceeds 256 KiB or has an unsupported version.');
  const plan = validatePlan(value.plan);
  if (!['vanilla', 'sod'].includes(value.plan.gameVersion))
    throw new Error('Unsupported game version.');
  for (const step of plan.steps) {
    for (const actor of step.snapshot?.actors ?? []) {
      if (actor.icon != null && !/^(?:id:[1-9][0-9]{0,9}|(?:interface[\\/]icons[\\/])?[A-Za-z0-9_-]{1,160}(?:\.(?:blp|png|jpe?g))?)$/i.test(actor.icon))
        throw new Error('Invalid actor icon identifier.');
      if (Math.abs(actor.facing) > 1e6 || Math.abs(actor.recordedFacing ?? 0) > 1e6)
        throw new Error('Invalid actor facing.');
    }
  }
  let source = null;
  if (value.source !== null) {
    const s = value.source;
    if (!s || typeof s.code !== 'string' || !/^[A-Za-z0-9]{16}$/.test(s.code) ||
        typeof s.title !== 'string' || s.title.length > 1000 ||
        s.gameVersion !== plan.gameVersion || s.map !== plan.mapId ||
        (s.fight !== 'run' && (!Number.isSafeInteger(s.fight) || s.fight < 1)))
      throw new Error('Invalid Warcraft Logs reference.');
    source = { code: s.code, title: s.title, gameVersion: s.gameVersion, fight: s.fight, map: s.map };
  }
  if (!Number.isFinite(value.time) || value.time < 0 || value.time > 604800000 ||
      !['analyse', 'plan'].includes(value.mode) || !['plan', 'replay'].includes(value.kind))
    throw new Error('Invalid shared workspace.');
  const result = { version: 1, plan, source, time: value.time, mode: value.mode, kind: value.kind };
  if (bytes(result) > MAX_SHARE_BYTES) throw new Error('Share exceeds 256 KiB.');
  return result;
}
