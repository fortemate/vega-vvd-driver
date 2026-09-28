// The Device class against a fake EmulatorController on localhost: what goes
// over the wire, deadlines, cancellation, how `vvd frames` saves what it
// captures, and where the token may not go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { saveFrames } from '../src/cli.ts';
import { Device, TimeoutError, type Frame } from '../src/device.ts';
import { encodePng } from '../src/png.ts';
import {
  PROTO_DIR,
  startFakeEmulator,
  TOKEN,
  type Screen,
} from './fakeEmulator.ts';

const withDevice = async (
  screen: Screen,
  body: (
    device: Device,
    fake: Awaited<ReturnType<typeof startFakeEmulator>>,
  ) => Promise<void>,
  callTimeoutMs?: number,
) => {
  const fake = await startFakeEmulator(screen);
  const device = Device.connect({
    directories: [fake.directory],
    protoDirectory: PROTO_DIR,
    callTimeoutMs,
  });
  try {
    await body(device, fake);
  } finally {
    device.close();
    fake.stop();
  }
};

test('keys go over as evdev codes, with the bearer token', () =>
  withDevice('changing', async (device, fake) => {
    await device.press(['ok', 'back:down'], { gapMs: 0, holdMs: 0 });
    assert.deepEqual(fake.keys, [
      { eventType: 'keydown', keyCode: 96 },
      { eventType: 'keyup', keyCode: 96 },
      { eventType: 'keydown', keyCode: 158 },
    ]);
    assert.ok(fake.authorizations.every((a) => a === `Bearer ${TOKEN}`));
  }));

test('a cancelled press stops, and never leaves a key held down', () =>
  withDevice('changing', async (device, fake) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      device.press(['right*50'], {
        gapMs: 20,
        holdMs: 30,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    const downs = fake.keys.filter((k) => k.eventType === 'keydown').length;
    const ups = fake.keys.filter((k) => k.eventType === 'keyup').length;
    assert.ok(downs > 0 && downs < 50, `${downs} presses before the abort`);
    assert.equal(ups, downs);
  }));

test('a device that never answers fails at the deadline instead of hanging', () =>
  withDevice(
    'silent',
    async (device) => {
      const started = Date.now();
      await assert.rejects(device.screenshot('rgb'), TimeoutError);
      await assert.rejects(
        device.waitForChange({ timeoutMs: 100 }),
        TimeoutError,
      );
      assert.ok(Date.now() - started < 3000);
    },
    300,
  ));

test('waitForChange tells a still screen from a changing one', async () => {
  await withDevice('still', async (device) => {
    assert.equal(
      await device.waitForChange({ timeoutMs: 200, intervalMs: 20 }),
      false,
    );
  });
  await withDevice('changing', async (device) => {
    assert.equal(await device.waitForChange({ timeoutMs: 2000 }), true);
  });
});

test('frames gives each distinct frame once and ends on time', () =>
  withDevice('changing', async (device) => {
    const started = Date.now();
    const seen: number[] = [];
    const count = await device.frames(300, (frame) => {
      seen.push(frame.data[0]);
    });
    assert.equal(count, seen.length);
    assert.ok(count > 1);
    // Each frame differs from the one before it.
    assert.ok(seen.every((shade, i) => i === 0 || shade !== seen[i - 1]));
    assert.ok(Date.now() - started < 1500);
  }));

test('frames stops after maxFrames distinct frames', () =>
  withDevice('changing', async (device, fake) => {
    const started = Date.now();
    assert.equal(await device.frames(10_000, () => {}, { maxFrames: 5 }), 5);
    assert.equal(fake.screenshots, 5);
    assert.ok(Date.now() - started < 1500);
  }));

test('frames refuses a maxFrames that is not a whole number from 1', () =>
  withDevice('changing', async (device, fake) => {
    let delivered = 0;
    const onFrame = () => {
      delivered += 1;
    };
    for (const maxFrames of [0, -1, 1.5, Number.NaN])
      await assert.rejects(
        device.frames(1000, onFrame, { maxFrames }),
        RangeError,
      );
    assert.equal(delivered, 0);
    assert.equal(fake.screenshots, 0);
  }));

// About as long as encodePng takes for a 1080p frame of a board game.
const ENCODE_MS = 25;

test('vvd frames encodes nothing until the capture is over', () =>
  withDevice('changing', async (device, fake) => {
    const dir = mkdtempSync(join(tmpdir(), 'vvd-frames-'));
    const started = Date.now();
    let captureMs: number | undefined;
    let looks: number | undefined;
    const encode = (width: number, height: number, rgb: Buffer) => {
      captureMs ??= Date.now() - started;
      looks ??= fake.screenshots;
      // Blocks the thread, as encodePng does.
      const until = Date.now() + ENCODE_MS;
      while (Date.now() < until);
      return encodePng(width, height, rgb);
    };
    const result = await saveFrames(device, dir, {
      durationMs: 10_000,
      maxFrames: 30,
      encode,
    });
    assert.deepEqual(result, { count: 30, stopped: 'max-frames' });
    // Every screenshot was taken before the first frame was encoded, so the
    // capture went at the device's pace. With the encoder between the
    // screenshots, 30 frames would have taken 29 * 25 ms.
    assert.equal(looks, fake.screenshots);
    assert.ok(
      captureMs !== undefined && captureMs < (29 * ENCODE_MS) / 2,
      `${captureMs} ms to capture 30 frames`,
    );
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 30);
    // Named by the emulator's clock from the first frame, 1/60 s apart here.
    assert.deepEqual(files.slice(0, 4), [
      'frame-000000ms.png',
      'frame-000017ms.png',
      'frame-000033ms.png',
      'frame-000050ms.png',
    ]);
  }));

test('vvd frames saves a still screen as one frame', () =>
  withDevice('still', async (device) => {
    const dir = mkdtempSync(join(tmpdir(), 'vvd-frames-'));
    assert.deepEqual(await saveFrames(device, dir, { durationMs: 200 }), {
      count: 1,
      stopped: undefined,
    });
    assert.deepEqual(readdirSync(dir), ['frame-000000ms.png']);
  }));

test('vvd frames stops before the frames it holds pass the memory budget', () =>
  withDevice('changing', async (device, fake) => {
    const dir = mkdtempSync(join(tmpdir(), 'vvd-frames-'));
    // Room for five of the fake's 16x16 frames, 768 bytes each.
    const result = await saveFrames(device, dir, {
      durationMs: 10_000,
      maxBytes: 5 * 768,
    });
    assert.deepEqual(result, { count: 5, stopped: 'memory' });
    // The sixth frame did not fit: it was taken, not kept, and the capture
    // stopped there with the five it had.
    assert.equal(fake.screenshots, 6);
    assert.equal(readdirSync(dir).length, 5);
  }));

test('vvd frames checks each frame against the memory budget, however large', async () => {
  // The fake emulator's frames never change size, so a stand-in device
  // delivers two 16x16 frames and then larger 16x32 ones.
  let delivered = 0;
  const growing = {
    frames: async (
      _durationMs: number,
      onFrame: (frame: Frame) => void | Promise<void>,
      options: { signal?: AbortSignal } = {},
    ) => {
      for (const height of [16, 16, 32, 32]) {
        options.signal?.throwIfAborted();
        delivered += 1;
        await onFrame({
          width: 16,
          height,
          data: Buffer.alloc(16 * height * 3, delivered),
          timestampUs: delivered * 16_667,
        });
      }
      return delivered;
    },
  } as unknown as Device;
  const dir = mkdtempSync(join(tmpdir(), 'vvd-frames-'));
  // Room for three small frames, but not for two small and a large one.
  const result = await saveFrames(growing, dir, {
    durationMs: 10_000,
    maxBytes: 3 * 768,
  });
  assert.deepEqual(result, { count: 2, stopped: 'memory' });
  assert.equal(delivered, 3);
  assert.equal(readdirSync(dir).length, 2);
});

test('a failing device fails the call with its reason', () =>
  withDevice({ failAfter: 1 }, async (device) => {
    await device.screenshot('rgb');
    await assert.rejects(device.screenshot('rgb'), /the emulator went away/);
  }));

test('the audio stream delivers timed packets until stopped', () =>
  withDevice('changing', async (device) => {
    const stop = device.listen();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const packets = stop();
    assert.ok(packets.length > 3);
    assert.ok(packets[0].timestampUs > 0);
    assert.equal(stop(), packets); // stopping again is harmless
  }));

test('the token stays out of JSON, inspect and spreads', () =>
  withDevice('changing', async (device) => {
    assert.equal(device.emulator.grpcToken, TOKEN);
    assert.ok(!JSON.stringify(device.emulator).includes(TOKEN));
    assert.ok(!JSON.stringify({ ...device.emulator }).includes(TOKEN));
    assert.ok(!inspect(device, { depth: 10 }).includes(TOKEN));
  }));
