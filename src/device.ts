// A connection to one running Vega Virtual Device over the emulator's gRPC
// API (EmulatorController): remote keys, screenshots and the device's audio.
//
// Every call has a deadline, so a wedged emulator fails a command instead of
// hanging it, and every long operation takes an AbortSignal.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  status,
} from '@grpc/grpc-js';
import type { Client, ClientUnaryCall, ServiceError } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  findEmulator,
  findProtoDirectory,
  type Emulator,
  type FindOptions,
} from './discovery.ts';
import { parseKeys, type KeyStep } from './keys.ts';

// How long one call may take by default. A 1080p PNG takes about half a
// second on the VVD.
export const CALL_TIMEOUT_MS = 10_000;

export type ConnectOptions = FindOptions & {
  // The directory that holds emulator_controller.proto; found in the SDK by default.
  protoDirectory?: string;
  // How long one call may take, in milliseconds.
  callTimeoutMs?: number;
};

export type PressOptions = {
  // Pause after each key, in milliseconds.
  gapMs?: number;
  // How long a key is held for a plain press.
  holdMs?: number;
  signal?: AbortSignal;
};

export type CallOptions = {
  signal?: AbortSignal;
  // When the call must have answered, in milliseconds since the epoch.
  deadline?: number;
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

type Callback<T> = (error: ServiceError | null, reply: T) => void;

type AudioStream = NodeJS.EventEmitter & { cancel(): void };

type Controller = Client & {
  sendKey(
    request: object,
    metadata: Metadata,
    options: { deadline: number },
    callback: Callback<unknown>,
  ): ClientUnaryCall;
  getScreenshot(
    request: object,
    metadata: Metadata,
    options: { deadline: number },
    callback: Callback<ImageReply>,
  ): ClientUnaryCall;
  streamAudio(request: object, metadata: Metadata): AudioStream;
};

// The device did not answer before a call's deadline.
export class TimeoutError extends Error {
  constructor() {
    super('the Vega Virtual Device did not answer in time');
    this.name = 'TimeoutError';
  }
}

export class Device {
  readonly emulator: Emulator;
  readonly #client: Controller;
  readonly #metadata: Metadata;
  readonly #callTimeoutMs: number;
  readonly #streams = new Set<AudioStream>();

  private constructor(
    emulator: Emulator,
    client: Controller,
    metadata: Metadata,
    callTimeoutMs: number,
  ) {
    this.emulator = emulator;
    this.#client = client;
    this.#metadata = metadata;
    this.#callTimeoutMs = callTimeoutMs;
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
    return new Device(
      emulator,
      client,
      metadata,
      options.callTimeoutMs ?? CALL_TIMEOUT_MS,
    );
  }

  // Ends the audio streams that are still open, then the connection.
  close(): void {
    for (const stream of this.#streams) stream.cancel();
    this.#streams.clear();
    this.#client.close();
  }

  // One unary call, with a deadline, cancelled if the signal fires.
  #call<T>(
    start: (
      options: { deadline: number },
      callback: Callback<T>,
    ) => ClientUnaryCall,
    { signal, deadline }: CallOptions,
  ): Promise<T> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => call.cancel();
      const call = start(
        { deadline: deadline ?? Date.now() + this.#callTimeoutMs },
        (error, reply) => {
          signal?.removeEventListener('abort', cancel);
          if (signal?.aborted) reject(signal.reason);
          else if (error?.code === status.DEADLINE_EXCEEDED)
            reject(new TimeoutError());
          else if (error) reject(error);
          else resolve(reply);
        },
      );
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  #sendKey(
    code: number,
    eventType: 'keydown' | 'keyup',
    options: CallOptions = {},
  ): Promise<unknown> {
    return this.#call(
      (callOptions, callback) =>
        this.#client.sendKey(
          { codeType: 'Evdev', eventType, keyCode: code },
          this.#metadata,
          callOptions,
          callback,
        ),
      options,
    );
  }

  // Presses keys in order. Accepts names such as `ok`, `down*3`, `ok:down`,
  // or steps already parsed. A cancelled press still releases its key.
  async press(
    keys: readonly string[] | readonly KeyStep[],
    options: PressOptions = {},
  ): Promise<void> {
    const steps: readonly KeyStep[] =
      typeof keys[0] === 'string'
        ? parseKeys(keys as readonly string[])
        : (keys as readonly KeyStep[]);
    const { signal } = options;
    const gap = options.gapMs ?? 450;
    const hold = options.holdMs ?? 90;
    for (const step of steps) {
      signal?.throwIfAborted();
      if (step.half === 'press') {
        let released = false;
        try {
          await this.#sendKey(step.code, 'keydown', { signal });
          await sleep(hold, undefined, { signal });
          await this.#sendKey(step.code, 'keyup');
          released = true;
        } finally {
          if (!released)
            await this.#sendKey(step.code, 'keyup').catch(() => {});
        }
      } else {
        await this.#sendKey(
          step.code,
          step.half === 'down' ? 'keydown' : 'keyup',
          { signal },
        );
      }
      await sleep(gap, undefined, { signal });
    }
  }

  // One frame of the screen, as RGB888 or as a PNG file.
  async screenshot(
    format: 'png' | 'rgb' = 'png',
    options: CallOptions = {},
  ): Promise<Frame> {
    const reply = await this.#call<ImageReply>(
      (callOptions, callback) =>
        this.#client.getScreenshot(
          { format: format === 'png' ? 'PNG' : 'RGB888' },
          this.#metadata,
          callOptions,
          callback,
        ),
      options,
    );
    const data = reply.image ?? Buffer.alloc(0);
    if (data.length === 0)
      throw new Error(
        'the device returned an empty screen: is its display on?',
      );
    return {
      width: reply.format?.width ?? 0,
      height: reply.format?.height ?? 0,
      data,
      timestampUs: Number(reply.timestampUs ?? 0),
    };
  }

  // A screenshot taken while polling until `endMs`: its deadline stays close
  // to the end, and one that runs out after the end gives undefined.
  async #poll(endMs: number, signal?: AbortSignal): Promise<Frame | undefined> {
    try {
      return await this.screenshot('rgb', {
        signal,
        deadline: Math.min(Date.now() + this.#callTimeoutMs, endMs + 1000),
      });
    } catch (error) {
      if (error instanceof TimeoutError && Date.now() >= endMs)
        return undefined;
      throw error;
    }
  }

  // Waits until the screen differs from how it looked when the wait began.
  // Polls screenshots: the emulator's own screenshot stream can stop
  // delivering frames while the screen keeps changing.
  async waitForChange(
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    const { signal } = options;
    const endMs = Date.now() + (options.timeoutMs ?? 5000);
    const first = await this.screenshot('rgb', { signal });
    while (Date.now() < endMs) {
      await sleep(options.intervalMs ?? 50, undefined, { signal });
      const frame = await this.#poll(endMs, signal);
      if (!frame) return false;
      if (!frame.data.equals(first.data)) return true;
    }
    return false;
  }

  // Calls `onFrame` with every distinct frame for `durationMs`, or until
  // `maxFrames` of them have come. Useful to check an animation: on the VVD a
  // screenshot takes 23 to 61 ms while the screen changes, and a 220 ms slide
  // comes through as 4 to 6 frames.
  //
  // The next screenshot waits for `onFrame`, so keep it quick: encoding a
  // 1080p PNG takes 20 to 200 ms, and frames that come meanwhile are missed.
  // Hold the frames and save them once the capture is over, as `vvd frames`
  // does; `maxFrames` bounds the memory, about 6 MB a frame at 1080p.
  async frames(
    durationMs: number,
    onFrame: (frame: Frame) => void | Promise<void>,
    options: {
      intervalMs?: number;
      maxFrames?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<number> {
    const { signal, maxFrames = Infinity } = options;
    const endMs = Date.now() + durationMs;
    let previous: Buffer | undefined;
    let count = 0;
    while (Date.now() < endMs) {
      const frame = await this.#poll(endMs, signal);
      if (!frame) break;
      if (!previous || !frame.data.equals(previous)) {
        previous = frame.data;
        count += 1;
        await onFrame(frame);
        if (count >= maxFrames) break;
      }
      if (options.intervalMs)
        await sleep(options.intervalMs, undefined, { signal });
    }
    return count;
  }

  // The device's audio as 16-bit little-endian stereo PCM at 44.1 kHz.
  // Returns a function that stops the stream and gives back the packets that
  // arrived, each with the time it was captured; calling it again gives the
  // same packets. The emulator sends nothing while the device is silent, so
  // the packets can have gaps; see assembleAudio in record.ts.
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
    this.#streams.add(stream);
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
      if (this.#streams.delete(stream)) stream.cancel();
      return packets;
    };
  }
}
