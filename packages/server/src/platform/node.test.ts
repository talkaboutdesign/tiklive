import { describe, expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { once } from "node:events";
import { createServer } from "node:net";
import { layer } from "./node.ts";

describe("Node server shutdown", () => {
  it("closes connected overlays when the configured grace period ends", async () => {
    // Reserve an unused port; the public server layer does not expose its bound address.
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (typeof address !== "object" || address === null) throw new Error("missing server address");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );

    const runtime = ManagedRuntime.make(layer({ port: address.port, gracefulShutdownTimeout: "0 seconds" }));
    let client: NodeWS.WebSocket | undefined;
    try {
      await runtime.runPromise(Effect.void);
      client = new NodeWS.WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      await once(client, "open");
      const closed = once(client, "close");
      // Leave the overlay connected: disposal must initiate its close itself.
      await runtime.dispose();
      await closed;
      expect(client.readyState).toBe(NodeWS.WebSocket.CLOSED);
    } finally {
      client?.terminate();
      await runtime.dispose();
    }
  });
});
