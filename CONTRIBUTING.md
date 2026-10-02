# Contributing

Thank you for helping. Issues and pull requests are welcome, especially reports of what works, or does not, on other versions of the Vega SDK and on Linux.

## Set up

You need Node (the version in `mise.toml`), and for anything that touches a device, the Vega SDK with its Virtual Device.

```sh
mise run setup        # npm ci, and the Git hooks
mise run check        # types, format, tests and the build, as CI runs them
```

Without mise: `npm ci`, then `npm run check`, `npm run format:check`, `npm test` and `npm run build`.

The unit tests need neither a device nor ffmpeg. A fake EmulatorController on localhost (`test/fakeEmulator.ts`, with a minimal proto written for the tests), small fake consoles and a stand-in ffmpeg script cover the gRPC, console and recording paths, failures included.

`npm run coverage` runs the same tests with coverage, into `coverage/lcov.info`. CI sends that to SonarQube Cloud, whose analysis is informational: it does not fail the build.

The integration tests need a running Virtual Device with gRPC on. They press left and right on whatever is on screen:

```sh
vega virtual-device start --no-gui
node src/bin.ts enable-grpc
npm run test:device
```

## Pull requests

- Branch from `main` as `feat/…`, `bug/…`, `docs/…`, `test/…`, `ci/…`, `refactor/…` or `chore/…`, and write the commit subject as a Conventional Commit (`feat: …`).
- Keep the checks green. A change to device behaviour should say how it was checked: on the Virtual Device, on a Fire TV Stick, or by a test.
- The repository is English-only; `test/english.test.ts` checks it.
- Never paste a gRPC or console token into an issue, a log or a commit.
- Never add files from the Vega SDK. Amazon licenses it to each developer.

## Releases

A release is a version on npm, staged by CI and approved by a maintainer. Three mise tasks walk through it; `mise tasks` lists them.

1. `mise run release:prepare <version>` opens the pull request that sets the version. `<version>` is `patch`, `minor`, `major`, or an explicit `x.y.z`. It branches `chore/release-<x.y.z>` from `origin/main`, runs `npm version <x.y.z> --no-git-tag-version` and `mise run check`, then commits, pushes and opens the pull request. It refuses a version that is not newer than the one on `main`, and a checkout with uncommitted changes. A maintainer reviews and merges the pull request.
2. `mise run release:publish` reads the version on `main` and asks before it publishes the GitHub release `v<x.y.z>` from there, with generated notes. `.github/workflows/publish.yaml` then checks that the release matches the version, runs the checks and stages the version on npm, signing in through npm Trusted Publishing, so no token is involved. The task follows that run until it ends.
3. `mise run release:approve` lists the staged versions, and `mise run release:approve <id>` approves one; npm asks for the one-time password. Only then is the version public. It needs `npm login` first. Approving on npmjs.com under Staged Packages works too.

Publishing the release (step 2) and approving the staged version (step 3) are a maintainer's: no agent and no CI job does either.

## Licence

By contributing, you agree that your contribution is licensed under the MIT licence of this repository.
