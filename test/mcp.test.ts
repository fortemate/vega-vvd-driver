// The MCP server, through the SDK's own client: in memory, and over stdio
// as an agent would start it. Neither needs a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.ts';

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
