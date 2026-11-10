#!/usr/bin/env node
// Fails the build when a workspace package declares or imports a dependency its layer forbids.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ALLOWED, LOCATIONS, TEST_ALLOWED } from '../boundaries.config.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const problems = [];

const isTest = (file) => /(^|\/)(test|tests)\//.test(file) || /\.test\.tsx?$/.test(file);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', 'dist', 'coverage', '.turbo'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

for (const [name, location] of Object.entries(LOCATIONS)) {
  const dir = join(root, location);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    problems.push(`${name}: missing ${location}/package.json`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== name)
    problems.push(`${location}/package.json is named ${pkg.name}, expected ${name}`);

  const allowed = new Set(ALLOWED[name]);
  const testAllowed = new Set([...ALLOWED[name], ...(TEST_ALLOWED[name] ?? [])]);

  // 1. Declared dependencies
  const isDevOnly = (dep) => !(pkg.dependencies ?? {})[dep];
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
    d.startsWith('@near-autopilot/'),
  );
  for (const dep of declared) {
    // test-only extras are accepted only as devDependencies
    if (!allowed.has(dep) && !(testAllowed.has(dep) && isDevOnly(dep)))
      problems.push(`${name}: package.json depends on ${dep}, which its layer forbids`);
  }

  // 2. Actual imports
  for (const file of walk(dir)) {
    const rel = relative(root, file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)['"](@near-autopilot\/[a-z-]+)(\/[a-z-]+)?['"]/g,
    )) {
      const [, dep, sub] = match;
      const permitted = isTest(rel) ? testAllowed : allowed;
      if (dep !== name && !permitted.has(dep))
        problems.push(
          `${rel}: imports ${dep}, forbidden for ${name}${isTest(rel) ? '' : ' (production code)'}`,
        );
      if (sub === '/testing' && !isTest(rel))
        problems.push(
          `${rel}: test doubles (${dep}/testing) must not be imported by production code`,
        );
      if (sub === '/hash' && name === '@near-autopilot/analytics')
        problems.push(`${rel}: node-only ${dep}/hash must not be imported by the analytics UI`);
    }
    if (name === '@near-autopilot/analytics' && !isTest(rel) && /from\s+['"]node:/.test(source)) {
      problems.push(`${rel}: analytics UI must not import node: builtins directly`);
    }
    if (
      name === '@near-autopilot/core' &&
      /from\s+['"]node:/.test(source) &&
      !rel.endsWith('src/hash.ts') &&
      !rel.endsWith('/testing.ts')
    ) {
      problems.push(`${rel}: core must stay isomorphic; node: imports are only allowed in hash.ts`);
    }
  }
}

// 3. No cycles in the declared graph
const visiting = new Set();
const done = new Set();
function visit(node, path) {
  if (done.has(node)) return;
  if (visiting.has(node)) {
    problems.push(`dependency cycle: ${[...path, node].join(' -> ')}`);
    return;
  }
  visiting.add(node);
  for (const next of ALLOWED[node] ?? []) visit(next, [...path, node]);
  visiting.delete(node);
  done.add(node);
}
for (const node of Object.keys(ALLOWED)) visit(node, []);

if (problems.length > 0) {
  console.error(`Dependency boundary violations (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Dependency boundaries OK (${Object.keys(LOCATIONS).length} packages checked).`);
