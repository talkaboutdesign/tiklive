# AGENTS.md

Guide for coding agents working in this repo. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).
Protocol details are in [docs/PROTOCOL.md](docs/PROTOCOL.md). Design notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What this is

tiklive is an open-source TikTok LIVE connector and event server. It turns TikTok's LIVE WebSocket
into typed JSON events for stream overlays. It's MIT licensed.

The hard rule: **no third-party signing services, no login, no headless browser.** The connector uses
only plain HTTPS calls to tiktok.com and an anonymous `ttwid` cookie. Don't add a dependency or code path
that needs one, even if it would make something easier. If you think one is needed, stop and ask.

## Repo map

```
packages/contracts   Event and wire-protocol schemas (Effect Schema). PROTOCOL_VERSION lives here.
                     Private: bundled into `tiklive` as `tiklive/contracts`.
packages/core        TikTok connector: LiveConnection (Stream), TikTokWeb (service), errors,
                     proto/ decoders, demoEvents, testing.ts fakes. Private: bundled as
                     `tiklive/core` and `tiklive/testing`.
packages/server      SessionManager, Session, HTTP/WS routes (http.ts), Server.layer,
                     platform/ (Bun and Node HTTP layers), bin.ts (the `tiklive` CLI).
                     Publishes to npm as `tiklive`, and bundles the other three packages.
packages/client      TikLive browser/Node client, built to dist/tiklive.js (served as /tiklive.js).
                     No Effect, no runtime deps.
apps/desktop         Electron app: runs the server in-process on 127.0.0.1:8080, shows the dashboard,
                     auto-updates via electron-updater (src/updates/). Main + preload bundle to dist-electron/
examples/overlays    Dashboard and OBS overlays (plain HTML, no build step)
docs/                Index in docs/README.md. user/ (using tiklive), operations/ (releases),
                     PROTOCOL.md, ARCHITECTURE.md
patches/             Patch to @effect/vitest (see Gotchas)
.repos/              Gitignored reference repos. Read-only, never committed.
```

Dependency direction: `contracts` ← `core` ← `server` ← `desktop`. `contracts` ← `client` (types only). Don't make
`core` import from `server`, and don't make `client` import Effect.

## Commands

Bun 1.4.3 (pinned in `package.json` `packageManager`). Use `bun`, not `npm`, `pnpm`, or `yarn`.

| Command                        | What it does                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `bun install`                  | Install (uses `bun.lock`, and refuses versions published less than 3 days ago)              |
| `bun run dev`                  | Build the client, then run the server with `--watch` and serve `examples/overlays` on :8080 |
| `bun run start`                | Same, without watching                                                                      |
| `bun run desktop:dev`          | Build the client, bundle the desktop app and launch Electron                                |
| `bun run build`                | Build packages that have a `build` script (currently the client)                            |
| `bun run test`                 | Tests on the Bun runtime (`bun --bun vp test run`)                                          |
| `bun run test:node`            | Tests on Node (`vp test run`)                                                               |
| `bun run typecheck`            | `tsc --noEmit` in every workspace package                                                   |
| `bun run lint` / `bun run fmt` | `vp lint` / `vp fmt`                                                                        |
| `bun run check`                | `vp check` plus typecheck                                                                   |

Run a single test file with `bun --bun vp test run packages/core/src/LiveConnection.test.ts`.

Test files are `packages/*/src/**/*.test.ts` (see `vite.config.ts`).

## Language and TypeScript conventions

`tsconfig.base.json` is strict, with extra flags. Write code that passes them:

- **Imports use `.ts` extensions**, e.g. `import { x } from "./errors.ts"`. `allowImportingTsExtensions` is on.
- **`erasableSyntaxOnly`**: no `enum`, no `namespace` with runtime code, no constructor parameter properties.
  Use string-literal unions or `Schema.Literals`.
- **`verbatimModuleSyntax`**: type-only imports use `import type`.
- **`exactOptionalPropertyTypes`**: you can't assign `undefined` to an optional property. Spread conditionally,
  e.g. `...(x ? { x } : {})`, which the code does throughout.
- **`noUncheckedIndexedAccess`**: indexed reads are `T | undefined`. Handle them or use `!` only when
  you've just checked.
- **`noImplicitOverride`**: mark overridden members with `override`.
- TypeScript 7 (`typescript` in the catalog). Fix type errors in the code, not by loosening the config.

## Effect 4 conventions

The Effect packages are at **4.0.2** (`effect`, `@effect/platform-bun`, `@effect/platform-node`,
`@effect/vitest`), pinned in the root `workspaces.catalog`. Add or upgrade dependencies through the catalog,
not with a version in one package.

**Effect 4 is not Effect 3.** Model code on what's already in this repo, and check the source when unsure.
Effect source: `.repos/effect/src`. Effect's own agent guide: `.repos/effect/CLAUDE.md` and
`.repos/platform-bun/CLAUDE.md`. Don't rely on memory or on Effect 3 blog posts. In particular:

- Services use `Context.Service<Self, Shape>()("@scope/Name")`, not `Context.Tag`.
- Typed errors use `Schema.TaggedError<T>()("Tag", fields)`, as in `packages/core/src/errors.ts`.
- Use `Effect.result` (not `Effect.either`) and `Effect.catch` (not `catchAll`). `Effect.catchTag` still exists.
- Optional schema keys are `Schema.optionalKey(...)`. Literal unions are `Schema.Literals([...])`.
  Tagged unions use `Schema.tag("x")` and `Schema.toTaggedUnion("type")`.
- Durations can be strings (`"30 seconds"`) or `Duration.fromInputUnsafe(...)`.
- Socket primitives are under `effect/socket/Socket`. HTTP is under `effect/http/*`.

Patterns used here:

- Prefer `Effect.gen(function* () { ... })` for multi-step logic. Wrap reusable functions with
  `Effect.fn("name")` when tracing helps, or `Effect.fnUntraced` on hot paths.
- Build layers with `Layer.effect`, `Layer.succeed`, and `Layer.mergeAll`. Run the server with `Layer.launch`.
- Long-lived work is forked into a scope (`Effect.forkScoped`), so it stops when the scope closes.
- Shared mutable state is a `Ref`, or a plain variable mutated only inside `Effect.sync`/`Effect.suspend`
  (see `Session.ts`, which relies on fibers not interleaving within one block).

## Protocol and contracts

- **Event shapes and client messages are defined once**, in `packages/contracts/src`. Change them there first.
- **A wire-protocol change must update all of these in one commit:**
  1. `packages/contracts/src/protocol.ts` (or `events.ts`)
  2. `docs/PROTOCOL.md`
  3. `packages/client/src/index.ts`, if the browser client needs to know
  4. `PROTOCOL_VERSION` if the change is breaking (see the versioning rules in PROTOCOL.md)
  5. Tests in `packages/contracts/src/contracts.test.ts` and `packages/server` if behavior changed
- **Adding an event type** starts in `contracts/src/events.ts` (schema, add to `LiveEvent`), then the decoder in
  `core/src/proto/messages.ts`. Full steps are in CONTRIBUTING.md.
- The client doesn't validate events at runtime. It trusts the server. Keep it that way.

## Testing

- Use `@effect/vitest` (`it.effect`, `it.live` when you need the real clock). Use `TestClock` for timing
  (retry backoff, polling, idle timeouts). Don't add real sleeps to tests.
- Test doubles for TikTok are in `packages/core/src/testing.ts`: `FakeWebSocket` and `fakeWebSocketLayer` (a scriptable
  socket that records sent frames), `fakeTikTokWebLayer` (room lookups without the network), and frame builders
  (`chatFrame`, `streamEndFrame`). Use them instead of hitting TikTok. Tests should never reach
  tiktok.com.
- `packages/core/src/demo.test.ts` and `LiveConnection.test.ts` show the patterns.
- **Run tests on both runtimes** when you touch core, server, or contracts: `bun run test` and `bun run test:node`.
  CI runs both.
- Assert on observable behavior: messages out, stats, state transitions, errors. Don't assert implementation
  details or mirror the code in the test.
- Frames are protobuf: when a test needs a new message type, build the frame with `ProtoWriter`
  (`core/src/proto/wire.ts`) rather than hand-coding bytes.

## Verifying a change

1. The smallest proof: the tests you wrote or touched, on the runtime you changed.
2. `bun run typecheck` for the packages you changed.
3. `bun run lint` (and `bun run fmt` for formatting, print width 110).
4. For server or overlay changes, run `bun run dev` and check the affected page or endpoint with curl or a
   browser. `username=demo` gives fake events, and `GET /api/sessions/demo` shows that session's status.

## Gotchas

- **`patches/@effect%2Fvitest@4.0.2.patch`** rewires `@effect/vitest` to re-export `vite-plus/test` instead of
  `vitest`. Keep it. If you bump `@effect/vitest`, re-check the patch against the new version.
- **`minimumReleaseAge` in `bunfig.toml`** (3 days) blocks very new package versions as a supply-chain guard.
  Don't disable it. If an install fails on a new version, wait, or pin the older one.
- **`packages/client/dist/` is built output** (gitignored). The server looks for `@tiklive/client/tiklive.js`
  through `import.meta.resolve`. If it's missing, `/tiklive.js` returns a 404 explaining how to build it.
  Run `bun run build` after changing the client.
- **Host and Origin checks** apply to `/api` and `/ws`. Static files are not guarded, by design. Don't put
  secrets in the static directory.
- **Stats reset on reconnect.** `Session` resets stats on every `Connected`, which includes reconnects after a
  drop. `SessionStats` is documented as resetting only when the stream starts. Don't "fix" the docs without
  deciding which behavior is intended. See the "Known gaps" section of ARCHITECTURE.md.
- **No resume cursor.** tiklive doesn't send the signed `im/fetch` request, so reconnects can drop events.
  Don't add retries that pretend otherwise. Duplicates are de-duplicated by `msgId` (a bounded set of the last 5000).
- **Package exports are public API.** `tiklive` exports `.`, `./core`, `./contracts`, `./client`, `./testing`,
  `./bun`, `./node` (the platform layers) and `./tiklive.js`. The `@tiklive/source` condition maps them to `src/`
  for local dev.
- The Bun-only code path: `bin.ts` picks `platform/bun.ts` when `Bun` is defined, otherwise `platform/node.ts`.
  Don't import Bun-only modules from shared code.
- **Reference repos in `.repos/`** are for reading only. `TikTok-Live-Connector` is AGPL. Both it and
  `tiktok-live-proto` are third-party code. Read field numbers and message shapes from them, but never copy
  code, comments or structure. Write the decoders yourself.

## Principles

- **Small and boring.** Fewer moving parts beats cleverness. Don't add a dependency, a service or a new
  abstraction without a concrete need in this repo.
- **Read-only.** tiklive observes streams. Don't add anything that sends messages or actions to TikTok.
- **Stable public surface.** The exported names of `tiklive` and its subpaths (`tiklive/core`, `tiklive/client`,
  `tiklive/contracts`, `tiklive/testing`, `tiklive/bun`, `tiklive/node`) are public. Changing them is a breaking
  change for library users.
- **Keep the client dependency-free.** Overlays are plain pages. The client must stay plain TypeScript with no
  imports beyond types.
- **Docs follow code.** When behavior changes, update the README, docs/user/, PROTOCOL.md or ARCHITECTURE.md in the same change.
  Check that examples still match the code.
- **Scope.** Do what was asked. Don't reformat unrelated files, rename exports, or refactor across packages in
  a feature change.
