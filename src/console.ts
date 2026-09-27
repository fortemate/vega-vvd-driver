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
    const socket = connect(options.port ?? 5554, options.host ?? '127.0.0.1');
    const queue = [`auth ${token}`, ...commands];
    const replies: string[] = [];
    let buffer = '';
    let greeted = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the emulator console did not answer in time'));
    }, options.timeoutMs ?? 10_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const next = () => {
      const command = queue.shift();
      if (command === undefined) {
        clearTimeout(timer);
        socket.end('quit\r\n');
        resolve(replies.slice(1)); // the first reply is to auth
        return;
      }
      socket.write(`${command}\r\n`);
    };
    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!finished(buffer)) return;
      const reply = buffer;
      buffer = '';
      if (!greeted) {
        // The banner ends with OK once the console is ready.
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
            `console refused "${sent.split(' ')[0]}": ${last.slice(2).trim()}`,
          ),
        );
        return;
      }
      replies.push(reply);
      next();
    });
  });

// Turns on the emulator's gRPC endpoint. Safe to repeat.
export const enableGrpc = async (
  grpcPort = 8554,
  options: ConsoleOptions = {},
): Promise<void> => {
  await runConsole([`grpc ${grpcPort}`], options);
};
