# vega-vvd-driver

Drive the Vega Virtual Device from scripts and AI agents: press remote keys, take screenshots, record video with sound, wait for the screen to change and check the TV safe area. A Node library, the `vvd` command and an MCP server.

> **Unofficial.** Not made, endorsed or supported by Amazon. Amazon, Fire TV and Vega are trademarks of Amazon.com, Inc. or its affiliates.

## Why

The Vega SDK's `vega` command installs and launches apps on the Vega Virtual Device (VVD), but has no command to press a remote key or take a screenshot. Amazon's [Appium Vega driver](https://developer.amazon.com/docs/vega/0.24/appium-install.html) does both, and much more: it runs UI tests that find elements, on the VVD and on a Fire TV Stick. It needs an Appium 2 server, the driver package and the device's automation toolkit switched on, with Node 22 or earlier.

This driver is for lighter jobs on the VVD: a key press or a screenshot from a shell script, a video with sound, every frame of an animation, and an AI coding agent that can see what it built. It talks to the Android emulator that the VVD is built on, through the emulator's own gRPC API and console, so there is nothing to install on the device and no server to run.

Its methods were worked out while building [Dice Chess for Fire TV](https://github.com/fortemate/dicechess-tv): scripts drove whole sessions with nobody at the emulator, took every screenshot of the game's gallery, checked its move animations frame by frame and recorded its [demo video](https://www.youtube.com/watch?v=Q7wWAmUp2Sc). The obstacles on the way are in that project's [friction log](https://fortemate.github.io/dicechess-tv/friction-log/) for Amazon, as FL-08, FL-09 and FL-28.

## Appium or this driver?

| To…                                                 | Use                    |
| --------------------------------------------------- | ---------------------- |
| find elements, read their text, run a test suite    | Appium                 |
| test on a Fire TV Stick                             | Appium                 |
| press keys or take a screenshot from a shell script | this driver, or Appium |
| record a video with sound                           | this driver            |
| capture every frame of an animation                 | this driver            |
| let an AI agent see and operate the VVD over MCP    | this driver            |
| check the TV safe area                              | this driver            |

## What you need

- The Vega SDK with its Virtual Device. The driver was built and tested with SDK 0.24.12112 on macOS (Apple silicon). The Linux locations are included but untested.
- Node 20 or later.
- ffmpeg, only for `record`.

## Install

```sh
npm install -g @fortemate/vega-vvd-driver
```

Or inside a project: `npm install --save-dev @fortemate/vega-vvd-driver`, then `npx vvd`.

To work on the driver itself, clone the repository, then run `npm ci` and `npm link`. Installing straight from Git with `npm install -g github:fortemate/vega-vvd-driver` does not work, at least with npm 11.19: for a global install from Git, npm runs the build without installing its dependencies, and it fails with `tsc: command not found`.

## Quick start

```sh
vega virtual-device start --no-gui   # the window is optional
vvd enable-grpc                      # needed after every start of the device
vvd screenshot home.png
vvd press down down ok
vvd record demo.mp4 --seconds 20
```

## Commands

| Command                                                    | What it does                                                                                                                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vvd devices`                                              | Lists running devices whose gRPC endpoint is on                                                                                                                                         |
| `vvd enable-grpc [--port 8554] [--console-port 5554]`      | Turns gRPC on through the emulator console. It is off after every start of the device                                                                                                   |
| `vvd press <key…> [--gap 450]`                             | Presses remote keys in order: `up down left right ok back menu playpause rewind fastforward`, a `KEY_*` name or an evdev code. `down*3` repeats, `ok:down` and `ok:up` hold and release |
| `vvd screenshot [file]`                                    | Saves the screen as a PNG                                                                                                                                                               |
| `vvd record <file> [--seconds 10] [--fps 30] [--no-audio]` | Records the screen with sound to an MP4. Needs ffmpeg                                                                                                                                   |
| `vvd frames <dir> [--seconds 3] [--max-frames 200]`        | Saves every distinct frame as a PNG, named by the emulator's time. The frames wait in memory until the capture ends: 6 MB each at the VVD's 1920x1080, and 2 GB at most                 |
| `vvd wait-change [--timeout 5000]`                         | Exits 0 once the screen changes, 1 on timeout                                                                                                                                           |
| `vvd safe-area [--background #rrggbb] [--margin 0.05]`     | Counts what sits in the outer 5% of each edge. Exits 0 when clear                                                                                                                       |
| `vvd mcp`                                                  | Runs the MCP server on stdio                                                                                                                                                            |

Quote a repeated key in a shell, `'down*3'`, or zsh reads the `*` as a file pattern. When several devices run, `--pid <n>` picks one; `enable-grpc` picks a device's console with `--console-port` instead. Errors exit with 2, so that a script can tell them from "no change" and "not clear", which exit with 1.

## For AI agents: the MCP server

The server lets an agent operate the device and see the result. With Claude Code:

```sh
claude mcp add vvd -- vvd mcp
```

Other MCP clients start the command `vvd` with the argument `mcp`. With the driver installed inside a project, the command is `npx vvd mcp`.

| Tool              | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `list_devices`    | The running devices with gRPC on                                    |
| `enable_grpc`     | Turns gRPC on after a start of the device                           |
| `press_keys`      | Presses keys; with `screenshot_after`, returns the resulting screen |
| `screenshot`      | The screen as a PNG image                                           |
| `wait_for_change` | Waits until the screen changes, then returns it                     |
| `record_video`    | Records an MP4 with sound                                           |
| `check_safe_area` | Counts what sits in the TV safe-area margin                         |

Then ask, for example: "Open Settings in the app on the Virtual Device, turn the music off and show me the screen."

A model chooses the arguments, so they are bounded: at most 100 key presses per call, recordings of up to 600 seconds, and `record_video` writes only a new `.mp4`, `.mov` or `.mkv` file, unless it is told to `overwrite` one. When the client cancels a call, its presses, wait or recording stop. `vvd mcp --pid <n>` ties the server to one device.

## As a library

```ts
import { Device, record } from '@fortemate/vega-vvd-driver';

const device = Device.connect(); // the newest running VVD with gRPC on
await device.press(['down', 'down', 'ok']);
const png = await device.screenshot('png');
await record(device, {
  file: 'demo.mp4',
  seconds: 10,
  onStart: () => device.press(['right*3']),
});
device.close();
```

`device.waitForChange()`, `device.frames()` and `checkSafeArea()` cover the rest. Every call has a deadline (10 seconds, or `callTimeoutMs` given to `Device.connect`), so a stuck emulator fails a call instead of hanging it. `press`, `waitForChange`, `frames` and `record` take an AbortSignal as `signal`, and a cancelled press still releases its key. `onStart` runs alongside the recording, which ends when both have. See `src/index.ts` for everything exported.

## Recipes

**Check an animation.** Start `vvd frames ./frames --seconds 3`, then trigger the animation. Each distinct frame lands as a PNG named by the emulator's own clock. The frames wait in memory while the capture runs, about 6 MB each at 1080p, and are written when it ends, because encoding one takes 20 to 200 ms and the screen would go unwatched meanwhile. The capture stops at 200 frames, about 1.2 GB, unless `--max-frames` says otherwise, and in any case before the frames held pass 2 GB, 321 frames at 1080p; the frames it has are written either way. On the VVD on 28 September 2026, with SDK 0.24.12112, the 220 ms pawn slide of Dice Chess's first tutorial move came through with the pawn in flight in 4 to 6 frames, 23 to 55 ms apart. A screenshot takes longer while the screen changes, and that sets the pace.

**Record a demo.** Script the presses, record while they run, and cut the best takes afterwards. Recording works without the device's window.

```sh
vvd record take.mp4 --seconds 30 &
sleep 2 && vvd press 'ok*20' --gap 1300
wait
```

**Check the safe area.** Open a screen of the app and run `vvd safe-area --background '#122737'` with the app's background colour. It works on screens with a solid background; the launcher's gradient does not count as one.

## What works, and what silently does not

Measured on the VVD with Vega SDK 0.24.12112 on macOS:

- **Keys.** The emulator's gRPC `sendKey`, with Linux evdev codes, reaches apps: it is the path the VVD's own on-screen remote uses. OK is `KEY_KPENTER`, and apps receive it as `kpenter`, not the `select` the remote's documentation names. `KEY_SELECT` and `KEY_OK` never arrive, because the emulator's virtual keyboard does not declare them. Back is `KEY_BACK`; `KEY_ESC` does not reach an app as Back.
- **Dead ends.** The emulator console's `event send`, QEMU's `send-key` and `inputd-cli` on the device all report success and never reach an app.
- **Home cannot be sent.** `KEY_HOMEPAGE` (172), `KEY_F1` and 170, the code Amazon's Appium documentation gives for Home, all leave the app on screen. To get back to the launcher, run `vega device launch-app -d VirtualDevice -a com.amazon.keplerlauncherapp.main`.
- **Screenshots.** `getScreenshot` returns 1920x1080. A running process polls it in RGB at about 57 screenshots a second of a still screen, 17 ms each, and at 16 to 43 a second while the screen changes, 23 to 61 ms each (measured on 28 September 2026). `vvd screenshot` takes about half a second, most of it starting up. The emulator's `streamScreenshot` has delivered only its first frame while the screen kept changing, so the driver polls instead.
- **Audio.** `streamAudio` sends nothing while the device is silent. `record` rebuilds the track on the video's clock from each packet's capture time and fills the gaps with silence, so a sound effect stays in sync.
- **gRPC.** The endpoint is off after every start of the VVD, and the discovery file that the driver reads appears only once `grpc <port>` has been sent to the console. `vvd enable-grpc` does that.

## Troubleshooting

- **"No running Vega Virtual Device with gRPC found."** Start the device, then run `vvd enable-grpc`.
- **"emulator_controller.proto not found."** Set `VVD_PROTO_DIR` to the directory in your Vega SDK that holds it (`…/vvd/images/tv/vmtools/agent/lib`).
- **Several devices.** Pick one with `--pid`, from `vvd devices`.
- **"The Vega Virtual Device did not answer in time."** The emulator is busy or stuck. Restart the device if it keeps happening.
- **`record` fails at once.** Install ffmpeg.

## How it works

A running emulator with gRPC on writes `pid_<pid>.ini` into a per-user directory (`~/Library/Caches/TemporaryItems/avd/running` on macOS). It holds the gRPC port and a bearer token. The driver reads it, loads `emulator_controller.proto` from your own Vega SDK, and calls the emulator's `EmulatorController` service. To turn gRPC on, it signs in to the emulator console on port 5554 with the token in `~/.emulator_console_auth_token`.

- Tokens are read at run time and never printed or logged. On the objects the library returns, the gRPC token is not enumerable, so it stays out of JSON and `util.inspect`. The console token goes only to a port that greets as an Android emulator console.
- No file from the Vega SDK is copied or bundled: Amazon licenses the SDK to each developer. The proto is Android emulator code under Apache-2.0, and it is loaded from your installation.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `mise run setup`, then `mise run check`; with a device running and gRPC on, `npm run test:device`. The unit tests run the gRPC, console and recording paths against fakes, so they need neither a device nor ffmpeg.

## Licence

[MIT](LICENSE). Made by Jegors Čemisovs at [Fortemate](https://github.com/fortemate).
