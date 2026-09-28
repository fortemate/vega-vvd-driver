// The `vvd` command line.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { enableGrpc } from './console.ts';
import { Device, type Frame } from './device.ts';
import { findEmulators } from './discovery.ts';
import { parseKeys } from './keys.ts';
import { serveStdio } from './mcp.ts';
import { encodePng } from './png.ts';
import { record } from './record.ts';
import { checkSafeArea, formatColour, parseColour } from './safearea.ts';
import { VERSION } from './version.ts';

export const USAGE = `vvd ${VERSION}: drive the Vega Virtual Device from scripts and AI agents.

Usage: vvd <command> [options]

Commands:
  devices                    list running devices whose gRPC endpoint is on
  enable-grpc                turn gRPC on (it is off after every start of the device)
      --port <n>             gRPC port, default 8554
      --console-port <n>     emulator console port, even, 5554 to 5682; default 5554
  press <key...>             press remote keys in order
                             up down left right ok back menu playpause rewind
                             fastforward, a KEY_* name or an evdev code;
                             down*3 repeats, ok:down / ok:up hold and release
      --gap <ms>             pause after each key, default 450
  screenshot [file]          save the screen as a PNG, default vvd-<time>.png
  record <file>              record the screen with sound to an MP4 (needs ffmpeg)
      --seconds <n>          default 10
      --fps <n>              default 30
      --no-audio             video only
  frames <dir>               save every distinct frame as a PNG, to check animations;
                             frames wait in memory until the capture ends, 6 MB each
                             at 1080p, and it stops before they pass 2 GB
      --seconds <n>          default 3
      --max-frames <n>       stop after this many frames, default 200
  wait-change                exit 0 once the screen changes, 1 on a timeout
      --timeout <ms>         default 5000
  safe-area                  check the outer 5% of the screen against the background;
                             exit 0 when clear, 1 when something sits in the margin
      --background <#rrggbb> default: the most common colour in the margin
      --margin <fraction>    default 0.05
  mcp                        run the MCP server on stdio, for AI agents

Options:
  --pid <n>                  the device to drive when several run
                             (every command but enable-grpc, which uses
                             --console-port)
  -h, --help, -v, --version

Exit status: 0 on success, 1 for "no change" and "not clear", 2 on an error.
`;

export type Parsed = {
  command: string | undefined;
  positionals: string[];
  values: {
    pid?: string;
    port?: string;
    'console-port'?: string;
    gap?: string;
    seconds?: string;
    'max-frames'?: string;
    fps?: string;
    'no-audio'?: boolean;
    timeout?: string;
    background?: string;
    margin?: string;
    help?: boolean;
    version?: boolean;
  };
};

export const parseCli = (argv: readonly string[]): Parsed => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      pid: { type: 'string' },
      port: { type: 'string' },
      'console-port': { type: 'string' },
      gap: { type: 'string' },
      seconds: { type: 'string' },
      'max-frames': { type: 'string' },
      fps: { type: 'string' },
      'no-audio': { type: 'boolean' },
      timeout: { type: 'string' },
      background: { type: 'string' },
      margin: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [command, ...rest] = positionals;
  return { command, positionals: rest, values };
};

// A whole number option, or its default.
export const numberOption = (
  value: string | undefined,
  name: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {},
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < min ||
    parsed > max
  )
    throw new Error(
      `--${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`,
    );
  return parsed;
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// How many frames `vvd frames` holds by default: about 1.2 GB at 1080p.
export const MAX_FRAMES = 200;

// The most memory the held frames may take, whatever --max-frames says and
// whatever the screen's size: 321 frames at 1080p.
export const MAX_BYTES = 2_000_000_000;

// Captures every distinct frame for `durationMs`, then writes each to `dir`
// as frame-<ms>ms.png, the milliseconds on the emulator's clock from the
// first frame. The frames wait in memory until the capture is over: encoding
// one at 1080p takes 20 to 200 ms, and the next screenshot would wait for it.
// The capture stops after `maxFrames`, or before the frames held would pass
// `maxBytes`; the frames it has are written either way.
export const saveFrames = async (
  device: Device,
  dir: string,
  options: {
    durationMs: number;
    maxFrames?: number;
    // Replaceable in tests.
    maxBytes?: number;
    encode?: (width: number, height: number, rgb: Buffer) => Buffer;
  },
): Promise<{ count: number; stopped: 'max-frames' | 'memory' | undefined }> => {
  const {
    durationMs,
    maxFrames = MAX_FRAMES,
    maxBytes = MAX_BYTES,
    encode = encodePng,
  } = options;
  const held: Frame[] = [];
  let bytes = 0;
  // Fires at the first frame that does not fit, which is not kept: frames can
  // differ in size, so each one is checked as it comes.
  const full = new AbortController();
  try {
    await device.frames(
      durationMs,
      (frame) => {
        if (bytes + frame.data.length > maxBytes) {
          full.abort();
          return;
        }
        held.push(frame);
        bytes += frame.data.length;
      },
      { maxFrames, signal: full.signal },
    );
  } catch (error) {
    if (!full.signal.aborted) throw error;
  }
  const first = held[0]?.timestampUs ?? 0;
  for (const frame of held) {
    const ms = Math.round((frame.timestampUs - first) / 1000);
    writeFileSync(
      join(dir, `frame-${String(ms).padStart(6, '0')}ms.png`),
      encode(frame.width, frame.height, frame.data),
    );
  }
  let stopped: 'max-frames' | 'memory' | undefined;
  if (full.signal.aborted) stopped = 'memory';
  else if (held.length >= maxFrames) stopped = 'max-frames';
  return { count: held.length, stopped };
};

// What a command is given: its arguments and options, and the device to drive.
type Context = {
  positionals: string[];
  values: Parsed['values'];
  pid: number | undefined;
};

// Connects to the device, runs `body` with it, and lets go of the device
// however `body` ends.
const withDevice = async <T>(
  pid: number | undefined,
  body: (device: Device) => Promise<T>,
): Promise<T> => {
  const device = Device.connect({ pid });
  try {
    return await body(device);
  } finally {
    device.close();
  }
};

// The commands by name, each returning its exit status. Options are checked
// before a device is looked for.
const COMMANDS: Record<string, (context: Context) => number | Promise<number>> =
  {
    devices({ pid }) {
      const devices = findEmulators({ pid });
      if (devices.length === 0) {
        console.log(
          'No running Vega Virtual Device with gRPC on. Start one, then run: vvd enable-grpc',
        );
        return 1;
      }
      for (const d of devices)
        console.log(
          `pid ${d.pid}  grpc ${d.grpcPort}  console ${d.consolePort ?? '-'}  ${d.avdName ?? ''}`.trimEnd(),
        );
      return 0;
    },

    async 'enable-grpc'({ values, pid }) {
      if (pid !== undefined)
        throw new Error(
          'enable-grpc talks to an emulator console, not to a pid: use --console-port',
        );
      const port = numberOption(values.port, 'port', 8554, {
        min: 1024,
        max: 65535,
      });
      const consolePort = numberOption(
        values['console-port'],
        'console-port',
        5554,
        { min: 5554, max: 5682 },
      );
      await enableGrpc(port, { port: consolePort });
      console.log(`gRPC is on at port ${port}.`);
      return 0;
    },

    async press({ positionals, values, pid }) {
      if (positionals.length === 0)
        throw new Error(
          'press needs at least one key, for example: vvd press down ok',
        );
      const steps = parseKeys(positionals); // fails before connecting on a typo
      const gapMs = numberOption(values.gap, 'gap', 450, { max: 60000 });
      await withDevice(pid, (device) => device.press(steps, { gapMs }));
      return 0;
    },

    async screenshot({ positionals, pid }) {
      const file = positionals[0] ?? `vvd-${stamp()}.png`;
      const frame = await withDevice(pid, (device) => device.screenshot('png'));
      writeFileSync(file, frame.data);
      console.log(file);
      return 0;
    },

    async record({ positionals, values, pid }) {
      const file = positionals[0];
      if (!file)
        throw new Error(
          'record needs a file, for example: vvd record demo.mp4 --seconds 20',
        );
      const options = {
        file,
        seconds: numberOption(values.seconds, 'seconds', 10, {
          min: 1,
          max: 3600,
          integer: false,
        }),
        fps: numberOption(values.fps, 'fps', 30, { min: 1, max: 60 }),
        audio: !values['no-audio'],
      };
      const result = await withDevice(pid, (device) => record(device, options));
      console.log(
        `${result.file}: ${result.frames} frames, ${result.audioSeconds.toFixed(1)} s of audio`,
      );
      return 0;
    },

    async frames({ positionals, values, pid }) {
      const dir = positionals[0];
      if (!dir)
        throw new Error(
          'frames needs a directory, for example: vvd frames ./frames --seconds 3',
        );
      const seconds = numberOption(values.seconds, 'seconds', 3, {
        min: 0.1,
        max: 600,
        integer: false,
      });
      const maxFrames = numberOption(
        values['max-frames'],
        'max-frames',
        MAX_FRAMES,
        { min: 1, max: 10_000 },
      );
      mkdirSync(dir, { recursive: true });
      const { count, stopped } = await withDevice(pid, (device) =>
        saveFrames(device, dir, { durationMs: seconds * 1000, maxFrames }),
      );
      const why = {
        'max-frames': `stopped at --max-frames ${maxFrames}`,
        memory: `stopped at ${MAX_BYTES / 1e9} GB of frames in memory`,
      };
      console.log(
        stopped
          ? `${count} distinct frames in ${dir}: ${why[stopped]} before the ${seconds} s were up`
          : `${count} distinct frames in ${dir}`,
      );
      return 0;
    },

    async 'wait-change'({ values, pid }) {
      const timeoutMs = numberOption(values.timeout, 'timeout', 5000, {
        min: 1,
        max: 3_600_000,
      });
      const changed = await withDevice(pid, (device) =>
        device.waitForChange({ timeoutMs }),
      );
      console.log(changed ? 'changed' : 'no change');
      return changed ? 0 : 1;
    },

    async 'safe-area'({ values, pid }) {
      const options = {
        background: values.background
          ? parseColour(values.background)
          : undefined,
        margin: numberOption(values.margin, 'margin', 0.05, {
          min: 0.01,
          max: 0.25,
          integer: false,
        }),
      };
      const frame = await withDevice(pid, (device) => device.screenshot('rgb'));
      const report = checkSafeArea(
        frame.data,
        frame.width,
        frame.height,
        options,
      );
      console.log(
        `${report.clear ? 'clear' : 'NOT clear'}: left=${report.left} right=${report.right} top=${report.top} bottom=${report.bottom} (background ${formatColour(report.background)})`,
      );
      return report.clear ? 0 : 1;
    },

    async mcp({ pid }) {
      await serveStdio({ pid });
      return -1; // keeps running until the client disconnects
    },
  };

export const main = async (argv: readonly string[]): Promise<number> => {
  const { command, positionals, values } = parseCli(argv);
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  const pid =
    values.pid === undefined
      ? undefined
      : numberOption(values.pid, 'pid', 0, { min: 1 });
  // Own names only, so that "constructor" and the like are not commands.
  if (!Object.hasOwn(COMMANDS, command))
    throw new Error(`unknown command "${command}". Run vvd --help.`);
  return COMMANDS[command]({ positionals, values, pid });
};
