// Checking a screen against the television's safe area. Amazon's Fire TV
// guidance keeps content out of the outer 5% of each edge, which a television
// may crop (overscan). This counts, per edge, the pixels in that margin that
// are not the background.

export type Rgb = readonly [number, number, number];

export type SafeAreaReport = {
  background: Rgb;
  // Pixels in each margin band that differ from the background.
  left: number;
  right: number;
  top: number;
  bottom: number;
  clear: boolean;
};

export type SafeAreaOptions = {
  // The screen's background. Found as the most common colour in the margins
  // when not given.
  background?: Rgb;
  // The margin as a fraction of each dimension.
  margin?: number;
  // How far a channel may differ and still count as background.
  tolerance?: number;
};

export const parseColour = (text: string): Rgb => {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!match) throw new Error(`cannot read colour "${text}": use #rrggbb`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

export const formatColour = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

type Band = { x: number; y: number; width: number; height: number };

const bands = (width: number, height: number, margin: number) => {
  const across = Math.round(width * margin);
  const down = Math.round(height * margin);
  return {
    left: { x: 0, y: 0, width: across, height },
    right: { x: width - across, y: 0, width: across, height },
    top: { x: 0, y: 0, width, height: down },
    bottom: { x: 0, y: height - down, width, height: down },
  } satisfies Record<string, Band>;
};

const mostCommon = (rgb: Buffer, width: number, all: Band[]): Rgb => {
  const counts = new Map<number, number>();
  for (const band of all)
    for (let y = band.y; y < band.y + band.height; y += 2)
      for (let x = band.x; x < band.x + band.width; x += 2) {
        const at = (y * width + x) * 3;
        const key = (rgb[at] << 16) | (rgb[at + 1] << 8) | rgb[at + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts)
    if (count > bestCount) [best, bestCount] = [key, count];
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
};

// `rgb` is RGB888 rows, top to bottom, as Device.screenshot('rgb') returns.
export const checkSafeArea = (
  rgb: Buffer,
  width: number,
  height: number,
  options: SafeAreaOptions = {},
): SafeAreaReport => {
  if (rgb.length < width * height * 3)
    throw new Error(
      `expected ${width}x${height} RGB data, got ${rgb.length} bytes`,
    );
  const edges = bands(width, height, options.margin ?? 0.05);
  const background =
    options.background ?? mostCommon(rgb, width, Object.values(edges));
  const tolerance = options.tolerance ?? 6;
  const count = (band: Band) => {
    let outside = 0;
    for (let y = band.y; y < band.y + band.height; y++)
      for (let x = band.x; x < band.x + band.width; x++) {
        const at = (y * width + x) * 3;
        if (
          Math.abs(rgb[at] - background[0]) > tolerance ||
          Math.abs(rgb[at + 1] - background[1]) > tolerance ||
          Math.abs(rgb[at + 2] - background[2]) > tolerance
        )
          outside += 1;
      }
    return outside;
  };
  const left = count(edges.left);
  const right = count(edges.right);
  const top = count(edges.top);
  const bottom = count(edges.bottom);
  return {
    background,
    left,
    right,
    top,
    bottom,
    clear: left + right + top + bottom === 0,
  };
};
