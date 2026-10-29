import { cp, mkdir, symlink } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
await cp('contract/schemas', 'dist/contract/schemas', { recursive: true });
// pnpm installs dependencies per source package; preserve that resolution in emitted packages.
for (const name of ['contract', 'engine', 'adapters/in-process', 'adapters/http']) {
  const output = resolve('dist', name);
  await mkdir(output, { recursive: true });
  try { await symlink(relative(output, resolve(name, 'node_modules')), resolve(output, 'node_modules'), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
