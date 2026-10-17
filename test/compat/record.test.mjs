// Run against the published JavaScript build on an early Node 20, without
// TypeScript stripping, a device, or a real ffmpeg installation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Device, createServer, record } from '../../dist/index.js';

const directory = mkdtempSync(join(tmpdir(), 'vvd-compat-'));
const realPath = process.env.PATH;
writeFileSync(
  join(directory, 'ffmpeg'),
  [
    '#!/bin/sh',
    '[ "$1" = "-version" ] && exit 0',
    'for target do :; done',
    'case "$target" in file:*) printf "fake video" > "${target#file:}";; esac',
    'exec cat > /dev/null',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
process.env.PATH = `${directory}:${realPath}`;
test.after(() => {
  process.env.PATH = realPath;
  rmSync(directory, { recursive: true, force: true });
});

const fakeDevice = () => ({
  shots: 0,
  async screenshot() {
    this.shots += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      width: 16,
      height: 16,
      data: Buffer.alloc(16 * 16 * 3),
      timestampUs: Date.now() * 1000,
    };
  },
  listen: () => () => [],
  close() {
    // This stand-in device has no connection to close.
  },
});

test('a recording accepts a caller signal on the supported runtime', async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  const file = join(directory, 'signal.mp4');
  await record(fakeDevice(), {
    file,
    seconds: 0.1,
    signal: controller.signal,
  });
  assert.equal(readFileSync(file, 'utf8'), 'fake video');
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('an already aborted signal fails before touching the device', async () => {
  const device = fakeDevice();
  const controller = new AbortController();
  const reason = new Error('cancelled before capture');
  controller.abort(reason);
  await assert.rejects(
    record(device, {
      file: join(directory, 'aborted.mp4'),
      seconds: 1,
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  assert.equal(device.shots, 0);
});

test('a later abort preserves its reason and removes the caller listener', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled during capture');
  const before = getEventListeners(controller.signal, 'abort').length;
  await assert.rejects(
    record(fakeDevice(), {
      file: join(directory, 'later-abort.mp4'),
      seconds: 10,
      signal: controller.signal,
      onStart: () => controller.abort(reason),
    }),
    (error) => error === reason,
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('a preflight error removes the caller listener', async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  await assert.rejects(
    record(fakeDevice(), {
      file: join(directory, 'missing', 'take.mp4'),
      seconds: 1,
      signal: controller.signal,
    }),
    /cannot write/,
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('a capture error removes the caller listener', async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  const device = fakeDevice();
  device.screenshot = async () => {
    throw new Error('camera failed');
  };
  await assert.rejects(
    record(device, {
      file: join(directory, 'camera-error.mp4'),
      seconds: 1,
      signal: controller.signal,
    }),
    /camera failed/,
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('a replacement keeps private permissions on the supported runtime', async () => {
  const file = join(directory, 'private.mp4');
  writeFileSync(file, 'private recording');
  chmodSync(file, 0o600);
  await record(fakeDevice(), {
    file,
    seconds: 0.1,
    audio: false,
    signal: new AbortController().signal,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8'), 'fake video');
});

test('MCP records with the request signal on the supported runtime', async () => {
  const connect = Device.connect;
  Device.connect = () => fakeDevice();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ directories: [] });
  const client = new Client({ name: 'compatibility-test', version: '0' });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const file = join(directory, 'mcp.mp4');
    const result = await client.callTool({
      name: 'record_video',
      arguments: { file, seconds: 1, audio: false },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(readFileSync(file, 'utf8'), 'fake video');
  } finally {
    await client.close();
    await server.close();
    Device.connect = connect;
  }
});
