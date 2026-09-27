// The repository is English-only, like every Fortemate repository. A check
// cannot tell one Cyrillic language from another, and nothing here needs that
// script, so no Cyrillic at all is allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The Unicode script property covers every Cyrillic block, the extended ones
// included, and keeps this file free of what it looks for.
const CYRILLIC = /\p{Script=Cyrillic}/u;

test('no text file in the repository contains Cyrillic', () => {
  // Tracked files, and new files that are not ignored, so a mistake is caught
  // before it is committed as well as in CI.
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const found: string[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(ROOT, file));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (bytes.includes(0)) continue; // binary
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        if (CYRILLIC.test(line)) found.push(`${file}:${index + 1}`);
      });
  }
  assert.deepEqual(found, [], 'this repository is English-only');
});
