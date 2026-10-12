import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Layer from "effect/Layer";
import { BUN_WEBSOCKET_LIMITS } from "./limits.ts";
import * as Server from "../server.ts";

/** The server bound with Bun's HTTP server. */
export const layer = (options: Server.ServerOptions = {}) =>
  Server.layer(options).pipe(
    Layer.provide(
      BunHttpServer.layer({
        port: options.port ?? 8080,
        hostname: options.host ?? "127.0.0.1",
        websocket: BUN_WEBSOCKET_LIMITS,
      }),
    ),
  );

export const runMain = BunRuntime.runMain;
