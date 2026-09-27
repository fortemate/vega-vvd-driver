// Remote keys by name. The VVD takes Linux evdev key codes through the
// emulator's gRPC `sendKey`, the path its on-screen remote uses.
//
// Measured on the VVD (Vega SDK 0.24):
// - OK is KEY_KPENTER, which is what the on-screen remote sends; apps receive
//   it as `kpenter`, not the `select` that the remote documentation names.
//   KEY_SELECT and KEY_OK are not declared by the emulator's virtual keyboard,
//   so they never arrive.
// - Back is KEY_BACK. KEY_ESC does not reach an app as Back over gRPC.

export const KEY_CODES: Readonly<Record<string, number>> = {
  KEY_ESC: 1,
  KEY_ENTER: 28,
  KEY_F1: 59,
  KEY_F2: 60,
  KEY_F3: 61,
  KEY_F4: 62,
  KEY_F5: 63,
  KEY_KPENTER: 96,
  KEY_UP: 103,
  KEY_LEFT: 105,
  KEY_RIGHT: 106,
  KEY_DOWN: 108,
  KEY_MENU: 139,
  KEY_BACK: 158,
  KEY_PLAYPAUSE: 164,
  KEY_REWIND: 168,
  KEY_HOMEPAGE: 172,
  KEY_FASTFORWARD: 208,
};

// The remote's buttons, by the names a script would use.
export const REMOTE_KEYS: Readonly<Record<string, string>> = {
  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  ok: 'KEY_KPENTER',
  select: 'KEY_KPENTER',
  back: 'KEY_BACK',
  menu: 'KEY_MENU',
  playpause: 'KEY_PLAYPAUSE',
  rewind: 'KEY_REWIND',
  fastforward: 'KEY_FASTFORWARD',
};

export type Half = 'press' | 'down' | 'up';

export type KeyStep = {
  // What was asked for, for messages.
  name: string;
  code: number;
  half: Half;
};

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

// Own properties only: `constructor` or `__proto__` must not pass for a key.
const codeOf = (name: string): number => {
  const lower = name.toLowerCase();
  if (Object.hasOwn(REMOTE_KEYS, lower)) return KEY_CODES[REMOTE_KEYS[lower]];
  const upper = name.toUpperCase();
  if (Object.hasOwn(KEY_CODES, upper)) return KEY_CODES[upper];
  if (/^\d+$/.test(name)) {
    const code = Number(name);
    if (code > 0 && code < 0x300) return code;
  }
  throw new KeyError(
    `unknown key "${name}": use ${Object.keys(REMOTE_KEYS).join(', ')}, a KEY_* name or an evdev code`,
  );
};

// Parses one key argument:
//   ok        press and release
//   ok:down   only the press, to hold a key
//   ok:up     only the release
//   down*3    press three times
export const parseKey = (argument: string): KeyStep[] => {
  const match = /^([^:*]+)(?::(down|up))?(?:\*(\d+))?$/i.exec(argument.trim());
  if (!match) throw new KeyError(`cannot read key "${argument}"`);
  const [, name, half, times] = match;
  const count = times === undefined ? 1 : Number(times);
  if (count < 1 || count > 100)
    throw new KeyError(`repeat count in "${argument}" must be 1 to 100`);
  const step: KeyStep = {
    name,
    code: codeOf(name),
    half: (half?.toLowerCase() as Half | undefined) ?? 'press',
  };
  return Array.from({ length: count }, () => step);
};

export const parseKeys = (argumentsList: readonly string[]): KeyStep[] =>
  argumentsList.flatMap(parseKey);
