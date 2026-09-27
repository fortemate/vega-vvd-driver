// The Device class against a fake EmulatorController on localhost: what goes
// over the wire, deadlines, cancellation, and where the token may not go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Device, TimeoutError } from '../src/device.ts';
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
