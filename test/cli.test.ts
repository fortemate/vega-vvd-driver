import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numberOption, parseCli, USAGE } from '../src/cli.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts');

test('the command comes first, then its arguments and options', () => {
  const parsed = parseCli([
    'press',
    'down*2',
    'ok',
    '--gap',
    '300',
    '--pid',
    '42',
  ]);
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['down*2', 'ok']);
  assert.equal(parsed.values.gap, '300');
  assert.equal(parsed.values.pid, '42');
  assert.equal(
    parseCli(['record', 'a.mp4', '--no-audio']).values['no-audio'],
    true,
  );
});

test('unknown options are refused', () => {
  assert.throws(() => parseCli(['press', 'ok', '--speed', '2']));
});

test('number options are checked', () => {
  assert.equal(numberOption(undefined, 'gap', 450), 450);
  assert.equal(numberOption('300', 'gap', 450), 300);
  assert.equal(numberOption('0.5', 'seconds', 10, { integer: false }), 0.5);
  assert.throws(() => numberOption('abc', 'gap', 450), /--gap/);
  assert.throws(() => numberOption('1.5', 'fps', 30), /whole number/);
  assert.throws(
    () => numberOption('70000', 'port', 8554, { max: 65535 }),
    /65535/,
  );
});

test('--help and --version work without a device', () => {
  assert.equal(
    execFileSync(process.execPath, [BIN, '--help'], {
      encoding: 'utf8',
    }).trim(),
    USAGE.trim(),
  );
  assert.match(
    execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }),
    /^\d+\.\d+\.\d+/,
  );
});

test('a typo in a key fails before any device is looked for', () => {
  const result = spawnSync(process.execPath, [BIN, 'press', 'okk'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown key "okk"/);
});

test('an unknown command says how to get help', () => {
  const result = spawnSync(process.execPath, [BIN, 'dance'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /vvd --help/);
});
