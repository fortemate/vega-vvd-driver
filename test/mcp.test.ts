// The MCP server, through the SDK's own client: in memory, and over stdio
// as an agent would start it; for the tools, against a fake emulator. None
// of it needs a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Device } from '../src/device.ts';
import { createServer } from '../src/mcp.ts';
import { PROTO_DIR, startFakeEmulator } from './fakeEmulator.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../src/bin.ts');

const TOOLS = [
  'check_safe_area',
  'enable_grpc',
  'list_devices',
  'press_keys',
  'record_video',
  'screenshot',
  'wait_for_change',
];

test('the server offers the driver tools', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
    const press = tools.find((tool) => tool.name === 'press_keys');
    assert.deepEqual(press?.inputSchema.required, ['keys']);
    // Every tool says whether it changes anything, and none reaches beyond
    // the local device.
    const annotations = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations]),
    );
    for (const name of TOOLS) {
      assert.equal(annotations[name]?.openWorldHint, false, name);
      assert.equal(typeof annotations[name]?.readOnlyHint, 'boolean', name);
    }
    const changing = TOOLS.filter((name) => !annotations[name]?.readOnlyHint);
    assert.deepEqual(changing, ['enable_grpc', 'press_keys', 'record_video']);
    assert.equal(annotations.enable_grpc?.destructiveHint, false);
    assert.equal(annotations.press_keys?.destructiveHint, true);
    assert.equal(annotations.record_video?.destructiveHint, true);
  } finally {
    await client.close();
  }
});

test('a bad key comes back as a tool error, not a crash', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  try {
    const result = await client.callTool({
      name: 'press_keys',
      arguments: { keys: ['nope'] },
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
});

test('`vvd mcp` speaks MCP over stdio', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'] }),
  );
  try {
    assert.equal(client.getServerVersion()?.name, 'vega-vvd-driver');
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOLS.length);
  } finally {
    await client.close();
  }
});

// Against a fake emulator: what the server refuses, and what it stops.
const withServer = async (
  body: (
    client: Client,
    fake: Awaited<ReturnType<typeof startFakeEmulator>>,
  ) => Promise<void>,
) => {
  const fake = await startFakeEmulator();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({
    directories: [fake.directory],
    protoDirectory: PROTO_DIR,
  }).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  try {
    await body(client, fake);
  } finally {
    await client.close();
    fake.stop();
  }
};

const call = (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const said = (result: CallToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join();

test('press_keys presses nothing when asked for too many presses', () =>
  withServer(async (client, fake) => {
    const result = await call(client, 'press_keys', {
      keys: ['right*100', 'left'],
    });
    assert.equal(result.isError, true);
    assert.match(said(result), /101 presses asked for; at most 100/);
    assert.deepEqual(fake.keys, []);
  }));

test('names from the object prototype are not keys', () =>
  withServer(async (client, fake) => {
    for (const key of ['constructor', '__proto__', 'toString*3']) {
      const result = await call(client, 'press_keys', { keys: [key] });
      assert.equal(result.isError, true, key);
    }
    assert.deepEqual(fake.keys, []);
  }));

test('a cancelled press_keys stops pressing', () =>
  withServer(async (client, fake) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(
      client.callTool(
        { name: 'press_keys', arguments: { keys: ['right*100'], gap_ms: 20 } },
        undefined,
        { signal: controller.signal },
      ),
    );
    await new Promise((done) => setTimeout(done, 300));
    const pressed = fake.keys.length;
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(fake.keys.length, pressed);
    assert.ok(pressed < 200, `${pressed} key events`);
  }));

test('record_video writes only local video files, and never over one', () =>
  withServer(async (client) => {
    const existing = join(mkdtempSync(join(tmpdir(), 'vvd-mcp-')), 'old.mp4');
    writeFileSync(existing, 'keep me');
    const cases: [string, RegExp][] = [
      ['http://127.0.0.1:9/take.mp4', /local path, not a URL/],
      ['file:///tmp/take.mp4', /local path, not a URL/],
      ['src/cli.ts', /must end in \.mp4, \.mov or \.mkv/],
      [existing, /exists; set overwrite to replace it/],
    ];
    for (const [file, message] of cases) {
      const result = await call(client, 'record_video', { file, seconds: 1 });
      assert.equal(result.isError, true, file);
      assert.match(said(result), message);
    }
    assert.equal(readFileSync(existing, 'utf8'), 'keep me');
  }));

test('a connection that failed is not kept', () =>
  withServer(async (client, fake) => {
    const hidden = `${fake.file}.hidden`;
    renameSync(fake.file, hidden);
    assert.equal((await call(client, 'screenshot')).isError, true);
    renameSync(hidden, fake.file);
    const result = await call(client, 'screenshot');
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, 'image');
  }));

test('one connection serves the calls until the emulator moves', () =>
  withServer(async (client, fake) => {
    // Counted at Device.connect: gRPC can share a socket between clients, so
    // the fake cannot tell a kept connection from a new one.
    const connect = Device.connect;
    let connects = 0;
    Device.connect = (options) => {
      connects += 1;
      return connect.call(Device, options);
    };
    const moved = await startFakeEmulator();
    try {
      await call(client, 'screenshot');
      await call(client, 'screenshot');
      assert.equal(connects, 1);
      // The same pid now advertises another endpoint, as after a restart.
      writeFileSync(fake.file, readFileSync(moved.file));
      assert.equal((await call(client, 'screenshot')).isError, undefined);
      assert.equal(connects, 2);
      assert.deepEqual([fake.screenshots, moved.screenshots], [2, 1]);
    } finally {
      Device.connect = connect;
      moved.stop();
    }
  }));

test('the console port must be one an emulator can have', () =>
  withServer(async (client) => {
    const result = await call(client, 'enable_grpc', { console_port: 5555 });
    assert.equal(result.isError, true);
  }));
