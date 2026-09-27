// Recording the VVD's screen, with its sound, to an MP4 file. Needs ffmpeg on
// the PATH.
//
// Frames are polled with getScreenshot and written to ffmpeg at a fixed frame
// rate, repeating the latest frame when the screen is still. The emulator's
// streamScreenshot was tried first and can stop delivering frames while the
// screen keeps changing; polling keeps up at about 90 screenshots a second at
// 1080p. The audio comes from streamAudio. The emulator sends nothing while
// the device is silent, so the track is rebuilt on the video's clock from each
// packet's capture time, with silence in the gaps.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioPacket, Device } from './device.ts';

export type RecordOptions = {
  // Where the MP4 goes.
  file: string;
  seconds: number;
  fps?: number;
  audio?: boolean;
  // Called once recording has begun, for example to start pressing keys.
  onStart?: () => void | Promise<void>;
};

export type RecordResult = {
  file: string;
  frames: number;
  screenshots: number;
  audioSeconds: number;
};

const run = (command: string, args: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} exited with ${code}: ${stderr.trim().slice(-500)}`,
            ),
          ),
    );
  });

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

export const hasFfmpeg = (): Promise<boolean> =>
  run('ffmpeg', ['-version']).then(
    () => true,
    () => false,
  );

export const record = async (
  device: Device,
  options: RecordOptions,
): Promise<RecordResult> => {
  if (!(await hasFfmpeg()))
    throw new Error(
      'recording needs ffmpeg on the PATH (for example: brew install ffmpeg)',
    );
  const fps = options.fps ?? 30;
  const withAudio = options.audio ?? true;
  const work = mkdtempSync(join(tmpdir(), 'vvd-record-'));
  try {
    const first = await device.screenshot('rgb');
    const size = `${first.width}x${first.height}`;
    const video = join(work, 'video.mp4');
    const encoder = spawn(
      'ffmpeg',
      [
        ['-loglevel', 'error', '-y'],
        ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', size, '-r', String(fps)],
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
    let encoderError = '';
    encoder.stderr.on(
      'data',
      (chunk: Buffer) => (encoderError += chunk.toString()),
    );
    const encoded = new Promise<void>((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `ffmpeg exited with ${code}: ${encoderError.trim().slice(-500)}`,
              ),
            ),
      );
    });

    const stopAudio = withAudio ? device.listen() : undefined;
    const startMs = Date.now();
    const endMs = startMs + options.seconds * 1000;
    let latest = first.data;
    let written = 0;
    let screenshots = 1;
    // Writes the latest frame until the video has caught up with the clock,
    // waiting for ffmpeg to drain when its input is full.
    const catchUp = async (untilMs: number) => {
      const due = Math.floor(((untilMs - startMs) / 1000) * fps);
      while (written < due) {
        written += 1;
        if (!encoder.stdin.write(latest))
          await new Promise<void>((resolve) =>
            encoder.stdin.once('drain', resolve),
          );
      }
    };
    await options.onStart?.();
    while (Date.now() < endMs) {
      const frame = await device.screenshot('rgb');
      screenshots += 1;
      if (frame.width === first.width && frame.height === first.height)
        latest = frame.data;
      await catchUp(Math.min(Date.now(), endMs));
    }
    await catchUp(endMs);
    encoder.stdin.end();
    await encoded;

    if (!stopAudio) {
      await run('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-i',
        video,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        options.file,
      ]);
      return {
        file: options.file,
        frames: written,
        screenshots,
        audioSeconds: 0,
      };
    }
    const packets = stopAudio();
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
        [options.file],
      ].flat(),
    );
    const heard = packets.reduce((sum, packet) => sum + packet.pcm.length, 0);
    return {
      file: options.file,
      frames: written,
      screenshots,
      audioSeconds: heard / FRAME_BYTES / SAMPLE_RATE,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
