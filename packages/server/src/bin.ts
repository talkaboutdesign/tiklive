#!/usr/bin/env bun
import { normalizeUsername } from "@tiklive/contracts";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import type { ServerOptions } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    token: { type: "string" },
    watch: { type: "string", short: "w", multiple: true },
    static: { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    "allow-host": { type: "string", multiple: true },
    "log-requests": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  console.log(`tiklive ${pkg.version} — self-hosted TikTok LIVE event server

Usage: tiklive [options]

  -p, --port <n>           Port (env PORT, default 8080)
      --host <addr>        Interface to bind (env HOST, default 127.0.0.1)
      --token <secret>     Require this token for the API and WebSocket (env TIKLIVE_TOKEN)
  -w, --watch <user>       Stay connected to a streamer; repeatable (env TIKLIVE_WATCH, comma-separated)
      --static <dir>       Serve a directory of overlays/pages
      --allow-origin <url> Allow browser pages from this origin to use the API; repeatable
      --allow-host <name>  Accept this Host header (default: localhost names only); repeatable
      --log-requests       Log every HTTP request
  -h, --help               Show this help
  -v, --version            Print the version

Clients connect to ws://HOST:PORT/ws. Use the username "demo" for fake events.`);
  process.exit(0);
}

const host = values.host ?? process.env.HOST ?? "127.0.0.1";
const token = values.token ?? process.env.TIKLIVE_TOKEN;
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
const watch = [...(values.watch ?? []), ...(process.env.TIKLIVE_WATCH?.split(",").filter(Boolean) ?? [])].map(
  normalizeUsername,
);

let clientBundle: string | undefined;
try {
  clientBundle = fileURLToPath(import.meta.resolve("@tiklive/client/tiklive.js"));
} catch {
  clientBundle = undefined;
}

const options: ServerOptions = {
  port: Number(values.port ?? process.env.PORT ?? 8080),
  host,
  ...(token ? { token } : {}),
  // Binding beyond loopback means clients use other hostnames; the token is the guard then.
  allowedHosts: values["allow-host"]?.length
    ? ["localhost", "127.0.0.1", "[::1]", ...values["allow-host"]]
    : loopback
      ? ["localhost", "127.0.0.1", "[::1]"]
      : "any",
  ...(values["allow-origin"] ? { allowedOrigins: values["allow-origin"] } : {}),
  ...(values.static ? { staticDir: values.static } : {}),
  ...(clientBundle ? { clientBundle } : {}),
  ...(values["log-requests"] ? { logRequests: true } : {}),
  sessions: { watch },
  serverVersion: pkg.version,
};

if (!loopback && !token) {
  console.warn(
    "warning: listening beyond localhost without --token; anyone who can reach this port can use it",
  );
}
if (watch.length) console.log(`watching: ${watch.map((w) => "@" + w).join(", ")}`);

const platform =
  typeof Bun !== "undefined" ? await import("./platform/bun.ts") : await import("./platform/node.ts");
platform.runMain(Layer.launch(platform.layer(options)));
