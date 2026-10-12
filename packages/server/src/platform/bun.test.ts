import { describe, expect, it } from "@effect/vitest";
import { BUN_WEBSOCKET_LIMITS } from "./limits.ts";

describe("Bun outgoing WebSocket limit", () => {
  it.skipIf(!("Bun" in globalThis))(
    "disconnects a socket that accumulates too much outgoing data",
    async () => {
      const { serve } = await import("bun");
      let sent = 0;
      let peakBuffered = 0;
      const server = serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request, server) =>
          server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
        websocket: {
          ...BUN_WEBSOCKET_LIMITS,
          message: () => {},
          open: (socket) => {
            const message = "x".repeat(64 * 1024);
            while (sent < 1000) {
              sent++;
              const result = socket.sendText(message);
              peakBuffered = Math.max(peakBuffered, socket.getBufferedAmount());
              if (result === 0) break;
            }
          },
        },
      });
      const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
      try {
        await new Promise<void>((resolve) => {
          client.onclose = () => resolve();
        });
        expect(sent).toBeLessThan(1000);
        expect(peakBuffered).toBeGreaterThan(0);
        expect(peakBuffered).toBeLessThanOrEqual(BUN_WEBSOCKET_LIMITS.backpressureLimit + 64 * 1024);
      } finally {
        client.close();
        await server.stop(true);
      }
    },
  );
});
