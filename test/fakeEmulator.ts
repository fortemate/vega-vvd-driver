// A fake EmulatorController on localhost, with a discovery file pointing at
// it, so the driver's gRPC paths can be tested without a device. It speaks
// test/fake/emulator_controller.proto.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
} from '@grpc/grpc-js';
import type {
  sendUnaryData,
  ServerUnaryCall,
  ServerWritableStream,
  ServiceDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

export const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fake');

// A made-up token: the tests check that it arrives, and that it leaks nowhere.
export const TOKEN = 'fake-token-for-tests';

export type Screen =
  // a new picture on every look
  | 'changing'
  // the same picture every time
  | 'still'
  // never answers, like a wedged emulator
  | 'silent'
  // answers `failAfter` times, then fails as if the emulator had gone
  | { failAfter: number };

type KeyRequest = { eventType: string; keyCode: number };
type ImageRequest = { format: string };

export type FakeEmulator = {
  // The directory with its discovery file, for `directories` options.
  directory: string;
  file: string;
  port: number;
  keys: KeyRequest[];
  authorizations: string[];
  screenshots: number;
  stop(): void;
};

export const startFakeEmulator = async (
  screen: Screen = 'changing',
): Promise<FakeEmulator> => {
  const definition = loadSync(join(PROTO_DIR, 'emulator_controller.proto'), {
    keepCase: true,
    enums: String,
    longs: String,
  });
  const { service } = (
    loadPackageDefinition(definition) as unknown as {
      android: {
        emulation: {
          control: {
            EmulatorController: { service: ServiceDefinition };
          };
        };
      };
    }
  ).android.emulation.control.EmulatorController;
  const timers = new Set<NodeJS.Timeout>();
  // Screenshots are stamped as if the display ran at 60 Hz, one frame per
  // look, so that frames taken within a millisecond still have their own time.
  const startUs = Date.now() * 1000;
  const server = new Server();
  const fake = {
    keys: [],
    authorizations: [],
    screenshots: 0,
  } as unknown as FakeEmulator;
  server.addService(service, {
    sendKey(
      call: ServerUnaryCall<KeyRequest, object>,
      callback: sendUnaryData<object>,
    ) {
      fake.authorizations.push(String(call.metadata.get('authorization')[0]));
      fake.keys.push({
        eventType: call.request.eventType,
        keyCode: call.request.keyCode,
      });
      callback(null, {});
    },
    getScreenshot(
      call: ServerUnaryCall<ImageRequest, object>,
      callback: sendUnaryData<object>,
    ) {
      fake.screenshots += 1;
      if (screen === 'silent') return;
      if (typeof screen === 'object' && fake.screenshots > screen.failAfter) {
        callback({
          code: status.UNAVAILABLE,
          details: 'the emulator went away',
        });
        return;
      }
      const shade = screen === 'still' ? 7 : fake.screenshots % 256;
      callback(null, {
        format: { format: call.request.format, width: 16, height: 16 },
        image: Buffer.alloc(16 * 16 * 3, shade),
        timestampUs: String(
          startUs + Math.round((fake.screenshots * 1e6) / 60),
        ),
      });
    },
    streamAudio(call: ServerWritableStream<object, object>) {
      const timer = setInterval(
        () =>
          call.write({
            timestamp: String(Date.now() * 1000),
            audio: Buffer.alloc(4 * 441, 1), // 10 ms
          }),
        10,
      );
      timers.add(timer);
      const stop = () => {
        clearInterval(timer);
        timers.delete(timer);
      };
      call.on('cancelled', stop);
      call.on('error', stop);
    },
  });
  fake.port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      '127.0.0.1:0',
      ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  fake.directory = mkdtempSync(join(tmpdir(), 'vvd-fake-'));
  // The test process's own pid, so the file counts as a running emulator.
  fake.file = join(fake.directory, `pid_${process.pid}.ini`);
  writeFileSync(
    fake.file,
    [
      'port.serial=5554',
      `grpc.port=${fake.port}`,
      `grpc.token=${TOKEN}`,
      'avd.name=fake',
    ].join('\n'),
  );
  fake.stop = () => {
    for (const timer of timers) clearInterval(timer);
    server.forceShutdown();
  };
  return fake;
};
