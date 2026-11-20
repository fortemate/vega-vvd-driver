import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ServerOptions } from '../src/mcp.ts';

const withClient = async (
  options: ServerOptions,
  body: (client: Client) => Promise<void>,
) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);
  const client = new Client({ name: 'discovery-contract', version: '0' });
  await client.connect(clientSide);
  try {
    await body(client);
  } finally {
    await client.close();
  }
};

const list = (client: Client) =>
  client.callTool({
    name: 'list_devices',
    arguments: {},
  }) as Promise<CallToolResult>;

const expected = (devices: unknown[]) => ({
  content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }],
});

test('list_devices returns an empty protocol result for a missing discovery directory', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'vvd-list-contract-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  await withClient({ directories: [join(root, 'missing')] }, async (client) => {
    assert.deepEqual(await list(client), expected([]));
  });
});

test('list_devices preserves newest-first projection and lists all endpoints independently of the selected pid', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'vvd-list-contract-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const older = join(root, 'older');
  const newer = join(root, 'newer');
  mkdirSync(older);
  mkdirSync(newer);
  const oldFile = join(older, `pid_${process.pid}.ini`);
  const newFile = join(newer, `pid_${process.pid}.ini`);
  writeFileSync(
    oldFile,
    'grpc.port=8554\ngrpc.token=SYNTHETIC_NOT_FOR_PROJECTION\nport.serial=5554\navd.name=Fixture TV\nprivate.field=omit-me\n',
  );
  writeFileSync(newFile, 'grpc.port=8556\ngrpc.token=SYNTHETIC_OTHER\n');
  utimesSync(oldFile, 1, 1);
  utimesSync(newFile, 2, 2);
  await withClient(
    { directories: [older, newer], pid: 2147483647 },
    async (client) => {
      const result = await list(client);
      assert.deepEqual(
        result,
        expected([
          { pid: process.pid, grpcPort: 8556 },
          {
            pid: process.pid,
            grpcPort: 8554,
            consolePort: 5554,
            avdName: 'Fixture TV',
          },
        ]),
      );
      const encoded = JSON.stringify(result);
      assert.ok(!encoded.includes('SYNTHETIC'));
      assert.ok(!encoded.includes(root));
      assert.ok(!encoded.includes('private.field'));
    },
  );
});

test('list_devices rescans discovery changes and omits endpoints with gRPC disabled', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'vvd-list-contract-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, `pid_${process.pid}.ini`);
  writeFileSync(file, 'grpc.port=8554\navd.name=First\n');
  await withClient({ directories: [root] }, async (client) => {
    assert.deepEqual(
      await list(client),
      expected([{ pid: process.pid, grpcPort: 8554, avdName: 'First' }]),
    );
    writeFileSync(file, 'grpc.port=8556\navd.name=Second\n');
    assert.deepEqual(
      await list(client),
      expected([{ pid: process.pid, grpcPort: 8556, avdName: 'Second' }]),
    );
    writeFileSync(file, 'avd.name=No gRPC\n');
    assert.deepEqual(await list(client), expected([]));
    renameSync(file, `${file}.hidden`);
    assert.deepEqual(await list(client), expected([]));
  });
});

test('the MCP SDK reports discovery read failures as tool errors and permits a subsequent call', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'vvd-list-contract-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, `pid_${process.pid}.ini`);
  mkdirSync(file);
  await withClient({ directories: [root] }, async (client) => {
    const result = await list(client);
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    if (result.content[0].type === 'text')
      assert.match(result.content[0].text, /EISDIR|directory/);
    rmSync(file, { recursive: true });
    writeFileSync(file, 'grpc.port=8554\n');
    assert.deepEqual(
      await list(client),
      expected([{ pid: process.pid, grpcPort: 8554 }]),
    );
  });
});
