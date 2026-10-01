// The pure parts of screenshots and recording: the safe-area check, the PNG
// encoder and the audio track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../src/png.ts';
import { assembleAudio } from '../src/record.ts';
import { checkSafeArea, formatColour, parseColour } from '../src/safearea.ts';

const W = 100;
const H = 60;

const screen = (background: [number, number, number]) => {
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set(background, i * 3);
  return rgb;
};

const paint = (
  rgb: Buffer,
  x: number,
  y: number,
  colour: [number, number, number],
) => rgb.set(colour, (y * W + x) * 3);

test('a screen with nothing in its margins is clear', () => {
  const rgb = screen([18, 39, 55]);
  paint(rgb, 50, 30, [255, 255, 255]); // content in the middle
  const report = checkSafeArea(rgb, W, H);
  assert.equal(report.clear, true);
  assert.deepEqual(report.background, [18, 39, 55]);
});

test('content in a margin is counted on its edge', () => {
  const rgb = screen([18, 39, 55]);
  paint(rgb, 1, 30, [255, 255, 255]); // inside the left 5 px
  paint(rgb, 50, 59, [255, 255, 255]); // inside the bottom 3 px
  const report = checkSafeArea(rgb, W, H);
  assert.equal(report.clear, false);
  assert.equal(report.left, 1);
  assert.equal(report.bottom, 1);
  assert.equal(report.right, 0);
  assert.equal(report.top, 0);
});

test('small colour differences are background, and the background can be given', () => {
  const rgb = screen([18, 39, 55]);
  paint(rgb, 0, 0, [20, 41, 57]);
  assert.equal(checkSafeArea(rgb, W, H).clear, true);
  assert.equal(
    checkSafeArea(rgb, W, H, { background: [0, 0, 0] }).clear,
    false,
  );
});

test('colours are read and written as #rrggbb', () => {
  assert.deepEqual(parseColour('#122737'), [18, 39, 55]);
  assert.deepEqual(parseColour('122737'), [18, 39, 55]);
  assert.equal(formatColour([18, 39, 55]), '#122737');
  assert.throws(() => parseColour('blue'));
});

test('the PNG encoder writes a valid RGB image', () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]); // 2x2
  const png = encodePng(2, 2, rgb);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  // IDAT holds each row behind a filter byte of 0.
  const idat = png.indexOf('IDAT');
  const length = png.readUInt32BE(idat - 4);
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.deepEqual([...rows], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
});

const tone = (frames: number, value: number) => {
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i++) pcm.writeInt16LE(value, i * 2);
  return pcm;
};

test('audio packets land where they were captured, with silence between them', () => {
  const start = 1_000_000_000;
  const track = assembleAudio(
    [
      { timestampUs: start, pcm: tone(441, 100) }, // 0 to 10 ms
      { timestampUs: start + 500_000, pcm: tone(441, 200) }, // 500 ms
    ],
    start,
    1,
  );
  assert.equal(track.length, 44100 * 4);
  assert.equal(track.readInt16LE(0), 100);
  assert.equal(track.readInt16LE(441 * 4), 0); // the gap stays silent
  assert.equal(track.readInt16LE(22050 * 4), 200);
});

test('audio before the start is cut, and past the end is dropped', () => {
  const start = 2_000_000;
  const track = assembleAudio(
    [
      { timestampUs: start - 10_000, pcm: tone(882, 7) }, // 10 ms early, 20 ms long
      { timestampUs: start + 2_000_000, pcm: tone(441, 9) }, // after the end
    ],
    start,
    1,
  );
  assert.equal(track.readInt16LE(0), 7);
  assert.equal(track.readInt16LE(441 * 4), 0);
  assert.equal(track.length, 44100 * 4);
});

// Packets whose frames count up from `first`, on both channels, so that a test
// can tell whether every frame landed in order.
const counted = (frames: number, first: number) => {
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(first + i, i * 4);
    pcm.writeInt16LE(first + i, i * 4 + 2);
  }
  return pcm;
};

const frameAt = (track: Buffer, frame: number) => track.readInt16LE(frame * 4);

// What the VVD sends while a sound plays (#13): packets of 512 frames whose
// capture times wander by up to 10 ms around where the packet before ends.
const JITTER_MS = [9, -7, 3, -10, 6, -2, 10, -9, 1, -5, 8, -4];
const wandering = (start: number, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => ({
    timestampUs: Math.round(
      start +
        ((i * 512) / 44100) * 1e6 +
        JITTER_MS[i % JITTER_MS.length] * 1000,
    ),
    pcm: counted(512, from + i * 512),
  }));

test('packets whose capture times wander are laid back to back, with no hole and nothing lost', () => {
  const start = 5_000_000;
  const packets = wandering(start + 200_000, 40);
  const track = assembleAudio(packets, start, 1);
  const first = Math.round(0.2 * 44100);
  // Within a few frames of where the sound started, by the median.
  let at = first - 500;
  while (frameAt(track, at) === 0) at++;
  assert.ok(Math.abs(at - first) <= 441, `starts ${at - first} frames off`);
  for (let i = 0; i < 40 * 512; i++)
    assert.equal(frameAt(track, at + i), 1 + i, `frame ${i}`);
  assert.equal(frameAt(track, at + 40 * 512), 0);
});

test('a silence between two sounds stays where it was', () => {
  const start = 0;
  const first = wandering(start, 10);
  // 300 ms after the first sound ends, the second begins.
  const later = ((10 * 512) / 44100) * 1e6 + 300_000;
  const second = wandering(start + later, 10, 20_001);
  const track = assembleAudio([...first, ...second], start, 1);
  const secondAt = Math.round((later / 1e6) * 44100);
  let at = secondAt - 600;
  while (frameAt(track, at) !== 20_001) at++;
  assert.ok(
    Math.abs(at - secondAt) <= 441,
    `second sound ${at - secondAt} frames off`,
  );
  assert.equal(frameAt(track, at - 1), 0);
  assert.equal(frameAt(track, Math.round((later / 2 / 1e6) * 44100)), 0);
});

test('a stream that starts with small packets keeps the rest of the sound on the clock, with no hole after its start', () => {
  const start = 0;
  // Twelve packets of 55 frames, 10 ms apart, so that their times run 135 ms
  // ahead of their audio, then the usual 512-frame packets, whose times say
  // where the sound really is.
  const small = Array.from({ length: 12 }, (_, i) => ({
    timestampUs: 100_000 + i * 10_000,
    pcm: counted(55, 1 + i * 55),
  }));
  const steadyStart = 250_000;
  const rest = Array.from({ length: 60 }, (_, i) => ({
    timestampUs: Math.round(steadyStart + ((i * 512) / 44100) * 1e6),
    pcm: counted(512, 661 + i * 512),
  }));
  const track = assembleAudio([...small, ...rest], start, 1);
  const steadyAt = Math.round((steadyStart / 1e6) * 44100);
  // The first 512-frame packet lands at its own time, and the small ones just
  // before it, back to back: every frame in order.
  assert.equal(frameAt(track, steadyAt), 661);
  assert.equal(frameAt(track, steadyAt - 660), 1);
  assert.equal(frameAt(track, steadyAt - 661), 0);
  for (let i = 0; i < 660 + 60 * 512; i++)
    assert.equal(frameAt(track, steadyAt - 660 + i), 1 + i, `frame ${i}`);
});

test('a long sound that drifts from the clock is put back on it', () => {
  const start = 0;
  // Capture times that run 2% ahead of the audio, for 10 s.
  const count = Math.round((10 * 44100) / 512);
  const packets = Array.from({ length: count }, (_, i) => ({
    timestampUs: Math.round(((i * 512) / 44100) * 1e6 * 1.02),
    pcm: counted(512, 1 + (i % 50) * 512),
  }));
  const track = assembleAudio(packets, start, 11);
  // The last packet is no further from its time than the drift allowed.
  const last = packets.at(-1) as { timestampUs: number };
  const lastAt = Math.round((last.timestampUs / 1e6) * 44100);
  const value = 1 + ((count - 1) % 50) * 512;
  let found = -1;
  for (let at = lastAt - 6000; at <= lastAt + 6000; at++)
    if (frameAt(track, at) === value && frameAt(track, at + 1) === value + 1) {
      found = at;
      break;
    }
  assert.ok(found >= 0, 'the last packet is within 136 ms of its time');
  assert.ok(
    Math.abs(found - lastAt) <= 4410 + 441,
    `${found - lastAt} frames off`,
  );
});

test('with no audio at all the track is silence of the right length', () => {
  const track = assembleAudio([], 0, 2);
  assert.equal(track.length, 2 * 44100 * 4);
  assert.ok(track.every((byte) => byte === 0));
});
