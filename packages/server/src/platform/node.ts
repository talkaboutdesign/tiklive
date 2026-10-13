import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";
import { createServer } from "node:http";
import { BoundedWebSocket } from "./boundedWebSocket.ts";
import * as Server from "../server.ts";

/** The server bound with Node's HTTP server. */
export const layer = (
  options: Server.ServerOptions & Pick<NodeHttpServer.Options, "gracefulShutdownTimeout"> = {},
) =>
  Server.layer(options).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => createServer(), {
        port: options.port ?? 8080,
        host: options.host ?? "127.0.0.1",
        ...(options.gracefulShutdownTimeout !== undefined
          ? { gracefulShutdownTimeout: options.gracefulShutdownTimeout }
          : {}),
        websocket: { maxPayload: 64 * 1024, WebSocket: BoundedWebSocket },
      }),
    ),
  );

export const runMain = NodeRuntime.runMain;
