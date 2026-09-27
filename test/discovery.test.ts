import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findEmulator,
  findEmulators,
  findProtoDirectory,
  NoDeviceError,
  parseDiscovery,
  runningDirectories,
} from '../src/discovery.ts';

const INI = [
  'emulator.build=12345',
  'port.serial=5554',
  'port.adb=5555',
  'avd.name=<build>',
  'grpc.port=8554',
  'grpc.token=secret-token',
].join('\n');

const directory = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'vvd-discovery-'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
};

test('a discovery file is read as key=value lines', () => {
  const fields = parseDiscovery(
    'a=1\r\nb = two\nno equals\n=empty key\nc=x=y\n',
  );
  assert.equal(fields.get('a'), '1');
  assert.equal(fields.get('b'), 'two');
  assert.equal(fields.get('c'), 'x=y');
  assert.equal(fields.size, 3);
});

test('a running emulator is found with its ports and token', () => {
  const dir = directory({ 'pid_4242.ini': INI, 'notes.txt': 'ignored' });
  const [emulator] = findEmulators({ directories: [dir], alive: () => true });
  assert.equal(emulator.pid, 4242);
  assert.equal(emulator.grpcPort, 8554);
  assert.equal(emulator.consolePort, 5554);
  assert.equal(emulator.grpcToken, 'secret-token');
  assert.equal(emulator.avdName, '<build>');
});

test('files of exited emulators and files without a gRPC port are skipped', () => {
  const dir = directory({
    'pid_1.ini': INI,
    'pid_2.ini': 'port.serial=5556\n',
    'pid_3.ini': INI,
  });
  const found = findEmulators({
    directories: [dir],
    alive: (pid) => pid !== 1,
  });
  assert.deepEqual(
    found.map((emulator) => emulator.pid),
    [3],
  );
});

test('the newest emulator comes first, and one can be picked by pid', () => {
  const dir = directory({ 'pid_10.ini': INI, 'pid_20.ini': INI });
  utimesSync(join(dir, 'pid_10.ini'), new Date(1000), new Date(1000));
  const options = { directories: [dir], alive: () => true };
  assert.deepEqual(
    findEmulators(options).map((e) => e.pid),
    [20, 10],
  );
  assert.equal(findEmulator({ ...options, pid: 10 }).pid, 10);
});

test('no emulator is a clear error that says how to turn gRPC on', () => {
  assert.throws(
    () => findEmulator({ directories: [directory({})] }),
    (error: unknown) =>
      error instanceof NoDeviceError &&
      /enable-grpc/.test((error as Error).message),
  );
});

test('discovery looks in the macOS and Linux locations', () => {
  const dirs = runningDirectories(
    { XDG_RUNTIME_DIR: '/run/user/1000' },
    '/home/me',
  );
  assert.deepEqual(dirs, [
    '/home/me/Library/Caches/TemporaryItems/avd/running',
    '/run/user/1000/avd/running',
    '/home/me/.android/avd/running',
  ]);
  assert.equal(runningDirectories({}, '/home/me').length, 2);
});

test('the proto is found through the SDK config, or VVD_PROTO_DIR', () => {
  const home = mkdtempSync(join(tmpdir(), 'vvd-home-'));
  const lib = join(
    home,
    'sdk/vega-sdk/main/0.24.1/vvd/images/tv/vmtools/agent/lib',
  );
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'emulator_controller.proto'), 'syntax = "proto3";');
  mkdirSync(join(home, 'vega'));
  writeFileSync(
    join(home, 'vega/config.json'),
    JSON.stringify({
      sdkPath: join(home, 'sdk'),
      defaultVersion: 'main@0.24.1',
    }),
  );
  assert.equal(findProtoDirectory({}, home), lib);
  assert.equal(
    findProtoDirectory({ VVD_PROTO_DIR: '/custom' }, home),
    '/custom',
  );
  assert.throws(
    () => findProtoDirectory({}, mkdtempSync(join(tmpdir(), 'vvd-empty-'))),
    /VVD_PROTO_DIR/,
  );
});
