# Contributing

Thank you for helping. Issues and pull requests are welcome, especially reports of what works, or does not, on other versions of the Vega SDK and on Linux.

## Set up

You need Node (the version in `mise.toml`), and for anything that touches a device, the Vega SDK with its Virtual Device.

```sh
mise run setup        # npm ci, and the Git hooks
mise run check        # types, format, tests and the build, as CI runs them
```

Without mise: `npm ci`, then `npm run check`, `npm run format:check`, `npm test` and `npm run build`.

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

## Licence

By contributing, you agree that your contribution is licensed under the MIT licence of this repository.
