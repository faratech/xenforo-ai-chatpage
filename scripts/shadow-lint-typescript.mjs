/**
 * typescript-eslint needs the TypeScript JS compiler API, which the
 * native typescript@7 package no longer ships (its peer range caps at
 * <6.1.0). The root `typescript` stays on 7 as the project compiler;
 * this postinstall step points the lint toolchain's `typescript`
 * resolution at the `typescript-lint` alias (typescript@6) by planting
 * a nested node_modules/typescript symlink beside each consumer.
 *
 * Consumers are located by scanning node_modules (several of them use
 * `exports` maps that block require.resolve of their package.json).
 * Idempotent; safe to re-run. Remove together with the `typescript-lint`
 * devDependency once typescript-eslint supports TypeScript 7.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootModules = path.join(projectRoot, 'node_modules');

const CONSUMERS = new Set([
  'typescript-eslint',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  '@typescript-eslint/type-utils',
  '@typescript-eslint/typescript-estree',
  '@typescript-eslint/utils',
  'ts-api-utils',
]);

const lintTypescriptDir = path.join(rootModules, 'typescript-lint');
if (!existsSync(lintTypescriptDir)) {
  // A production install (`npm ci --omit=dev`) has no lint toolchain at all.
  // Failing postinstall there broke the whole install rather than just lint;
  // skip quietly instead — this script only matters for `npm run lint`.
  console.log(
    'Lint toolchain typescript shadow: typescript-lint not installed '
    + '(dev-only tooling absent); skipping.',
  );
  process.exit(0);
}
if (!existsSync(path.join(lintTypescriptDir, 'lib', 'typescript.js'))) {
  // The alias directory exists but is incomplete — a dev-install anomaly that
  // must stay loud.
  throw new Error('typescript-lint alias does not ship the JS compiler API; lint would break.');
}

/** Finds every installed copy of the consumer packages, nested or hoisted. */
async function findConsumerDirs(modulesDir, depth, found) {
  if (depth > 8 || !existsSync(modulesDir)) return;
  let entries;
  try {
    entries = await readdir(modulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const entryPath = path.join(modulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = await readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) {
        if (!inner.isDirectory()) continue;
        const packageName = `${entry.name}/${inner.name}`;
        const packageDir = path.join(entryPath, inner.name);
        if (CONSUMERS.has(packageName)) found.add(packageDir);
        await findConsumerDirs(path.join(packageDir, 'node_modules'), depth + 1, found);
      }
    } else {
      if (CONSUMERS.has(entry.name)) found.add(entryPath);
      await findConsumerDirs(path.join(entryPath, 'node_modules'), depth + 1, found);
    }
  }
}

const consumerDirs = new Set();
await findConsumerDirs(rootModules, 0, consumerDirs);

let planted = 0;
for (const consumerDir of consumerDirs) {
  const shadowParent = path.join(consumerDir, 'node_modules');
  const shadowLink = path.join(shadowParent, 'typescript');
  await mkdir(shadowParent, { recursive: true });

  try {
    const existing = await lstat(shadowLink);
    if (existing.isSymbolicLink() && await readlink(shadowLink) === lintTypescriptDir) {
      continue; // Already correct.
    }
    await rm(shadowLink, { recursive: true, force: true });
  } catch {
    // No existing entry.
  }

  await symlink(lintTypescriptDir, shadowLink, 'junction');
  planted += 1;
}

if (consumerDirs.size === 0) {
  throw new Error('No lint toolchain packages found to shadow; is the install broken?');
}

console.log(
  `Lint toolchain typescript shadow: ${consumerDirs.size} consumer dir(s), `
  + `${planted} link(s) updated → TypeScript 6 JS API at ${path.relative(projectRoot, lintTypescriptDir)}.`,
);
