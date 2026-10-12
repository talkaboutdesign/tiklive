import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";
import { createServer } from "node:http";
import * as Server from "../server.ts";

/** The server bound with Node's HTTP server. */
export const layer = (options: Server.ServerOptions = {}) =>
  Server.layer(options).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => createServer(), {
        port: options.port ?? 8080,
        host: options.host ?? "127.0.0.1",
        websocket: { maxPayload: 64 * 1024 },
      }),
    ),
  );

export const runMain = NodeRuntime.runMain;
