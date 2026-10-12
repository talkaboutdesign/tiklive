/**
 * Command-line parsing shared by the `tiklive` bin (bin.ts) and the standalone
 * executable (standalone.ts). Prints help or the version and exits, or returns
 * the server options to run.
 */
import { normalizeUsername } from "@tiklive/contracts";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import type { ServerOptions } from "./server.ts";

export interface CliConfig {
  /** Browser client bundle served at /tiklive.js. */
  readonly clientBundle?: string;
  /** Directory served when `--static` is not given. */
  readonly defaultStaticDir?: string;
  /** Files embedded in the program, served when `--static` is not given. */
  readonly assets?: ReadonlyMap<string, Uint8Array>;
  /** Extra lines appended to `--help`. */
  readonly helpFooter?: string;
}

export const parseCli = (argv: ReadonlyArray<string>, config: CliConfig = {}): ServerOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      token: { type: "string" },
      watch: { type: "string", short: "w", multiple: true },
      static: { type: "string" },
      "data-dir": { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
      "allow-no-token": { type: "boolean" },
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
      --token <secret>     Require this token for the API and WebSocket (env TIKLIVE_TOKEN; required beyond localhost)
  -w, --watch <user>       Stay connected to a streamer; repeatable (env TIKLIVE_WATCH, comma-separated)
      --static <dir>       Serve a directory of overlays/pages
      --data-dir <dir>     Where action rules and uploads are kept (env TIKLIVE_DATA_DIR, default ~/.tiklive)
      --allow-origin <url> Allow browser pages from this origin to use the API; repeatable
      --allow-host <name>  Accept this Host header (default: localhost names only); repeatable
      --allow-no-token     Allow listening beyond localhost without --token (not recommended)
      --log-requests       Log every HTTP request
  -h, --help               Show this help
  -v, --version            Print the version

Clients connect to ws://HOST:PORT/ws. Use the username "demo" for fake events.${
      config.helpFooter ? `\n\n${config.helpFooter}` : ""
    }`);
    process.exit(0);
  }

  const host = values.host ?? process.env.HOST ?? "127.0.0.1";
  const staticDir = values.static ?? config.defaultStaticDir;
  const token = values.token ?? process.env.TIKLIVE_TOKEN;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const allowNoToken = values["allow-no-token"] ?? false;
  if (!loopback && !token && !allowNoToken) {
    console.error(
      `error: --host ${host} exposes tiklive beyond this computer. Set --token <secret> (or TIKLIVE_TOKEN), ` +
        "or pass --allow-no-token if that is really what you want.",
    );
    process.exit(1);
  }
  const watch = [
    ...(values.watch ?? []),
    ...(process.env.TIKLIVE_WATCH?.split(",").filter(Boolean) ?? []),
  ].map(normalizeUsername);

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
    ...(staticDir ? { staticDir } : {}),
    ...(config.clientBundle ? { clientBundle: config.clientBundle } : {}),
    ...(config.assets ? { assets: config.assets } : {}),
    ...(values["log-requests"] ? { logRequests: true } : {}),
    dataDir: values["data-dir"] ?? process.env.TIKLIVE_DATA_DIR ?? join(homedir(), ".tiklive"),
    sessions: { watch },
    serverVersion: pkg.version,
  };

  if (!loopback && !token) {
    console.warn(
      "warning: listening beyond localhost without --token; anyone who can reach this port can use it",
    );
  }
  if (watch.length) console.log(`watching: ${watch.map((w) => "@" + w).join(", ")}`);

  return options;
};
