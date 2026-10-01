// An MCP server over stdio, so that an AI coding agent can drive the VVD and
// see what it did: press remote keys, look at the screen, wait for it to
// change, record a video and check the TV safe area.
//
// A model chooses the arguments, so they are bounded: how many keys a call
// presses, how long it waits or records, and which files it may write. A call
// that the client cancels stops.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { enableGrpc } from './console.ts';
import { Device } from './device.ts';
import { findEmulators, type Emulator } from './discovery.ts';
import { parseKeys } from './keys.ts';
import { record } from './record.ts';
import { checkSafeArea, formatColour, parseColour } from './safearea.ts';
import { VERSION } from './version.ts';

// Presses per call: 100 at the default gap take about 54 seconds.
export const MAX_PRESSES = 100;

export type ServerOptions = {
  // Drive this emulator instead of the newest.
  pid?: number;
  // Where to look for discovery files and the proto; replaceable in tests.
  directories?: string[];
  protoDirectory?: string;
};

const text = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
});

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: (error as Error).message ?? String(error) }],
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// A path a model may record to: a local file with a video extension, and not
// one that exists unless it asks to replace it. Relative paths resolve against
// the server's working directory.
export const videoPath = (file: string, overwrite = false): string => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(file))
    throw new Error('file must be a local path, not a URL');
  const path = resolve(file);
  if (!/\.(mp4|mov|mkv)$/i.test(path))
    throw new Error('file must end in .mp4, .mov or .mkv');
  if (!overwrite && existsSync(path))
    throw new Error(`${path} exists; set overwrite to replace it`);
  return path;
};

// The same emulator, serving the same endpoint with the same token.
const sameEndpoint = (a: Emulator, b: Emulator): boolean =>
  a.pid === b.pid && a.grpcPort === b.grpcPort && a.grpcToken === b.grpcToken;

export const createServer = (options: ServerOptions = {}): McpServer => {
  const server = new McpServer({ name: 'vega-vvd-driver', version: VERSION });
  const find = { pid: options.pid, directories: options.directories };

  // One connection, kept while the same emulator serves the same endpoint; a
  // restarted VVD, or gRPC turned on again, gets a new one.
  let device: Device | undefined;
  const connected = (): Device => {
    const [newest] = findEmulators(find);
    if (device && newest && sameEndpoint(device.emulator, newest))
      return device;
    device?.close();
    device = undefined; // a failed connect below must not leave it cached
    device = Device.connect({
      ...find,
      protoDirectory: options.protoDirectory,
    });
    return device;
  };
  const screen = async (
    d: Device,
    signal: AbortSignal,
  ): Promise<CallToolResult['content'][number]> => {
    const frame = await d.screenshot('png', { signal });
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const devices = findEmulators({ directories: options.directories }).map(
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
          .min(1024)
          .max(65535)
          .optional()
          .describe('Default 8554'),
        console_port: z
          .number()
          .int()
          .min(5554)
          .max(5682)
          .multipleOf(2)
          .optional()
          .describe('The emulator console, an even port; default 5554'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ grpc_port, console_port }) => {
      try {
        await enableGrpc(grpc_port ?? 8554, { port: console_port });
        const found = () =>
          findEmulators({ directories: options.directories }).length;
        for (let i = 0; i < 20 && found() === 0; i++) await sleep(250);
        return text(
          found()
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
      description: `Presses TV remote keys in order: up, down, left, right, ok, back, menu, playpause, rewind, fastforward, a KEY_* name or an evdev code. Append *N to repeat (down*3), :down or :up to hold or release. At most ${MAX_PRESSES} presses per call. Home cannot be pressed on the Virtual Device. Set screenshot_after to see the result.`,
      inputSchema: {
        keys: z
          .array(z.string().min(1).max(40))
          .min(1)
          .max(50)
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
      // A key press can confirm anything the app on screen offers, a delete
      // included.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ keys, gap_ms, screenshot_after }, { signal }) => {
      try {
        const steps = parseKeys(keys); // a typo fails before any device is touched
        if (steps.length > MAX_PRESSES)
          throw new Error(
            `${steps.length} presses asked for; at most ${MAX_PRESSES} per call`,
          );
        const d = connected();
        await d.press(steps, { gapMs: gap_ms, signal });
        const done = text(`Pressed ${keys.join(' ')}.`);
        if (screenshot_after) done.content.push(await screen(d, signal));
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ signal }) => {
      try {
        return { content: [await screen(connected(), signal)] };
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ timeout_ms }, { signal }) => {
      try {
        const d = connected();
        const changed = await d.waitForChange({
          timeoutMs: timeout_ms,
          signal,
        });
        const result = text(
          changed
            ? 'The screen changed.'
            : 'The screen did not change before the timeout.',
        );
        result.content.push(await screen(d, signal));
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
        'Records the screen and the sound of the Vega Virtual Device to a video file, at 1080p. Needs ffmpeg on the PATH. Blocks for the whole duration; cancelling the call stops the recording.',
      inputSchema: {
        file: z
          .string()
          .min(1)
          .max(1024)
          .describe(
            "A local .mp4, .mov or .mkv path, absolute or relative to the server's working directory",
          ),
        seconds: z.number().min(1).max(600),
        fps: z.number().int().min(1).max(60).optional().describe('Default 30'),
        audio: z.boolean().optional().describe('Default true'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Replace an existing file; default false'),
      },
      // Destructive only with overwrite, which replaces an existing file.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file, seconds, fps, audio, overwrite }, { signal }) => {
      try {
        const path = videoPath(file, overwrite);
        const result = await record(connected(), {
          file: path,
          seconds,
          fps,
          audio,
          signal,
        });
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
          .max(7)
          .optional()
          .describe('#rrggbb; the most common margin colour by default'),
        margin: z
          .number()
          .min(0.01)
          .max(0.25)
          .optional()
          .describe('Fraction of each edge, default 0.05'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ background, margin }, { signal }) => {
      try {
        const frame = await connected().screenshot('rgb', { signal });
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

export const serveStdio = async (
  options: ServerOptions = {},
): Promise<void> => {
  await createServer(options).connect(new StdioServerTransport());
};
