// An MCP server over stdio, so that an AI coding agent can drive the VVD and
// see what it did: press remote keys, look at the screen, wait for it to
// change, record a video and check the TV safe area.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { enableGrpc } from './console.ts';
import { Device } from './device.ts';
import { findEmulators } from './discovery.ts';
import { parseKeys } from './keys.ts';
import { record } from './record.ts';
import { checkSafeArea, formatColour, parseColour } from './safearea.ts';
import { VERSION } from './version.ts';

const text = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
});

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: (error as Error).message ?? String(error) }],
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createServer = (): McpServer => {
  const server = new McpServer({ name: 'vega-vvd-driver', version: VERSION });

  // One connection, kept while the same emulator runs; a restarted VVD gets a
  // new one.
  let device: Device | undefined;
  const connected = (): Device => {
    const [newest] = findEmulators();
    if (device && newest && device.emulator.pid === newest.pid) return device;
    device?.close();
    device = Device.connect();
    return device;
  };
  const screen = async (
    d: Device,
  ): Promise<CallToolResult['content'][number]> => {
    const frame = await d.screenshot('png');
    return {
      type: 'image',
      data: frame.data.toString('base64'),
      mimeType: 'image/png',
    };
  };

  server.registerTool(
    'list_devices',
    {
      title: 'List running Vega Virtual Devices',
      description:
        'Lists the running Vega Virtual Devices whose gRPC endpoint is on. An empty list usually means gRPC is off: call enable_grpc.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const devices = findEmulators().map(
        ({ pid, grpcPort, consolePort, avdName }) => ({
          pid,
          grpcPort,
          consolePort,
          avdName,
        }),
      );
      return text(JSON.stringify(devices, null, 2));
    },
  );

  server.registerTool(
    'enable_grpc',
    {
      title: 'Turn on the emulator gRPC endpoint',
      description:
        'Turns on the gRPC endpoint of a running Vega Virtual Device through its emulator console. It is off after every start of the device, and nothing else here works until it is on.',
      inputSchema: {
        grpc_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Default 8554'),
        console_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Default 5554'),
      },
    },
    async ({ grpc_port, console_port }) => {
      try {
        await enableGrpc(grpc_port ?? 8554, { port: console_port });
        for (let i = 0; i < 20 && findEmulators().length === 0; i++)
          await sleep(250);
        const found = findEmulators().length;
        return text(
          found
            ? `gRPC is on at port ${grpc_port ?? 8554}.`
            : 'The console accepted the command, but no discovery file appeared yet.',
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'press_keys',
    {
      title: 'Press remote keys',
      description:
        'Presses TV remote keys in order: up, down, left, right, ok, back, menu, playpause, rewind, fastforward, a KEY_* name or an evdev code. Append *N to repeat (down*3), :down or :up to hold or release. Set screenshot_after to see the result.',
      inputSchema: {
        keys: z
          .array(z.string())
          .min(1)
          .describe('For example ["down", "down", "ok"]'),
        gap_ms: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Pause after each key, default 450'),
        screenshot_after: z
          .boolean()
          .optional()
          .describe('Return a screenshot once the keys are pressed'),
      },
    },
    async ({ keys, gap_ms, screenshot_after }) => {
      try {
        const steps = parseKeys(keys); // a typo fails before any device is touched
        const d = connected();
        await d.press(steps, { gapMs: gap_ms });
        const done = text(`Pressed ${keys.join(' ')}.`);
        if (screenshot_after) done.content.push(await screen(d));
        return done;
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Take a screenshot',
      description:
        'Returns the current screen of the Vega Virtual Device as a PNG image (1920x1080).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return { content: [await screen(connected())] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'wait_for_change',
    {
      title: 'Wait until the screen changes',
      description:
        'Waits until the screen differs from how it looked when the call began, for example after starting an app or while the app is thinking. Returns whether it changed, with a screenshot.',
      inputSchema: {
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(120000)
          .optional()
          .describe('Default 5000'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ timeout_ms }) => {
      try {
        const d = connected();
        const changed = await d.waitForChange({ timeoutMs: timeout_ms });
        const result = text(
          changed
            ? 'The screen changed.'
            : 'The screen did not change before the timeout.',
        );
        result.content.push(await screen(d));
        return result;
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'record_video',
    {
      title: 'Record a video with sound',
      description:
        'Records the screen and the sound of the Vega Virtual Device to an MP4 file, at 1080p. Needs ffmpeg on the PATH. Blocks for the whole duration.',
      inputSchema: {
        file: z.string().min(1).describe('Where to write the MP4'),
        seconds: z.number().min(1).max(600),
        fps: z.number().int().min(1).max(60).optional().describe('Default 30'),
        audio: z.boolean().optional().describe('Default true'),
      },
    },
    async ({ file, seconds, fps, audio }) => {
      try {
        const result = await record(connected(), { file, seconds, fps, audio });
        return text(
          `Recorded ${result.file}: ${result.frames} frames, ${result.audioSeconds.toFixed(1)} s of audio.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'check_safe_area',
    {
      title: 'Check the TV safe area',
      description:
        'Counts the pixels in the outer margin of the screen (5% of each edge by default) that differ from the background. Fire TV guidance keeps content out of that margin, which a television may crop.',
      inputSchema: {
        background: z
          .string()
          .optional()
          .describe('#rrggbb; the most common margin colour by default'),
        margin: z
          .number()
          .min(0.01)
          .max(0.25)
          .optional()
          .describe('Fraction of each edge, default 0.05'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ background, margin }) => {
      try {
        const frame = await connected().screenshot('rgb');
        const report = checkSafeArea(frame.data, frame.width, frame.height, {
          background: background ? parseColour(background) : undefined,
          margin,
        });
        return text(
          `${report.clear ? 'Clear' : 'Not clear'}: left ${report.left}, right ${report.right}, top ${report.top}, bottom ${report.bottom} pixels differ from ${formatColour(report.background)}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  // Let go of the device when the client goes away.
  server.server.onclose = () => {
    device?.close();
    device = undefined;
  };

  return server;
};

export const serveStdio = async (): Promise<void> => {
  await createServer().connect(new StdioServerTransport());
};
