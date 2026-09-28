// The commands that drive a device, run as `vvd` is run, as a process,
// against the fake EmulatorController: its discovery file goes where an
// emulator's would, in a home of its own, and VVD_PROTO_DIR points at the
// fake proto. The fake answers from this process, so `vvd` runs alongside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png.ts';
import {
  PROTO_DIR,
  startFakeEmulator,
  TOKEN,
  type FakeEmulator,
  type Screen,
} from './fakeEmulator.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts');

type Run = { status: number; stdout: string; stderr: string };

// Runs `vvd` with `args` against a fake emulator that shows `screen`, and
// gives its exit status and output, whatever the status.
const vvd = async (
  screen: Screen,
  args: string[],
  check?: (fake: FakeEmulator) => void,
): Promise<Run> => {
  const fake = await startFakeEmulator(screen);
  const home = mkdtempSync(join(tmpdir(), 'vvd-home-'));
  const running = join(home, '.android/avd/running');
  mkdirSync(running, { recursive: true });
  copyFileSync(fake.file, join(running, basename(fake.file)));
  try {
    const run = await new Promise<Run>((resolve) =>
      execFile(
        process.execPath,
        [BIN, ...args],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            XDG_RUNTIME_DIR: '',
            VVD_PROTO_DIR: PROTO_DIR,
          },
        },
        (error, stdout, stderr) =>
          resolve({
            status: error ? Number(error.code) : 0,
            stdout,
            stderr,
          }),
      ),
    );
    // The token reaches the emulator and nothing else.
    assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
    check?.(fake);
    return run;
  } finally {
    fake.stop();
  }
};

const out = () => mkdtempSync(join(tmpdir(), 'vvd-out-'));

test('devices lists the running device', async () => {
  const run = await vvd('still', ['devices']);
  assert.equal(run.status, 0);
  assert.match(
    run.stdout,
    new RegExp(`^pid ${process.pid} {2}grpc \\d+ {2}console 5554 {2}fake\\n$`),
  );
});

test('press sends each key down and up', async () => {
  const run = await vvd(
    'still',
    ['press', 'ok', 'down*2', '--gap', '0'],
    (fake) =>
      assert.deepEqual(
        fake.keys.map((k) => `${k.eventType} ${k.keyCode}`),
        [
          'keydown 96',
          'keyup 96',
          'keydown 108',
          'keyup 108',
          'keydown 108',
          'keyup 108',
        ],
      ),
  );
  assert.equal(run.status, 0);
});

test('screenshot writes the screen to the file it names', async () => {
  const file = join(out(), 'shot.png');
  const run = await vvd('still', ['screenshot', file]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${file}\n`);
  // The fake's picture, 16x16 of shade 7, as the PNG the emulator sends: a
  // command that asked for RGB would have written the raw bytes instead.
  const png = readFileSync(file);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.deepEqual(png, encodePng(16, 16, Buffer.alloc(16 * 16 * 3, 7)));
});

test('frames saves the frames and says what stopped it', async () => {
  const dir = join(out(), 'frames');
  const run = await vvd('changing', [
    'frames',
    dir,
    '--seconds',
    '5',
    '--max-frames',
    '4',
  ]);
  assert.equal(run.status, 0);
  assert.equal(
    run.stdout,
    `4 distinct frames in ${dir}: stopped at --max-frames 4 before the 5 s were up\n`,
  );
  assert.equal(readdirSync(dir).length, 4);
});

test('wait-change exits 0 on a change and 1 on a timeout', async () => {
  const changed = await vvd('changing', ['wait-change', '--timeout', '2000']);
  assert.deepEqual([changed.status, changed.stdout], [0, 'changed\n']);
  const still = await vvd('still', ['wait-change', '--timeout', '300']);
  assert.deepEqual([still.status, still.stdout], [1, 'no change\n']);
});

test('safe-area exits 0 when the margin is clear and 1 when it is not', async () => {
  const clear = await vvd('still', ['safe-area']);
  assert.equal(clear.status, 0);
  assert.match(clear.stdout, /^clear: .*\(background #070707\)\n$/);
  const red = await vvd('still', ['safe-area', '--background', '#ff0000']);
  assert.equal(red.status, 1);
  assert.match(red.stdout, /^NOT clear: left=\d+/);
});

test('a device that fails fails the command with exit status 2', async () => {
  const run = await vvd({ failAfter: 0 }, ['screenshot', join(out(), 'x.png')]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^vvd: .*the emulator went away/);
});
