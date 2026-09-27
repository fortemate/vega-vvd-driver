// Against a real, running Vega Virtual Device. Skipped unless VVD_INTEGRATION=1,
// so CI, which has no device, passes over it:
//
//   vega virtual-device start --no-gui && npx vvd enable-grpc && npm run test:device
//
// It presses left and right on whatever is on screen, so run it on the launcher
// or on an app you do not mind moving around in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Device } from '../src/device.ts';
import { createServer } from '../src/mcp.ts';
import { hasFfmpeg, record } from '../src/record.ts';

const skip =
  process.env.VVD_INTEGRATION !== '1' &&
  'set VVD_INTEGRATION=1 with a running VVD';

test('screenshots come back as 1080p PNG and RGB', { skip }, async () => {
  const device = Device.connect();
  try {
    const png = await device.screenshot('png');
    assert.deepEqual([...png.data.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    const rgb = await device.screenshot('rgb');
    assert.equal(rgb.width, 1920);
    assert.equal(rgb.height, 1080);
    assert.equal(rgb.data.length, 1920 * 1080 * 3);
  } finally {
    device.close();
  }
});

test(
  'a key press changes the screen, and frames see it',
  { skip },
  async () => {
    const device = Device.connect();
    try {
      const seen = device.frames(2500, () => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      await device.press(['right', 'left'], { gapMs: 300 });
      assert.ok((await seen) >= 2, 'at least the screen before and after');
    } finally {
      device.close();
    }
  },
);

test('a short recording is a playable MP4', { skip }, async (t) => {
  if (!(await hasFfmpeg())) return t.skip('no ffmpeg');
  const device = Device.connect();
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'vvd-test-')), 'clip.mp4');
    const result = await record(device, { file, seconds: 2 });
    assert.ok(existsSync(file) && statSync(file).size > 0);
    assert.equal(result.frames, 60);
  } finally {
    device.close();
  }
});

test(
  'an agent can press keys and see the result through MCP',
  { skip },
  async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    try {
      const result = await client.callTool({
        name: 'press_keys',
        arguments: { keys: ['right', 'left'], screenshot_after: true },
      });
      const content = result.content as { type: string; mimeType?: string }[];
      assert.equal(result.isError, undefined);
      assert.equal(content[1].type, 'image');
      assert.equal(content[1].mimeType, 'image/png');
    } finally {
      await client.close();
    }
  },
);
