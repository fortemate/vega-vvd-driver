// The emulator console: a line-based TCP service on localhost (5554 for the
// first emulator). It authenticates with the token in
// ~/.emulator_console_auth_token, which is sent and never printed.
//
// The driver needs it for one thing: `grpc <port>` turns on the gRPC endpoint,
// which is off after every start of the VVD, and only then does the discovery
// file appear. Keys do not go through here: the console's `event send` is
// accepted and never reaches an app.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { consoleTokenFile } from './discovery.ts';

export type ConsoleOptions = {
  port?: number;
  host?: string;
  token?: string;
  timeoutMs?: number;
};

// Every reply ends with a line that starts with OK or KO.
const finished = (text: string): boolean =>
  /(^|\n)(OK|KO)[^\n]*\r?\n$/.test(text);

// Runs console commands in order and returns each reply. A command answered
// with KO rejects with the console's own message.
export const runConsole = (
  commands: readonly string[],
  options: ConsoleOptions = {},
): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const token =
      options.token ?? readFileSync(consoleTokenFile(), 'utf8').trim();
    const port = options.port ?? 5554;
    const socket = connect(port, options.host ?? '127.0.0.1');
    const queue = [`auth ${token}`, ...commands];
    const replies: string[] = [];
    let buffer = '';
    let greeted = false;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const fail = (error: Error) =>
      settle(() => {
        socket.destroy();
        reject(error);
      });
    const timer = setTimeout(
      () => fail(new Error('the emulator console did not answer in time')),
      options.timeoutMs ?? 10_000,
    );
    const next = () => {
      const command = queue.shift();
      if (command === undefined) {
        settle(() => {
          socket.end('quit\r\n');
          resolve(replies.slice(1)); // the first reply is to auth
        });
        return;
      }
      socket.write(`${command}\r\n`);
    };
    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('close', () =>
      fail(new Error('the emulator console closed the connection')),
    );
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!finished(buffer)) return;
      const reply = buffer;
      buffer = '';
      if (!greeted) {
        // An emulator console greets with lines that start "Android Console",
        // then OK. Whatever else answers on this port never gets the token.
        if (!reply.includes('Android Console')) {
          fail(new Error(`port ${port} is not an Android emulator console`));
          return;
        }
        greeted = true;
        next();
        return;
      }
      const last = reply.trimEnd().split('\n').pop() ?? '';
      if (last.startsWith('KO')) {
        const sent =
          replies.length === 0 ? 'auth' : commands[replies.length - 1];
        fail(
          new Error(
            `console refused "${sent.split(' ')[0]}": ${last.replace(/^KO:?\s*/, '').trim()}`,
          ),
        );
        return;
      }
      replies.push(reply);
      next();
    });
  });

// The emulator takes an even console port from 5554 to 5682.
export const isConsolePort = (port: number): boolean =>
  Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0;

// Turns on the emulator's gRPC endpoint. Safe to repeat.
export const enableGrpc = async (
  grpcPort = 8554,
  options: ConsoleOptions = {},
): Promise<void> => {
  if (!isConsolePort(options.port ?? 5554))
    throw new Error(
      'the emulator console port is an even number from 5554 to 5682',
    );
  if (!Number.isInteger(grpcPort) || grpcPort < 1024 || grpcPort > 65535)
    throw new Error('the gRPC port must be a whole number from 1024 to 65535');
  await runConsole([`grpc ${grpcPort}`], options);
};
