# vega-vvd-driver

Drive the Vega Virtual Device from scripts and AI agents: press remote keys, take screenshots, record video with sound, wait for the screen to change and check the TV safe area. A Node library, the `vvd` command and an MCP server.

> **Unofficial.** Not made, endorsed or supported by Amazon. Amazon, Fire TV and Vega are trademarks of Amazon.com, Inc. or its affiliates.

## Why

The Vega SDK's `vega` command installs and launches apps on the Vega Virtual Device (VVD), but it cannot press a remote key or take a screenshot. So every check of a Vega app's screen needed a person at the emulator, and an AI coding agent could build an app it could never see.

The VVD is built on the Android emulator, which has its own gRPC API and console. This driver uses them. Its scripts were worked out while building [Dice Chess for Fire TV](https://github.com/fortemate/dicechess-tv): they drove whole sessions with nobody at the emulator, took every screenshot of the game's gallery, checked its move animations frame by frame and recorded its [demo video](https://www.youtube.com/watch?v=Q7wWAmUp2Sc). Both gaps are in that project's [friction log](https://fortemate.github.io/dicechess-tv/friction-log/) for Amazon, as FL-08 and FL-09.

## What you need

- The Vega SDK with its Virtual Device. The driver was built and tested with SDK 0.24.12112 on macOS (Apple silicon). The Linux locations are included but untested.
- Node 20 or later.
- ffmpeg, only for `record`.

## Install

```sh
npm install -g github:fortemate/vega-vvd-driver
```

Or clone the repository, then `npm ci && npm link`.

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
| `vvd frames <dir> [--seconds 3]`                           | Saves every distinct frame as a PNG, named by the emulator's time                                                                                                                       |
| `vvd wait-change [--timeout 5000]`                         | Exits 0 once the screen changes, 1 on timeout                                                                                                                                           |
| `vvd safe-area [--background #rrggbb] [--margin 0.05]`     | Counts what sits in the outer 5% of each edge. Exits 0 when clear                                                                                                                       |
| `vvd mcp`                                                  | Runs the MCP server on stdio                                                                                                                                                            |

Quote a repeated key in a shell, `'down*3'`, or zsh reads the `*` as a file pattern. Every command takes `--pid <n>` to pick one device when several run.

## For AI agents: the MCP server

The server lets an agent operate the device and see the result. With Claude Code:

```sh
claude mcp add vvd -- vvd mcp
```

Other MCP clients start the command `vvd` with the argument `mcp`.

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

`device.waitForChange()`, `device.frames()` and `checkSafeArea()` cover the rest. See `src/index.ts` for everything exported.

## Recipes

**Check an animation.** Start `vvd frames ./frames --seconds 3`, then trigger the animation. Each distinct frame lands as a PNG named by the emulator's own clock. On the VVD, a 220 ms move slide in Dice Chess came through as 10 to 11 frames.

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
- **Home cannot be scripted.** Neither `KEY_HOMEPAGE` nor `KEY_F1` leaves an app. To get back to the launcher, run `vega device launch-app -d VirtualDevice -a com.amazon.keplerlauncherapp.main`.
- **Screenshots.** `getScreenshot` returns 1920x1080. A running process polls it at about 90 screenshots a second; `vvd screenshot` takes about half a second, most of it starting up. The emulator's `streamScreenshot` has delivered only its first frame while the screen kept changing, so the driver polls instead.
- **Audio.** `streamAudio` sends nothing while the device is silent. `record` rebuilds the track on the video's clock from each packet's capture time and fills the gaps with silence, so a sound effect stays in sync.
- **gRPC.** The endpoint is off after every start of the VVD, and the discovery file that the driver reads appears only once `grpc <port>` has been sent to the console. `vvd enable-grpc` does that.

## Troubleshooting

- **"No running Vega Virtual Device with gRPC found."** Start the device, then run `vvd enable-grpc`.
- **"emulator_controller.proto not found."** Set `VVD_PROTO_DIR` to the directory in your Vega SDK that holds it (`…/vvd/images/tv/vmtools/agent/lib`).
- **Several devices.** Pick one with `--pid`, from `vvd devices`.
- **`record` fails at once.** Install ffmpeg.

## How it works

A running emulator with gRPC on writes `pid_<pid>.ini` into a per-user directory (`~/Library/Caches/TemporaryItems/avd/running` on macOS). It holds the gRPC port and a bearer token. The driver reads it, loads `emulator_controller.proto` from your own Vega SDK, and calls the emulator's `EmulatorController` service. To turn gRPC on, it signs in to the emulator console on port 5554 with the token in `~/.emulator_console_auth_token`.

- Tokens are read at run time and never printed or logged.
- No file from the Vega SDK is copied or bundled: Amazon licenses the SDK to each developer. The proto is Android emulator code under Apache-2.0, and it is loaded from your installation.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `mise run setup`, then `mise run check`; with a device running and gRPC on, `npm run test:device`.

## Licence

[MIT](LICENSE). Made by Jegors Čemisovs at [Fortemate](https://github.com/fortemate).
