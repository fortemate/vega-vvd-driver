// The library: everything the `vvd` command and the MCP server are built from.
export { Device } from './device.ts';
export type { ConnectOptions, Frame, PressOptions } from './device.ts';
export {
  findEmulator,
  findEmulators,
  findProtoDirectory,
  NoDeviceError,
  parseDiscovery,
  runningDirectories,
} from './discovery.ts';
export type { Emulator, FindOptions } from './discovery.ts';
export { enableGrpc, runConsole } from './console.ts';
export type { ConsoleOptions } from './console.ts';
export {
  KEY_CODES,
  KeyError,
  parseKey,
  parseKeys,
  REMOTE_KEYS,
} from './keys.ts';
export type { Half, KeyStep } from './keys.ts';
export { hasFfmpeg, record } from './record.ts';
export type { RecordOptions, RecordResult } from './record.ts';
export { checkSafeArea, formatColour, parseColour } from './safearea.ts';
export type { Rgb, SafeAreaOptions, SafeAreaReport } from './safearea.ts';
export { encodePng } from './png.ts';
export { createServer, serveStdio } from './mcp.ts';
export { VERSION } from './version.ts';
