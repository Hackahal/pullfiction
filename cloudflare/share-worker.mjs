import { MAX_SHARE_BYTES, SHARE_ID, DELETE_TOKEN, validateShare } from './share-schema.mjs';

const ACTION = 'publish_share';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} });
const random = length => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length))))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export async function tokenHash(token) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
async function body(request, limit) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    fail(415, 'Expected application/json.');
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'Share is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing request body.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, 'Share is too large.'); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { fail(400, 'Invalid JSON.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'Expected a JSON object.');
  return value;
}
function origin(env) {
  try {
    const url = new URL(env.SHARE_ORIGIN);
    if (url.origin !== env.SHARE_ORIGIN || !['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch { return null; }
}

export async function handleShares(request, env, verifyFetch = fetch) {
  try {
    const url = new URL(request.url);
    const configuredOrigin = origin(env);
    const enabled = Boolean(configuredOrigin && env.SHARES && env.SHARE_READ_LIMIT && env.SHARE_WRITE_LIMIT &&
      env.TURNSTILE_SECRET && env.SHARE_SITE_KEY);
    if (url.pathname === '/api/shares/config' && request.method === 'GET')
      return json(enabled ? { enabled: true, siteKey: env.SHARE_SITE_KEY } : { enabled: false });
    if (!enabled) fail(503, 'Sharing is not configured on this deployment.');
    if (url.origin !== configuredOrigin.origin) fail(403, 'Invalid sharing origin.');
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const limiter = request.method === 'GET' ? env.SHARE_READ_LIMIT : env.SHARE_WRITE_LIMIT;
    if (!(await limiter.limit({ key: ip })).success) fail(429, 'Too many sharing requests. Try again later.');
    const match = url.pathname.match(/^\/api\/shares\/([A-Za-z0-9_-]{32})$/);
    if (request.method === 'GET' && match) {
      const row = await env.SHARES.prepare('SELECT payload FROM shares WHERE id = ?').bind(match[1]).first();
      if (!row) fail(404, 'Shared plan not found. It may have been deleted.');
      return json({ snapshot: JSON.parse(row.payload) });
    }
    if (!['POST', 'DELETE'].includes(request.method)) fail(405, 'Method not allowed.');
    // CORS is not authentication. Origin checks complement Turnstile and the
    // deletion capability; they cannot stop a non-browser caller by themselves.
    if (request.headers.get('Origin') !== configuredOrigin.origin) fail(403, 'Invalid sharing origin.');
    if (request.method === 'POST' && url.pathname === '/api/shares') {
      const value = await body(request, MAX_SHARE_BYTES + 4096);
      if (typeof value.turnstileToken !== 'string' || !value.turnstileToken || value.turnstileToken.length > 2048)
        fail(403, 'Complete the sharing verification.');
      const response = await verifyFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET,
          response: value.turnstileToken, remoteip: ip }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) fail(503, 'Sharing verification is unavailable.');
      const verification = await response.json();
      if (verification.success !== true || verification.hostname !== configuredOrigin.hostname || verification.action !== ACTION)
        fail(403, 'Sharing verification failed. Try again.');
      let snapshot;
      try { snapshot = validateShare(value.snapshot); }
      catch { fail(400, 'Invalid plan or Warcraft Logs reference. Shares must be at most 256 KiB.'); }
      const payload = JSON.stringify(snapshot);
      const id = random(24), deleteToken = random(32);
      try {
        await env.SHARES.prepare('INSERT INTO shares (id, payload, bytes, delete_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, payload, new TextEncoder().encode(payload).byteLength, await tokenHash(deleteToken), Date.now()).run();
      } catch (error) {
        if (String(error).includes('share_capacity')) fail(503, 'Sharing capacity is full. Try again later.');
        throw error;
      }
      return json({ id, deleteToken }, 201);
    }
    if (request.method === 'DELETE' && match) {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!DELETE_TOKEN.test(token ?? '')) fail(403, 'Missing or invalid deletion token.');
      const result = await env.SHARES.prepare('DELETE FROM shares WHERE id = ? AND delete_hash = ?')
        .bind(match[1], await tokenHash(token)).run();
      if (!result.meta.changes) fail(404, 'Shared plan or deletion token not found.');
      return json({ deleted: true });
    }
    fail(404, 'Sharing endpoint not found.');
  } catch (error) {
    // Never echo SQL, credentials, content or platform diagnostics to callers.
    return json({ error: error.status ? error.message : 'Sharing is temporarily unavailable.' }, error.status ?? 503);
  }
}
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/shares' || path.startsWith('/api/shares/')) return handleShares(request, env);
    return env.ASSETS.fetch(request);
  },
};
