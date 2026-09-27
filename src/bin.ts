#!/usr/bin/env node
// The executable behind `vvd`. Kept apart from cli.ts so that the tests can
// import the command line without running it.
import { main } from './cli.ts';

main(process.argv.slice(2)).then(
  (code) => {
    // -1: a long-running command (the MCP server) that exits on its own.
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`vvd: ${(error as Error).message ?? String(error)}`);
    process.exitCode = 1;
  },
);
