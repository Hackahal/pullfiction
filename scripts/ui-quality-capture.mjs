// Import in the supported, persistent Codex browser REPL after binding a tab.
// A screenshot still needs visual verification before it is registered/scored.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function capture(tab, directory, id, expectedText = '') {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Use a simple capture ID');
  try {
    await access(join(directory, 'seal.json'));
    throw new Error('Round is sealed; choose a new output directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { state, screenshot } = await tab.getAXStateAndScreenshot({
    emit: false,
    disableDiffing: true,
  });
  if (!screenshot) throw new Error('No browser screenshot returned');
  if (/\?(?:[^\s]*&)?code=/.test(state))
    throw new Error('Finish the authorization callback before recording evidence');
  if (expectedText && !state.includes(expectedText))
    throw new Error(`Expected UI is not present: ${expectedText}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}.jpg`);
  await writeFile(path, screenshot, { flag: 'wx' });
  await writeFile(join(directory, `${id}.ax.txt`), state, { flag: 'wx' });
  return { id, path, bytes: screenshot.length, visualVerificationRequired: true };
}
