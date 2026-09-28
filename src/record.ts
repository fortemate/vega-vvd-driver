// Recording the VVD's screen, with its sound, to a video file. Needs ffmpeg on
// the PATH.
//
// Frames are polled with getScreenshot and written to ffmpeg at a fixed frame
// rate, repeating the latest frame when the screen is still. The emulator's
// streamScreenshot was tried first and can stop delivering frames while the
// screen keeps changing. Polling does not stop: on the VVD a 1080p screenshot
// takes about 17 ms, or 23 to 61 ms while the screen changes. The audio comes
// from streamAudio. The emulator sends nothing while the device is silent, so
// the track is rebuilt on the video's clock from each packet's capture time,
// with silence in the gaps.
//
// However a recording ends, it cleans up after itself: ffmpeg is stopped, the
// audio stream is cancelled and the working directory is removed.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import {
  accessSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { CALL_TIMEOUT_MS, type AudioPacket, type Device } from './device.ts';

export type RecordOptions = {
  // Where the video goes. ffmpeg picks the container from the extension.
  file: string;
  seconds: number;
  fps?: number;
  audio?: boolean;
  // Runs once the first frame is in, alongside the recording: for example, to
  // press keys. The recording resolves when both have finished.
  onStart?: () => void | Promise<void>;
  // Stops the recording early; it then rejects with the signal's reason.
  signal?: AbortSignal;
};

export type RecordResult = {
  // The video's absolute path.
  file: string;
  frames: number;
  screenshots: number;
  // How much of the recording the device's audio covered.
  audioSeconds: number;
};

type Process = ChildProcessByStdio<Writable | null, null, Readable>;

// Settles when the process has ended: resolves on exit code 0, and otherwise
// rejects with the end of what it wrote to stderr.
const ended = (child: Process, name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${name} exited with ${code ?? signal}: ${stderr.trim().slice(-500)}`,
            ),
          ),
    );
  });

const run = (command: string, args: readonly string[], signal?: AbortSignal) =>
  ended(
    spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], signal }),
    command,
  );

// Waits for a promise, or rejects as soon as the signal fires.
const abortable = <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4; // 16-bit stereo

// Lays audio packets on a timeline that starts at `startUs` and lasts
// `seconds`, as 16-bit stereo PCM: silence where nothing arrived, and a packet
// that starts earlier than the audio before it overwrites the overlap. Packets
// captured before the start are cut; the result is exactly as long as asked.
export const assembleAudio = (
  packets: readonly AudioPacket[],
  startUs: number,
  seconds: number,
): Buffer => {
  const track = Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * FRAME_BYTES);
  for (const packet of packets) {
    const frames = Math.floor(packet.pcm.length / FRAME_BYTES);
    let offset = Math.round(
      ((packet.timestampUs - startUs) / 1e6) * SAMPLE_RATE,
    );
    let from = 0;
    if (offset < 0) {
      from = -offset;
      offset = 0;
    }
    if (from >= frames || offset * FRAME_BYTES >= track.length) continue;
    packet.pcm.copy(
      track,
      offset * FRAME_BYTES,
      from * FRAME_BYTES,
      frames * FRAME_BYTES,
    );
  }
  return track;
};

// How many seconds of the window from `startUs` the packets cover.
export const audioWithin = (
  packets: readonly AudioPacket[],
  startUs: number,
  seconds: number,
): number => {
  const endUs = startUs + seconds * 1e6;
  let covered = 0;
  for (const packet of packets) {
    const lengthUs =
      (Math.floor(packet.pcm.length / FRAME_BYTES) / SAMPLE_RATE) * 1e6;
    const from = Math.max(packet.timestampUs, startUs);
    const to = Math.min(packet.timestampUs + lengthUs, endUs);
    if (to > from) covered += to - from;
  }
  return covered / 1e6;
};

export const hasFfmpeg = (): Promise<boolean> =>
  run('ffmpeg', ['-version']).then(
    () => true,
    () => false,
  );

// The output as an absolute path, in a directory that can be written: checked
// before anything is recorded, not after.
const outputPath = (file: string): string => {
  const path = resolve(file);
  try {
    accessSync(dirname(path), constants.W_OK);
  } catch {
    throw new Error(`cannot write to ${dirname(path)}`);
  }
  return path;
};

export const record = async (
  device: Device,
  options: RecordOptions,
): Promise<RecordResult> => {
  const { signal } = options;
  const output = outputPath(options.file);
  // "file:" keeps ffmpeg from reading a name such as "http://…" as a URL.
  const target = `file:${output}`;
  if (!(await hasFfmpeg()))
    throw new Error(
      'recording needs ffmpeg on the PATH (for example: brew install ffmpeg)',
    );
  const fps = options.fps ?? 30;
  const withAudio = options.audio ?? true;
  const work = mkdtempSync(join(tmpdir(), 'vvd-record-'));
  let encoder: ChildProcessByStdio<Writable, null, Readable> | undefined;
  let encoded: Promise<void> | undefined;
  let stopAudio: (() => AudioPacket[]) | undefined;
  try {
    const first = await device.screenshot('rgb', { signal });
    const video = join(work, 'video.mp4');
    encoder = spawn(
      'ffmpeg',
      [
        ['-loglevel', 'error', '-y'],
        [
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-s',
          `${first.width}x${first.height}`,
          '-r',
          String(fps),
        ],
        ['-i', 'pipe:0'],
        [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '18',
          '-pix_fmt',
          'yuv420p',
        ],
        [video],
      ].flat(),
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const stdin = encoder.stdin;
    encoded = ended(encoder, 'ffmpeg');
    // Awaited below. Until then, an early exit must not crash the process.
    encoded.catch(() => {});
    // A broken pipe means ffmpeg has gone, and `encoded` says why.
    stdin.on('error', () => {});
    let finishing = false;
    // Rejects when ffmpeg stops before it has been asked to.
    const died = encoded.then(() => {
      if (!finishing)
        throw new Error('ffmpeg stopped before the recording ended');
    });
    died.catch(() => {});
    const write = async (chunk: Buffer) => {
      if (stdin.write(chunk)) return;
      try {
        await Promise.race([once(stdin, 'drain', { signal }), died]);
      } catch (error) {
        // A broken pipe: ffmpeg's own exit, if it comes soon, says more.
        if (!signal?.aborted) await Promise.race([died, sleep(1000)]);
        throw error;
      }
    };

    stopAudio = withAudio ? device.listen() : undefined;
    const startMs = Date.now();
    const endMs = startMs + options.seconds * 1000;
    let latest = first.data;
    let written = 1;
    let screenshots = 1;
    await write(latest);
    // Writes the latest frame until the video has caught up with the clock.
    const catchUp = async (untilMs: number) => {
      const due = Math.floor(((untilMs - startMs) / 1000) * fps);
      while (written < due) {
        written += 1;
        await write(latest);
      }
    };
    // The caller's actions run alongside the recording, not before it.
    let startFailure: { error: unknown } | undefined;
    const started = (async () => options.onStart?.())();
    started.catch((error: unknown) => (startFailure = { error }));
    while (Date.now() < endMs) {
      signal?.throwIfAborted();
      if (startFailure) throw startFailure.error;
      const frame = await device
        .screenshot('rgb', {
          signal,
          deadline: Math.min(Date.now() + CALL_TIMEOUT_MS, endMs + 1000),
        })
        .catch((error: unknown) => {
          // A screenshot that runs out of time after the end ends the loop.
          if ((error as Error).name === 'TimeoutError' && Date.now() >= endMs)
            return undefined;
          throw error;
        });
      if (!frame) break;
      screenshots += 1;
      if (frame.width === first.width && frame.height === first.height)
        latest = frame.data;
      await catchUp(Math.min(Date.now(), endMs));
    }
    await catchUp(endMs);
    const packets = stopAudio?.() ?? [];
    stopAudio = undefined;
    finishing = true;
    stdin.end();
    await abortable(encoded, signal);
    await abortable(started, signal);

    if (!withAudio) {
      await run(
        'ffmpeg',
        [
          ['-loglevel', 'error', '-y', '-i', video],
          ['-c', 'copy', '-movflags', '+faststart', target],
        ].flat(),
        signal,
      );
      return { file: output, frames: written, screenshots, audioSeconds: 0 };
    }
    const raw = join(work, 'audio.raw');
    writeFileSync(raw, assembleAudio(packets, startMs * 1000, options.seconds));
    await run(
      'ffmpeg',
      [
        ['-loglevel', 'error', '-y', '-i', video],
        ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', raw],
        [
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-t',
          String(options.seconds),
          '-movflags',
          '+faststart',
        ],
        [target],
      ].flat(),
      signal,
    );
    return {
      file: output,
      frames: written,
      screenshots,
      audioSeconds: audioWithin(packets, startMs * 1000, options.seconds),
    };
  } finally {
    stopAudio?.();
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) {
      encoder.stdin.destroy();
      encoder.kill('SIGKILL');
    }
    await encoded?.catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
};
