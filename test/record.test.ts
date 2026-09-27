// How a recording ends when something goes wrong: record() must settle, stop
// ffmpeg and clean up, whatever fails. A shell script stands in for ffmpeg and
// a plain object for the device, so no device and no ffmpeg are needed; the
// last test uses the real ffmpeg when there is one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AudioPacket, Device } from '../src/device.ts';
import { record } from '../src/record.ts';

const realPath = process.env.PATH;
const bin = mkdtempSync(join(tmpdir(), 'vvd-fake-ffmpeg-'));
const pidFile = join(bin, 'pids');
// FAKE_FFMPEG=fail exits at once with an error; otherwise the script reads its
// input to the end, as the encoder does. Each run notes its pid.
writeFileSync(
  join(bin, 'ffmpeg'),
  [
    '#!/bin/sh',
    '[ "$1" = "-version" ] && exit 0',
    `echo $$ >> '${pidFile}'`,
    'if [ "$FAKE_FFMPEG" = fail ]; then echo "Unknown encoder libx264" >&2; exit 1; fi',
    'exec cat > /dev/null',
    '',
  ].join('\n'),
);
chmodSync(join(bin, 'ffmpeg'), 0o755);
process.env.PATH = `${bin}:${realPath}`;

const out = () => join(mkdtempSync(join(tmpdir(), 'vvd-out-')), 'take.mp4');

// A device whose screen changes at every look; `failAt` makes that screenshot
// and the ones after it fail.
const fakeDevice = (failAt?: number) => {
  let shots = 0;
  const device = {
    shots: () => shots,
    screenshot: async () => {
      shots += 1;
      if (failAt !== undefined && shots >= failAt)
        throw new Error('the emulator went away');
      await new Promise((done) => setTimeout(done, 5));
      return {
        width: 16,
        height: 16,
        data: Buffer.alloc(16 * 16 * 3, shots % 256),
        timestampUs: shots,
      };
    },
    listen: (): (() => AudioPacket[]) => () => [],
  };
  return device as typeof device & Device;
};

const workDirs = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('vvd-record-'));

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Every fake ffmpeg started so far has ended.
const noEncoderLeft = () => {
  const pids = existsSync(pidFile)
    ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
    : [];
  assert.deepEqual(pids.filter(isRunning), []);
};

const clean = async (body: () => Promise<void>) => {
  const before = workDirs();
  delete process.env.FAKE_FFMPEG;
  await body();
  noEncoderLeft();
  assert.deepEqual(workDirs(), before);
};

test('an ffmpeg that fails at once is reported, not a crash', () =>
  clean(async () => {
    process.env.FAKE_FFMPEG = 'fail';
    await assert.rejects(
      record(fakeDevice(), { file: out(), seconds: 3, audio: false }),
      /ffmpeg exited with 1: Unknown encoder libx264/,
    );
  }));

test('a device that fails mid-recording stops the recording and ffmpeg', () =>
  clean(async () => {
    const started = Date.now();
    await assert.rejects(
      record(fakeDevice(5), { file: out(), seconds: 5, audio: false }),
      /the emulator went away/,
    );
    assert.ok(Date.now() - started < 3000);
  }));

test('onStart runs alongside the recording, which waits for it', () =>
  clean(async () => {
    const device = fakeDevice();
    const file = out();
    let during = 0;
    let finished = false;
    const result = await record(device, {
      file,
      seconds: 1,
      audio: false,
      onStart: async () => {
        const at = device.shots();
        await new Promise((done) => setTimeout(done, 1300));
        during = device.shots() - at;
        finished = true;
      },
    });
    assert.ok(finished);
    assert.ok(during > 10, `${during} screenshots while onStart ran`);
    assert.equal(result.file, resolve(file));
    assert.equal(result.frames, 30);
  }));

test('an onStart that throws ends the recording with its error', () =>
  clean(async () => {
    const started = Date.now();
    await assert.rejects(
      record(fakeDevice(), {
        file: out(),
        seconds: 5,
        audio: false,
        onStart: async () => {
          await new Promise((done) => setTimeout(done, 100));
          throw new Error('the script broke');
        },
      }),
      /the script broke/,
    );
    assert.ok(Date.now() - started < 3000);
  }));

test('an abort stops the recording at once', () =>
  clean(async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(
      record(fakeDevice(), {
        file: out(),
        seconds: 5,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.ok(Date.now() - started < 3000);
  }));

test('a directory that cannot be written fails before anything is recorded', async () => {
  const device = fakeDevice();
  await assert.rejects(
    record(device, { file: '/no-such-dir-for-vvd/take.mp4', seconds: 1 }),
    /cannot write to \/no-such-dir-for-vvd/,
  );
  assert.equal(device.shots(), 0);
});

const realFfmpeg =
  spawnSync('ffmpeg', ['-version'], { env: { PATH: realPath } }).status === 0;

test(
  'with the real ffmpeg, the video is as long as asked, sound included',
  { skip: !realFfmpeg && 'ffmpeg is not installed' },
  async () => {
    process.env.PATH = realPath;
    try {
      const file = out();
      const device = fakeDevice();
      device.listen = () => () => [
        { timestampUs: Date.now() * 1000, pcm: Buffer.alloc(4 * 4410, 1) },
      ];
      const result = await record(device, { file, seconds: 1, fps: 10 });
      assert.equal(result.frames, 10);
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type',
          '-of',
          'csv=p=0',
          file,
        ],
        { encoding: 'utf8' },
      );
      if (probe.status === 0)
        assert.deepEqual(probe.stdout.trim().split('\n').sort(), [
          'audio',
          'video',
        ]);
      else assert.ok(existsSync(file));
    } finally {
      process.env.PATH = `${bin}:${realPath}`;
    }
  },
);
