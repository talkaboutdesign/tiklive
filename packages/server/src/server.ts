/**
 * Composes the tiklive server: routes + sessions + TikTok connectivity.
 * Provide an `HttpServer` (see ./platform/bun.ts and ./platform/node.ts) to run it.
 */
import { LiveConnection, type TikTokWeb } from "@tiklive/core";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import { type HttpOptions, routes } from "./http.ts";
import * as MediaStore from "./rules/MediaStore.ts";
import * as RuleEngine from "./rules/RuleEngine.ts";
import * as RulesStore from "./rules/RulesStore.ts";
import * as SoundSearch from "./rules/SoundSearch.ts";
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
  /**
   * Directory for action rules (`rules.json`) and uploaded media (`media/`). Without it, rules
   * live in memory until the server stops and uploads are turned off.
   */
  readonly dataDir?: string;
}

/**
 * The server as a Layer that needs an `HttpServer`. `sounds` is the MyInstants search; tests pass a
 * fake. It isn't a ServerOptions field, so it's not part of the public options.
 */
export const layer = (
  options: ServerOptions = {},
  sounds: Layer.Layer<SoundSearch.SoundSearch> = SoundSearch.layer(),
) => {
  const tiktok =
    options.tiktok ?? LiveConnection.layer(options.userAgent ? { userAgent: options.userAgent } : {});
  const rules = options.dataDir ? RulesStore.layerFile(options.dataDir) : RulesStore.layerMemory();
  const media = options.dataDir ? MediaStore.layerFile(options.dataDir) : MediaStore.layerDisabled;
  // One engine instance, shared by the sessions and the router (layers are memoized by identity).
  const engine = RuleEngine.layer.pipe(Layer.provide(rules));
  const sessions = SessionManager.layer(options.sessions).pipe(Layer.provide(Layer.mergeAll(tiktok, engine)));

  return HttpRouter.serve(routes(options), { disableLogger: !options.logRequests }).pipe(
    Layer.provide(Layer.mergeAll(sessions, engine, rules, media, tiktok, sounds)),
  );
};
