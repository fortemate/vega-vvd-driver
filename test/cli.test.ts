import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.equal(
    parseCli(['frames', 'out', '--max-frames', '50']).values['max-frames'],
    '50',
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
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown key "okk"/);
});

test('a bad --max-frames fails before a directory is made or a device looked for', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vvd-frames-')), 'out');
  const result = spawnSync(
    process.execPath,
    [BIN, 'frames', dir, '--max-frames', '0'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--max-frames must be a whole number from 1/);
  assert.equal(existsSync(dir), false);
});

test('an unknown command says how to get help', () => {
  const result = spawnSync(process.execPath, [BIN, 'dance'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /vvd --help/);
});

test('an error exits 2, so that scripts can tell it from "no change"', () => {
  // A home without a device, so that none is found even where one runs.
  const env = {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), 'vvd-home-')),
    XDG_RUNTIME_DIR: '',
  };
  const result = spawnSync(process.execPath, [BIN, 'wait-change'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /enable-grpc/);
});

test('enable-grpc refuses --pid and a port that no console has', () => {
  const pid = spawnSync(process.execPath, [BIN, 'enable-grpc', '--pid', '1'], {
    encoding: 'utf8',
  });
  assert.equal(pid.status, 2);
  assert.match(pid.stderr, /--console-port/);
  const port = spawnSync(
    process.execPath,
    [BIN, 'enable-grpc', '--console-port', '5555'],
    { encoding: 'utf8' },
  );
  assert.equal(port.status, 2);
  assert.match(port.stderr, /even number/);
});
