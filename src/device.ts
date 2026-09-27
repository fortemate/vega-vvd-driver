// A connection to one running Vega Virtual Device over the emulator's gRPC
// API (EmulatorController): remote keys, screenshots and the device's audio.
import { join } from 'node:path';
import { credentials, loadPackageDefinition, Metadata } from '@grpc/grpc-js';
import type { Client, ServiceError } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  findEmulator,
  findProtoDirectory,
  type Emulator,
  type FindOptions,
} from './discovery.ts';
import { parseKeys, type KeyStep } from './keys.ts';

export type ConnectOptions = FindOptions & {
  // The directory that holds emulator_controller.proto; found in the SDK by default.
  protoDirectory?: string;
};

export type PressOptions = {
  // Pause after each key, in milliseconds.
  gapMs?: number;
  // How long a key is held for a plain press.
  holdMs?: number;
};

export type Frame = {
  width: number;
  height: number;
  // RGB888 rows, top to bottom, or a PNG file's bytes.
  data: Buffer;
  // The emulator's own estimate of when the frame was produced, in microseconds.
  timestampUs: number;
};

type ImageReply = {
  format?: { width?: number; height?: number };
  image?: Buffer;
  timestampUs?: string | number;
};

type AudioReply = { timestamp?: string | number; audio?: Buffer };

export type AudioPacket = {
  // When the packet was captured, in microseconds since the Unix epoch.
  timestampUs: number;
  // 16-bit little-endian stereo samples at 44.1 kHz.
  pcm: Buffer;
};

type Controller = Client & {
  sendKey(
    request: object,
    metadata: Metadata,
    callback: (error: ServiceError | null) => void,
  ): void;
  getScreenshot(
    request: object,
    metadata: Metadata,
    callback: (error: ServiceError | null, reply: ImageReply) => void,
  ): void;
  streamAudio(
    request: object,
    metadata: Metadata,
  ): NodeJS.EventEmitter & { cancel(): void };
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Device {
  readonly emulator: Emulator;
  readonly #client: Controller;
  readonly #metadata: Metadata;

  private constructor(
    emulator: Emulator,
    client: Controller,
    metadata: Metadata,
  ) {
    this.emulator = emulator;
    this.#client = client;
    this.#metadata = metadata;
  }

  // Connects to the newest running VVD with gRPC on, or to the given pid.
  static connect(options: ConnectOptions = {}): Device {
    const emulator = findEmulator(options);
    const directory = options.protoDirectory ?? findProtoDirectory();
    const definition = loadSync(join(directory, 'emulator_controller.proto'), {
      includeDirs: [directory],
      keepCase: true,
      enums: String,
      longs: String,
    });
    const control = (
      loadPackageDefinition(definition) as unknown as {
        android: {
          emulation: {
            control: {
              EmulatorController: new (
                address: string,
                creds: ReturnType<typeof credentials.createInsecure>,
                options: object,
              ) => Controller;
            };
          };
        };
      }
    ).android.emulation.control;
    const client = new control.EmulatorController(
      `127.0.0.1:${emulator.grpcPort}`,
      credentials.createInsecure(),
      // A 1080p frame is 6 MB, above gRPC's default limit.
      { 'grpc.max_receive_message_length': 64 * 1024 * 1024 },
    );
    const metadata = new Metadata();
    if (emulator.grpcToken)
      metadata.add('authorization', `Bearer ${emulator.grpcToken}`);
    return new Device(emulator, client, metadata);
  }

  close(): void {
    this.#client.close();
  }

  #sendKey(code: number, eventType: 'keydown' | 'keyup'): Promise<void> {
    return new Promise((resolve, reject) =>
      this.#client.sendKey(
        { codeType: 'Evdev', eventType, keyCode: code },
        this.#metadata,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }

  // Presses keys in order. Accepts names such as `ok`, `down*3`, `ok:down`,
  // or steps already parsed.
  async press(
    keys: readonly string[] | readonly KeyStep[],
    options: PressOptions = {},
  ): Promise<void> {
    const steps: readonly KeyStep[] =
      typeof keys[0] === 'string'
        ? parseKeys(keys as readonly string[])
        : (keys as readonly KeyStep[]);
    const gap = options.gapMs ?? 450;
    const hold = options.holdMs ?? 90;
    for (const step of steps) {
      if (step.half !== 'up') await this.#sendKey(step.code, 'keydown');
      if (step.half === 'press') await sleep(hold);
      if (step.half !== 'down') await this.#sendKey(step.code, 'keyup');
      await sleep(gap);
    }
  }

  // One frame of the screen, as RGB888 or as a PNG file.
  screenshot(format: 'png' | 'rgb' = 'png'): Promise<Frame> {
    return new Promise((resolve, reject) =>
      this.#client.getScreenshot(
        { format: format === 'png' ? 'PNG' : 'RGB888' },
        this.#metadata,
        (error, reply) => {
          if (error) return reject(error);
          const data = reply.image ?? Buffer.alloc(0);
          if (data.length === 0)
            return reject(
              new Error(
                'the device returned an empty screen: is its display on?',
              ),
            );
          resolve({
            width: reply.format?.width ?? 0,
            height: reply.format?.height ?? 0,
            data,
            timestampUs: Number(reply.timestampUs ?? 0),
          });
        },
      ),
    );
  }

  // Waits until the screen differs from how it looked when the wait began.
  // Polls screenshots: the emulator's own screenshot stream can stop
  // delivering frames while the screen keeps changing.
  async waitForChange(
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    const first = await this.screenshot('rgb');
    while (Date.now() < deadline) {
      await sleep(options.intervalMs ?? 50);
      const frame = await this.screenshot('rgb');
      if (!frame.data.equals(first.data)) return true;
    }
    return false;
  }

  // Calls `onFrame` with every distinct frame for `durationMs`. Useful to
  // check an animation: a 220 ms slide comes through as about ten frames.
  async frames(
    durationMs: number,
    onFrame: (frame: Frame) => void | Promise<void>,
    options: { intervalMs?: number } = {},
  ): Promise<number> {
    const deadline = Date.now() + durationMs;
    let previous: Buffer | undefined;
    let count = 0;
    while (Date.now() < deadline) {
      const frame = await this.screenshot('rgb');
      if (!previous || !frame.data.equals(previous)) {
        previous = frame.data;
        count += 1;
        await onFrame(frame);
      }
      if (options.intervalMs) await sleep(options.intervalMs);
    }
    return count;
  }

  // The device's audio as 16-bit little-endian stereo PCM at 44.1 kHz.
  // Returns a function that stops the stream and gives back the packets that
  // arrived, each with the time it was captured. The emulator sends nothing
  // while the device is silent, so the packets can have gaps; see
  // assembleAudio in record.ts.
  listen(): () => AudioPacket[] {
    const packets: AudioPacket[] = [];
    const stream = this.#client.streamAudio(
      {
        samplingRate: 44100,
        channels: 'Stereo',
        format: 'AUD_FMT_S16',
        mode: 'MODE_REAL_TIME',
      },
      this.#metadata,
    );
    stream.on('data', (packet: AudioReply) => {
      if (packet.audio?.length)
        packets.push({
          timestampUs: Number(packet.timestamp ?? 0),
          pcm: packet.audio,
        });
    });
    stream.on('error', () => {
      // Cancelling the stream ends it with an error; nothing to report.
    });
    return () => {
      stream.cancel();
      return packets;
    };
  }
}
