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

test('with no audio at all the track is silence of the right length', () => {
  const track = assembleAudio([], 0, 2);
  assert.equal(track.length, 2 * 44100 * 4);
  assert.ok(track.every((byte) => byte === 0));
});
