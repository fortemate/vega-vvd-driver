#!/usr/bin/env node
// The executable behind `vvd`. Kept apart from cli.ts so that the tests can
// import the command line without running it.
import { main } from './cli.ts';

try {
  const code = await main(process.argv.slice(2));
  // -1: a long-running command (the MCP server) that exits on its own.
  if (code >= 0) process.exitCode = code;
} catch (error) {
  // 2, so that scripts can tell an error from wait-change's "no change".
  console.error(`vvd: ${(error as Error).message ?? String(error)}`);
  process.exitCode = 2;
}
