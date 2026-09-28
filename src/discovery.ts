// Finding a running Vega Virtual Device. The VVD is built on the Android
// emulator, and a running emulator whose gRPC endpoint is on advertises itself
// in a discovery file, `pid_<pid>.ini`, in a per-user directory. The file holds
// the gRPC port and an access token; the token is read here and never printed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

export type Emulator = {
  pid: number;
  // The discovery file it was found in.
  file: string;
  grpcPort: number;
  // A bearer token for the gRPC endpoint. It is not enumerable, so it stays
  // out of JSON.stringify, util.inspect and object spreads; keep it out of
  // logs too.
  readonly grpcToken: string | undefined;
  // The emulator console, where `grpc <port>` turns the endpoint on.
  consolePort: number | undefined;
  avdName: string | undefined;
};

const userName = (): string | undefined => {
  try {
    return userInfo().username;
  } catch {
    return undefined; // no entry in the user database
  }
};

export type SystemFacts = {
  uid: number | undefined;
  user: string | undefined;
  tmp: string;
};

const systemFacts = (): SystemFacts => ({
  uid: process.getuid?.(),
  user: userName(),
  tmp: tmpdir(),
});

// Where a running emulator leaves its discovery file. The macOS location was
// measured with the VVD. The Linux ones are untested with a VVD: the runtime
// directory, then the Android emulator's fallbacks.
export const runningDirectories = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  system: SystemFacts = systemFacts(),
): string[] => {
  const { uid, user, tmp } = system;
  return [
    ...new Set(
      [
        join(home, 'Library/Caches/TemporaryItems/avd/running'),
        env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'avd/running') : '',
        uid === undefined ? '' : `/run/user/${uid}/avd/running`,
        user ? `/tmp/android-${user}/avd/running` : '',
        user ? join(tmp, `android-${user}`, 'avd/running') : '',
        join(home, '.android/avd/running'),
      ].filter(Boolean),
    ),
  ];
};

// A discovery file is `key=value` lines.
export const parseDiscovery = (text: string): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return fields;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const toPort = (value: string | undefined): number | undefined => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
};

export type FindOptions = {
  directories?: string[];
  // Keep only this emulator.
  pid?: number;
  // Decides whether a process is still running; replaceable in tests.
  alive?: (pid: number) => boolean;
};

// The emulator a discovery file describes, or undefined when the file names
// no gRPC port.
const readEmulator = (file: string, pid: number): Emulator | undefined => {
  const fields = parseDiscovery(readFileSync(file, 'utf8'));
  const grpcPort = toPort(fields.get('grpc.port'));
  if (grpcPort === undefined) return undefined;
  return Object.defineProperty(
    {
      pid,
      file,
      grpcPort,
      consolePort: toPort(fields.get('port.serial')),
      avdName: fields.get('avd.name') || undefined,
    },
    'grpcToken',
    { value: fields.get('grpc.token') || undefined, enumerable: false },
  ) as Emulator;
};

// The running emulators with gRPC on, newest first. Stale files left by an
// emulator that has exited are skipped.
export const findEmulators = (options: FindOptions = {}): Emulator[] => {
  const alive = options.alive ?? isAlive;
  const wanted = (pid: number) =>
    (options.pid === undefined || pid === options.pid) && alive(pid);
  const found: { emulator: Emulator; modified: number }[] = [];
  for (const directory of options.directories ?? runningDirectories()) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      // NaN for a name that is no discovery file.
      const pid = Number(/^pid_(\d+)\.ini$/.exec(name)?.[1]);
      if (Number.isNaN(pid) || !wanted(pid)) continue;
      const file = join(directory, name);
      const emulator = readEmulator(file, pid);
      if (emulator) found.push({ emulator, modified: statSync(file).mtimeMs });
    }
  }
  found.sort((a, b) => b.modified - a.modified);
  return found.map(({ emulator }) => emulator);
};

export class NoDeviceError extends Error {
  constructor() {
    super(
      'No running Vega Virtual Device with gRPC found. Start it (vega virtual-device start), ' +
        'then turn gRPC on with `vvd enable-grpc`: it is off after every start of the device.',
    );
    this.name = 'NoDeviceError';
  }
}

// The one emulator to drive: the given pid, or the newest.
export const findEmulator = (options: FindOptions = {}): Emulator => {
  const [emulator] = findEmulators(options);
  if (!emulator) throw new NoDeviceError();
  return emulator;
};

// The emulator's gRPC API is described by emulator_controller.proto, which
// ships inside the Vega SDK (it is AOSP code under Apache-2.0). It is loaded
// from the developer's own SDK rather than copied here. VVD_PROTO_DIR
// overrides the search.
const inVersion = (versionDir: string) =>
  join(versionDir, 'vvd/images/tv/vmtools/agent/lib');

const hasProto = (dir: string) =>
  existsSync(join(dir, 'emulator_controller.proto'));

// The SDK's own record of where it lives and which version is the default.
const configuredVersion = (home: string): string | undefined => {
  try {
    const config = JSON.parse(
      readFileSync(join(home, 'vega/config.json'), 'utf8'),
    ) as { sdkPath?: string; defaultVersion?: string };
    const [channel, version] = (config.defaultVersion ?? '').split('@');
    return config.sdkPath && channel && version
      ? join(config.sdkPath, 'vega-sdk', channel, version)
      : undefined;
  } catch {
    return undefined; // no config, or an unreadable one: scan instead
  }
};

// Directories only: a stray file, such as Finder's .DS_Store, is skipped.
const subdirectories = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            statSync(join(dir, entry.name), {
              throwIfNoEntry: false,
            })?.isDirectory() === true),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

// Every installed version, newest first by number: 0.24 comes before 0.9.
const installedVersions = (sdkRoot: string): string[] =>
  subdirectories(sdkRoot).flatMap((channel) =>
    subdirectories(join(sdkRoot, channel))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(sdkRoot, channel, version)),
  );

export const findProtoDirectory = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string => {
  if (env.VVD_PROTO_DIR) return env.VVD_PROTO_DIR;
  const configured = configuredVersion(home);
  if (configured && hasProto(inVersion(configured)))
    return inVersion(configured);
  const found = installedVersions(join(home, 'vega/sdk/vega-sdk'))
    .map(inVersion)
    .find(hasProto);
  if (!found)
    throw new Error(
      'emulator_controller.proto not found in the Vega SDK. Install the SDK, or set VVD_PROTO_DIR ' +
        'to the directory that holds it.',
    );
  return found;
};

// The emulator console's token, which authenticates `auth <token>`.
export const consoleTokenFile = (home: string = homedir()): string =>
  join(home, '.emulator_console_auth_token');
