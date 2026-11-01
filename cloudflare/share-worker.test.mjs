import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { handleShares, tokenHash } from './share-worker.mjs';
import { validateShare, MAX_SHARE_BYTES } from './share-schema.mjs';
import { emptyPlan, newAnnotation } from '../web/planner/plan.mjs';
import { sharingConfig } from '../scripts/sharing-config.mjs';

const origin = 'https://pullfiction.com';
function snapshot() {
  const plan = emptyPlan(); plan.steps[0].id = 'shared-step';
  return { version: 1, plan, source: { code: 'DyN7vF94QR8aj1Lc', title: 'MC',
    gameVersion: 'vanilla', fight: 'run', map: 409 }, time: 1234, mode: 'analyse', kind: 'replay' };
}
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0001_shares.sql', import.meta.url), 'utf8'));
  const binding = { prepare(sql) { const statement = db.prepare(sql); let values = [];
    return { bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) ?? null; },
      async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; } };
  } };
  const env = { SHARES: binding, SHARE_ORIGIN: origin, SHARE_SITE_KEY: 'public-key', TURNSTILE_SECRET: 'private-secret',
    SHARE_READ_LIMIT: { async limit() { return { success: true }; } },
    SHARE_WRITE_LIMIT: { async limit() { return { success: true }; } } };
  let verification = { success: true, hostname: 'pullfiction.com', action: 'publish_share' };
  let calls = 0;
  const verify = async (url, init) => {
    calls++; assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.body.get('secret'), env.TURNSTILE_SECRET);
    return Response.json(verification);
  };
  function request(path = '', method = 'GET', value, headers = {}) {
    return new Request(`${origin}/api/shares${path}`, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
      ...(value !== undefined ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}) });
  }
  const invoke = (...args) => handleShares(request(...args), env, verify);
  const publish = value => invoke('', 'POST', { snapshot: value ?? snapshot(), turnstileToken: 'verified' });
  return { db, env, invoke, publish, request, verify, get calls() { return calls; },
    setVerification(value) { verification = value; } };
}
test('publish, read and creator-only delete round trip through actual SQLite', async () => {
  const f = setup();
  const response = await f.publish();
  assert.equal(response.status, 201);
  const { id, deleteToken } = await response.json();
  assert.match(id, /^[\w-]{32}$/); assert.match(deleteToken, /^[\w-]{43}$/);
  const stored = f.db.prepare('SELECT * FROM shares').get();
  assert.equal(stored.delete_hash, await tokenHash(deleteToken));
  assert.ok(!JSON.stringify(stored).includes(deleteToken));
  const read = await f.invoke(`/${id}`);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(read.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await read.json(), { snapshot: snapshot() });
  assert.equal((await f.invoke(`/${id}`, 'DELETE')).status, 403);
  assert.equal((await f.invoke(`/${id}`, 'DELETE', undefined, { Authorization: `Bearer ${'x'.repeat(43)}` })).status, 404);
  assert.equal((await f.invoke(`/${id}`, 'DELETE', undefined, { Authorization: `Bearer ${deleteToken}`, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.invoke(`/${id}`, 'DELETE', undefined, { Authorization: `Bearer ${deleteToken}` })).status, 200);
  assert.equal((await f.invoke(`/${id}`)).status, 404);
  assert.equal(f.db.prepare('SELECT used_bytes, published FROM share_budget').get().used_bytes, 0);
  assert.equal(f.db.prepare('SELECT published FROM share_budget').get().published, 1);
});
test('explicit allowlist strips replay, credentials and source cache metadata', () => {
  const value = snapshot();
  value.replay = { events: ['private'] }; value.accessToken = 'secret';
  value.source.cacheKey = 'local'; value.source.token = 'secret';
  value.plan.events = ['private']; value.plan.steps[0].credentials = 'secret';
  assert.deepEqual(validateShare(value), snapshot());
});
test('rendered notes remain text; invalid coordinates, icons, source and workspace are rejected', () => {
  const note = snapshot(); note.plan.steps[0].notes = '<img src=x onerror=alert(1)>';
  assert.equal(validateShare(note).plan.steps[0].notes, note.plan.steps[0].notes);
  for (const mutate of [
    v => v.source.code = '../../private', v => v.source.map = 531,
    v => v.source.gameVersion = 'sod', v => v.source.fight = -1,
    v => v.time = Infinity, v => v.mode = 'script', v => v.kind = 'html',
    v => v.plan.gameVersion = 'unknown',
    v => v.plan.steps[0].annotations = [newAnnotation('circle', [Infinity, 0, 0])],
    v => v.plan.steps[0].snapshot = { report: '', time: 0, actors: [{ key: 'a', name: 'a', class: 'NPC', type: 'NPC', facing: 0, position: [1, 2, 3], icon: 'https://evil.example/x' }] },
  ]) { const value = snapshot(); mutate(value); assert.throws(() => validateShare(value)); }
});
test('server rejects forged, expired, reused, wrong-host and wrong-action verification', async () => {
  const f = setup();
  assert.equal((await f.invoke('', 'POST', { snapshot: snapshot() })).status, 403);
  assert.equal(f.calls, 0);
  for (const verify of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, hostname: 'evil.example', action: 'publish_share' },
    { success: true, hostname: 'pullfiction.com', action: 'other' },
  ]) { f.setVerification(verify); assert.equal((await f.publish()).status, 403); }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shares').get().n, 0);
});
test('rate limiting, origin, missing config and malformed requests fail closed', async () => {
  const f = setup();
  assert.deepEqual(await (await f.invoke('/config')).json(), { enabled: true, siteKey: 'public-key' });
  assert.equal((await f.invoke('', 'POST', '{}', { Origin: 'https://evil.example' })).status, 403);
  assert.equal(f.calls, 0);
  assert.equal((await f.invoke('', 'POST', 'garbage')).status, 400);
  assert.equal((await f.invoke('', 'POST', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.invoke('', 'POST', { snapshot: snapshot(), turnstileToken: 'x' }, { 'Content-Length': String(MAX_SHARE_BYTES + 4097) })).status, 413);
  assert.equal((await f.invoke('', 'POST', 'x'.repeat(MAX_SHARE_BYTES + 4097))).status, 413);
  assert.equal((await f.invoke('/x', 'PUT', '{}')).status, 405);
  assert.equal((await f.invoke('/' + 'x'.repeat(32), 'PUT', '{}')).status, 405);
  f.env.SHARE_WRITE_LIMIT.limit = async () => ({ success: false });
  assert.equal((await f.publish()).status, 429);
  f.env.SHARE_READ_LIMIT.limit = async () => ({ success: false });
  assert.equal((await f.invoke('/' + 'x'.repeat(32))).status, 429);
  delete f.env.TURNSTILE_SECRET;
  assert.equal((await f.publish()).status, 503);
  assert.deepEqual(await (await f.invoke('/config')).json(), { enabled: false });
});
test('database trigger admits only one concurrent publication at the final quota slot', async () => {
  const f = setup();
  f.db.exec('UPDATE share_budget SET max_daily = 1');
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.publish()));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 503).length, 9);
  const budget = f.db.prepare('SELECT * FROM share_budget').get();
  assert.equal(budget.published, 1);
  assert.equal(budget.used_bytes, f.db.prepare('SELECT sum(bytes) AS n FROM shares').get().n);
  f.db.exec("UPDATE share_budget SET day = '2000-01-01'");
  assert.equal((await f.publish()).status, 201);
});
test('storage cap is enforced atomically independently of daily allowance', async () => {
  const f = setup();
  f.db.exec('UPDATE share_budget SET max_bytes = 1');
  const response = await f.publish();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Sharing capacity is full. Try again later.');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shares').get().n, 0);
});
test('database and verification failures return generic errors without secrets', async () => {
  const f = setup();
  f.env.SHARES.prepare = () => { throw new Error('SQL private-secret'); };
  const response = await f.publish();
  assert.equal(response.status, 503); assert.ok(!JSON.stringify(await response.json()).includes('private-secret'));
  const failed = await handleShares(f.request('', 'POST', { snapshot: snapshot(), turnstileToken: 'x' }), f.env, async () => { throw new Error('private-secret'); });
  assert.equal(failed.status, 503);
});
test('Worker routes only sharing API to code; static requests use ASSETS', async () => {
  const response = await worker.fetch(new Request(origin + '/'), { ASSETS: { fetch() { return new Response('static'); } } });
  assert.equal(await response.text(), 'static');
  assert.equal((await worker.fetch(new Request(origin + '/api/shares/config'), {})).status, 200);
});
test('deployment config enables sharing only with complete explicit configuration', () => {
  const base = { main: 'cloudflare/share-worker.mjs', assets: { directory: '.agent/release' } };
  const disabled = sharingConfig(base, '/repo', {});
  assert.equal(disabled.main, '/repo/cloudflare/share-worker.mjs');
  assert.equal(disabled.d1_databases, undefined);
  assert.throws(() => sharingConfig(base, '/repo', { PULLFICTION_SHARE_DATABASE_ID: 'bad' }));
  const enabled = sharingConfig(base, '/repo', { PULLFICTION_SHARE_DATABASE_ID: '12345678-1234-1234-1234-123456789012', PULLFICTION_SHARE_SITE_KEY: 'public-site-key' });
  assert.equal(enabled.d1_databases[0].binding, 'SHARES');
  assert.equal(enabled.ratelimits.length, 2);
  assert.equal(JSON.stringify(enabled).includes('TURNSTILE_SECRET'), false);
});
