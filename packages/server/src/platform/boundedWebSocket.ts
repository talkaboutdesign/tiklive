/** Node's server sockets must not accumulate unlimited sends for a slow overlay. */
import { NodeWS } from "@effect/platform-node/NodeSocket";

import { MAX_OUTGOING_BYTES } from "./limits.ts";

type SendData = Parameters<NodeWS.WebSocket["send"]>[0];
type SendOptions = Parameters<NodeWS.WebSocket["send"]>[1];
type SendCallback = Parameters<NodeWS.WebSocket["send"]>[2];

/** Internal server implementation; the routes send only JSON strings (or binary socket frames). */
export class BoundedWebSocket extends NodeWS.WebSocket {
  override send(data: SendData, callback?: SendCallback): void;
  override send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  override send(data: SendData, options?: SendOptions | SendCallback, callback?: SendCallback): void {
    const bytes =
      typeof data === "string"
        ? Buffer.byteLength(data)
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : data instanceof ArrayBuffer || data instanceof SharedArrayBuffer
            ? data.byteLength
            : 0;
    if (this.bufferedAmount + bytes > MAX_OUTGOING_BYTES) {
      // A graceful close would itself wait behind the buffered data; terminate releases it promptly.
      this.terminate();
      return;
    }
    if (typeof options === "function" || options === undefined) super.send(data, options);
    else super.send(data, options, callback);
  }
}
