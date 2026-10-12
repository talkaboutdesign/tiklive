import { describe, expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { once } from "node:events";
import { BoundedWebSocket } from "./boundedWebSocket.ts";
import { MAX_OUTGOING_BYTES } from "./limits.ts";

const withSocket = async (test: (server: BoundedWebSocket, client: NodeWS.WebSocket) => Promise<void>) => {
  const server = new NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1", WebSocket: BoundedWebSocket });
  let client: NodeWS.WebSocket | undefined;
  let peer: BoundedWebSocket | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing server address");
    const connection = once(server, "connection");
    client = new NodeWS.WebSocket(`ws://127.0.0.1:${address.port}`);
    const opened = once(client, "open");
    const [socket] = await connection;
    peer = socket as BoundedWebSocket;
    await opened;
    await test(peer, client);
  } finally {
    client?.terminate();
    peer?.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
};

describe("outgoing WebSocket limit", () => {
  it.skipIf("Bun" in globalThis)("delivers a message at the byte limit", () =>
    withSocket(async (server, client) => {
      Object.defineProperty(server, "bufferedAmount", { get: () => MAX_OUTGOING_BYTES - 4 });
      const message = once(client, "message");
      server.send("🎉");
      expect(String((await message)[0])).toBe("🎉");
    }),
  );

  it.skipIf("Bun" in globalThis)("disconnects when the next UTF-8 message exceeds the limit", () =>
    withSocket(async (server, client) => {
      Object.defineProperty(server, "bufferedAmount", { get: () => MAX_OUTGOING_BYTES - 3 });
      const closed = once(client, "close");
      const messages: unknown[] = [];
      client.on("message", (data) => messages.push(data));
      server.send("🎉");
      expect((await closed)[0]).toBe(1006);
      expect(messages).toEqual([]);
    }),
  );

  it.skipIf("Bun" in globalThis)("disconnects rather than queueing one oversized message", () =>
    withSocket(async (server, client) => {
      const closed = once(client, "close");
      server.send("x".repeat(MAX_OUTGOING_BYTES + 1));
      expect((await closed)[0]).toBe(1006);
    }),
  );
});
