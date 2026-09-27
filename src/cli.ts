// The `vvd` command line.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { enableGrpc } from './console.ts';
import { Device } from './device.ts';
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
      --console-port <n>     emulator console port, default 5554
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
  frames <dir>               save every distinct frame as a PNG, to check animations
      --seconds <n>          default 3
  wait-change                exit 0 once the screen changes, 1 on timeout
      --timeout <ms>         default 5000
  safe-area                  check the outer 5% of the screen against the background;
                             exit 0 when clear, 1 when something sits in the margin
      --background <#rrggbb> default: the most common colour in the margin
      --margin <fraction>    default 0.05
  mcp                        run the MCP server on stdio, for AI agents

Options for every command:
  --pid <n>                  the device to drive when several run
  -h, --help, -v, --version
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
  const connect = () => Device.connect({ pid });

  switch (command) {
    case 'devices': {
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
    }
    case 'enable-grpc': {
      const port = numberOption(values.port, 'port', 8554, {
        min: 1,
        max: 65535,
      });
      const consolePort = numberOption(
        values['console-port'],
        'console-port',
        5554,
        { min: 1, max: 65535 },
      );
      await enableGrpc(port, { port: consolePort });
      console.log(`gRPC is on at port ${port}.`);
      return 0;
    }
    case 'press': {
      if (positionals.length === 0)
        throw new Error(
          'press needs at least one key, for example: vvd press down ok',
        );
      const steps = parseKeys(positionals); // fails before connecting on a typo
      const device = connect();
      try {
        await device.press(steps, {
          gapMs: numberOption(values.gap, 'gap', 450, { max: 60000 }),
        });
      } finally {
        device.close();
      }
      return 0;
    }
    case 'screenshot': {
      const file = positionals[0] ?? `vvd-${stamp()}.png`;
      const device = connect();
      try {
        const frame = await device.screenshot('png');
        writeFileSync(file, frame.data);
        console.log(file);
      } finally {
        device.close();
      }
      return 0;
    }
    case 'record': {
      const file = positionals[0];
      if (!file)
        throw new Error(
          'record needs a file, for example: vvd record demo.mp4 --seconds 20',
        );
      const device = connect();
      try {
        const result = await record(device, {
          file,
          seconds: numberOption(values.seconds, 'seconds', 10, {
            min: 1,
            max: 3600,
            integer: false,
          }),
          fps: numberOption(values.fps, 'fps', 30, { min: 1, max: 60 }),
          audio: !values['no-audio'],
        });
        console.log(
          `${result.file}: ${result.frames} frames, ${result.audioSeconds.toFixed(1)} s of audio`,
        );
      } finally {
        device.close();
      }
      return 0;
    }
    case 'frames': {
      const dir = positionals[0];
      if (!dir)
        throw new Error(
          'frames needs a directory, for example: vvd frames ./frames --seconds 3',
        );
      mkdirSync(dir, { recursive: true });
      const device = connect();
      try {
        let first: number | undefined;
        const count = await device.frames(
          numberOption(values.seconds, 'seconds', 3, {
            min: 0.1,
            max: 600,
            integer: false,
          }) * 1000,
          (frame) => {
            first ??= frame.timestampUs;
            const ms = Math.round((frame.timestampUs - first) / 1000);
            writeFileSync(
              join(dir, `frame-${String(ms).padStart(6, '0')}ms.png`),
              encodePng(frame.width, frame.height, frame.data),
            );
          },
        );
        console.log(`${count} distinct frames in ${dir}`);
      } finally {
        device.close();
      }
      return 0;
    }
    case 'wait-change': {
      const device = connect();
      try {
        const changed = await device.waitForChange({
          timeoutMs: numberOption(values.timeout, 'timeout', 5000, {
            min: 1,
            max: 3_600_000,
          }),
        });
        console.log(changed ? 'changed' : 'no change');
        return changed ? 0 : 1;
      } finally {
        device.close();
      }
    }
    case 'safe-area': {
      const device = connect();
      try {
        const frame = await device.screenshot('rgb');
        const report = checkSafeArea(frame.data, frame.width, frame.height, {
          background: values.background
            ? parseColour(values.background)
            : undefined,
          margin: numberOption(values.margin, 'margin', 0.05, {
            min: 0.01,
            max: 0.25,
            integer: false,
          }),
        });
        console.log(
          `${report.clear ? 'clear' : 'NOT clear'}: left=${report.left} right=${report.right} top=${report.top} bottom=${report.bottom} (background ${formatColour(report.background)})`,
        );
        return report.clear ? 0 : 1;
      } finally {
        device.close();
      }
    }
    case 'mcp':
      await serveStdio();
      return -1; // keeps running until the client disconnects
    default:
      throw new Error(`unknown command "${command}". Run vvd --help.`);
  }
};
