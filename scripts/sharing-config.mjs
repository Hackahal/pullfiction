// Generate a deployment config without committing an account-specific database ID.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
export function sharingConfig(base, root, env) {
  const config = structuredClone(base);
  config.main = resolve(root, base.main);
  config.assets.directory = resolve(root, base.assets.directory);
  const id = env.PULLFICTION_SHARE_DATABASE_ID;
  const siteKey = env.PULLFICTION_SHARE_SITE_KEY;
  if (!id && !siteKey) return config;
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ||
      !siteKey || !/^[A-Za-z0-9_-]{10,100}$/.test(siteKey))
    throw new Error('Set both PULLFICTION_SHARE_DATABASE_ID and PULLFICTION_SHARE_SITE_KEY to valid values.');
  config.d1_databases = [{ binding: 'SHARES', database_name: 'pullfiction-shares', database_id: id,
    migrations_dir: resolve(root, 'cloudflare/migrations') }];
  config.vars = { SHARE_ORIGIN: 'https://pullfiction.com', SHARE_SITE_KEY: siteKey };
  config.ratelimits = [
    { name: 'SHARE_READ_LIMIT', namespace_id: '1001', simple: { limit: 120, period: 60 } },
    { name: 'SHARE_WRITE_LIMIT', namespace_id: '1002', simple: { limit: 5, period: 60 } },
  ];
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const base = JSON.parse((await readFile(resolve(root, 'wrangler.static.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  const output = resolve(root, '.agent/work/sharing-deploy.json');
  const config = sharingConfig(base, root, process.env);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(config, null, 2));
  process.stdout.write(output);
}
