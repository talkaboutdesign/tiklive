import * as Schema from "effect/Schema";

/** The TikTok account doesn't exist (or is banned/private in a way that hides it). */
export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  username: Schema.String,
}) {
  override get message() {
    return `TikTok user @${this.username} not found`;
  }
}

/** The user exists but isn't live right now. */
export class UserOffline extends Schema.TaggedError<UserOffline>()("UserOffline", {
  username: Schema.String,
}) {
  override get message() {
    return `@${this.username} is not live`;
  }
}

/**
 * An HTTP call to tiktok.com failed or returned something unexpected.
 * `rateLimited` is set when TikTok answered with an empty body or HTTP 429,
 * which is how it usually throttles.
 */
export class TikTokRequestError extends Schema.TaggedError<TikTokRequestError>()("TikTokRequestError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Finite),
  rateLimited: Schema.optionalKey(Schema.Boolean),
}) {}

/** Every WebSocket host refused or failed to open the connection. */
export class SocketOpenFailed extends Schema.TaggedError<SocketOpenFailed>()("SocketOpenFailed", {
  message: Schema.String,
  hosts: Schema.Array(Schema.String),
}) {}

/** The socket dropped and reconnecting failed `maxAttempts` times in a row. */
export class ReconnectFailed extends Schema.TaggedError<ReconnectFailed>()("ReconnectFailed", {
  attempts: Schema.Finite,
  lastError: Schema.String,
}) {
  override get message() {
    return `Lost connection to TikTok and ${this.attempts} reconnect attempts failed: ${this.lastError}`;
  }
}

export type ConnectError =
  | UserNotFound
  | UserOffline
  | TikTokRequestError
  | SocketOpenFailed
  | ReconnectFailed;
