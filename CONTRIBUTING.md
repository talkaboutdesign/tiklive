# Contributing

Thanks for helping. tiklive is small, so the most useful contributions are focused fixes, decoders for
new TikTok message types, and clear docs. For larger changes, open an issue first so we can agree on the approach.

Also read [AGENTS.md](AGENTS.md). It covers the repo layout, TypeScript and Effect conventions, and the rules
the code relies on (no signing services, dependency-free client, protocol changes).

## Setup

You need [Bun](https://bun.sh) 1.4.3 or newer. The version is pinned in `package.json`.

```sh
git clone https://github.com/talkaboutdesign/tiklive
cd tiklive
bun install
bun run dev               # http://localhost:8080 with the example overlays
```

Node 22+ can run the library and tests. CI runs the Node tests on Node 24.

## Workflow

1. Branch from `main`.
2. Make the change, with tests for the behavior you changed.
3. Run the checks:

   ```sh
   bun run check          # lint, format check and typecheck
   bun run test           # Bun runtime
   bun run test:node      # Node runtime
   ```

   Run `bun run fmt` to fix formatting. Print width is 110.

4. Update docs in the same PR when behavior changes: [README.md](README.md), [docs/PROTOCOL.md](docs/PROTOCOL.md),
   or [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
5. Open a pull request against `main`. CI runs typecheck, lint, both test suites, and the build.

### Tests

- Tests live next to the code as `*.test.ts` under `packages/*/src`.
- Don't hit TikTok in tests. Use the fakes in `packages/core/src/testing.ts`.
- Tests that depend on time use `TestClock`, not real sleeps.
- Changes to `core`, `server`, or `contracts` should pass on both runtimes. `bun run test` and `bun run test:node`.

### Commit messages

Short, plain, imperative subject lines, under about 72 characters, with a body when the why isn't obvious. Match the
existing history, e.g. `Add gift streak dedupe` or `Fix reconnect backoff reset`.

Keep unrelated changes in separate commits, and separate PRs when they're independent.

## Changing the wire protocol

The protocol is documented in [docs/PROTOCOL.md](docs/PROTOCOL.md). It has its own versioning rules.

- Schemas live in `packages/contracts/src`. Change them there.
- Update `docs/PROTOCOL.md` and the browser client (`packages/client/src/index.ts`) in the same PR.
- A breaking change bumps `PROTOCOL_VERSION` in `packages/contracts/src/protocol.ts`. Adding an optional field or a new event type
  doesn't. Clients must ignore unknown fields and types.

## Adding a new event type

For example, a TikTok message that tiklive doesn't normalize yet:

1. **Schema.** Add a `Schema.Struct` in `packages/contracts/src/events.ts` with `type: Schema.tag("name")`, the common
   `timestamp` and `msgId` fields, and the event's own fields. Add it to the `LiveEvent` union, then export its type.
   Keep fields flat and JSON-serializable, and use `Schema.optionalKey` for anything TikTok may omit.
2. **Decoder.** In `packages/core/src/proto/messages.ts`, add an entry to the `decoders` map, keyed by the webcast method name
   (e.g. `WebcastSomethingMessage`). Read only the fields you need, with the field numbers from TikTok's protobuf
   schemas. Use the existing `common`, `base`, and `decodeUser` helpers. The `.repos/tiktok-live-proto` reference is
   useful for field numbers. Don't copy code from it (see AGENTS.md).
3. **Tests.** Add a case to `packages/core/src/proto/proto.test.ts` with a frame built by the test helpers
   (`ProtoWriter` in `proto/wire.ts`). Cover the happy path and a message with missing fields.
4. **Session stats.** If the event should count toward `SessionStats`, update `handleEvent` in
   `packages/server/src/Session.ts` and document the stat in PROTOCOL.md.
5. **Docs.** Add the type to the event table in `docs/PROTOCOL.md` and the README.
6. **Client.** The client types come from `@tiklive/contracts`, so `TikLive.on("name", ...)` gets the new type automatically.
   The dashboard's test buttons and the overlays only change if you want them to use the event.

## Dependencies

- Add or upgrade packages through the `workspaces.catalog` in the root `package.json`, so every package uses the same version.
- `bunfig.toml` refuses package versions published less than 3 days ago. If a new version won't install, wait or pin the older one.
- Keep the browser client dependency-free. Don't add a runtime dependency to `packages/client`.
- Don't add a third-party signing service, a headless browser, or a TikTok login. These are out of scope.

## Releasing

The four `@tiklive/*` packages are versioned together with [Changesets](https://github.com/changesets/changesets).

1. In any PR that changes a published package, run `bunx changeset`, pick the bump (patch, minor or major),
   write a one-line summary, and commit the generated `.changeset/*.md` file.
2. On every push to `main`, the Release workflow opens or updates a "Release: version packages" PR that bumps
   versions and writes `CHANGELOG.md` entries.
3. Merging that PR publishes the new versions to npm (trusted publishing, no tokens) and creates a GitHub
   Release `vX.Y.Z` with standalone `tiklive` binaries for macOS, Linux and Windows.

Useful commands:

- `bun run release -- --dry-run` packs every package and shows what would be published.
- `bun run build:binaries` builds the standalone binary for your platform into `dist/bin/` (`--all` for every target).
- Versions with a prerelease suffix (e.g. `0.3.0-next.1`) publish under the `next` dist-tag.

## Reporting problems

Open a GitHub issue. Include the tiklive version (`tiklive --version`), the runtime (Bun or Node and its version),
the username you followed (or whether it was offline), and the relevant log lines from the server. Don't include
cookies, tokens, or captured TikTok traffic.

## Security

For a security problem, don't open a public issue. Contact the maintainer privately, through the GitHub profile of
the repository owner.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
