/**
 * Composes the tiklive server: routes + sessions + TikTok connectivity.
 * Provide an `HttpServer` (see ./platform/bun.ts and ./platform/node.ts) to run it.
 */
import { LiveConnection, type TikTokWeb } from "@tiklive/core";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import { type HttpOptions, routes } from "./http.ts";
import * as SessionManager from "./SessionManager.ts";

export interface ServerOptions extends HttpOptions {
  readonly port?: number;
  /** Interface to bind. Default 127.0.0.1. */
  readonly host?: string;
  readonly sessions?: SessionManager.SessionManagerOptions;
  /** Overrides TikTok connectivity (proxies, tests). Default: global fetch + WebSocket. */
  readonly tiktok?: Layer.Layer<TikTokWeb.TikTokWeb | import("effect/socket/Socket").WebSocketConstructor>;
  readonly userAgent?: string;
  /** Log each HTTP request. Default false. */
  readonly logRequests?: boolean;
}

/** The server as a Layer that needs an `HttpServer`. */
export const layer = (options: ServerOptions = {}) =>
  HttpRouter.serve(routes(options), { disableLogger: !options.logRequests }).pipe(
    Layer.provide(SessionManager.layer(options.sessions)),
    Layer.provide(
      options.tiktok ?? LiveConnection.layer(options.userAgent ? { userAgent: options.userAgent } : {}),
    ),
  );
