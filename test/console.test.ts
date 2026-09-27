// The emulator console client against small TCP servers on localhost: the
// token goes to an Android console only, and a refusal or a hang-up is
// reported at once, without the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { enableGrpc, runConsole } from '../src/console.ts';

const TOKEN = 'console-token-for-tests';

const BANNER =
  'Android Console: Authentication required\r\n' +
  "Android Console: type 'auth <auth_token>' to authenticate\r\n" +
  'OK\r\n';

// A server that runs `onConnect` for each client and keeps what it was sent.
const serve = async (onConnect: (socket: Socket) => void) => {
  let received = '';
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    onConnect(socket);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    received: () => received,
    close: () => server.close(),
  };
};

test('the token goes only to an Android emulator console', async () => {
  const server = await serve((socket) => socket.write('OK\r\n'));
  try {
    await assert.rejects(
      runConsole(['grpc 8554'], { port: server.port, token: TOKEN }),
      /is not an Android emulator console/,
    );
    assert.ok(!server.received().includes(TOKEN));
  } finally {
    server.close();
  }
});

test('a console that hangs up fails at once, not at the timeout', async () => {
  const server = await serve((socket) => socket.destroy());
  try {
    const started = Date.now();
    await assert.rejects(
      runConsole(['grpc 8554'], { port: server.port, token: TOKEN }),
      /closed the connection/,
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.close();
  }
});

test('commands follow auth, and a refusal names the command, not the token', async () => {
  const server = await serve((socket) => {
    socket.write(BANNER);
    socket.on('data', (line: string) => {
      if (line.startsWith('auth ')) socket.write('OK\r\n');
      else if (line.startsWith('grpc ')) socket.write('KO: bad port\r\n');
    });
  });
  try {
    await assert.rejects(
      runConsole(['grpc 8554'], { port: server.port, token: TOKEN }),
      (error: Error) =>
        error.message === 'console refused "grpc": bad port' &&
        !error.message.includes(TOKEN),
    );
    assert.equal(server.received(), `auth ${TOKEN}\r\ngrpc 8554\r\n`);
  } finally {
    server.close();
  }
});

test('the replies come back in order', async () => {
  const server = await serve((socket) => {
    socket.write(BANNER);
    socket.on('data', (line: string) => {
      if (!line.startsWith('quit'))
        socket.write(`echo ${line.trim()}\r\nOK\r\n`);
    });
  });
  try {
    const replies = await runConsole(['grpc 8554'], {
      port: server.port,
      token: TOKEN,
    });
    assert.deepEqual(replies, ['echo grpc 8554\r\nOK\r\n']);
  } finally {
    server.close();
  }
});

test('enableGrpc checks both ports before it connects', async () => {
  await assert.rejects(enableGrpc(8554, { port: 5555 }), /even number/);
  await assert.rejects(enableGrpc(8554, { port: 5700 }), /even number/);
  await assert.rejects(enableGrpc(80, { port: 5554 }), /1024 to 65535/);
});
