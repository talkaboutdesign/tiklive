/**
 * Integration tests for the HTTP + WebSocket surface. Each test starts a real
 * server on an ephemeral 127.0.0.1 port (Node's http server via the Node
 * platform) with fake TikTok connectivity, then talks to it with fetch, raw
 * node:http requests and the global WebSocket.
 */
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpNodeServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TikTokRequestError, TikTokWeb } from "@tiklive/core";
import { fakeTikTokWebLayer, fakeWebSocketLayer } from "@tiklive/core/testing";
import * as Server from "./server.ts";
import type { ServerOptions } from "./server.ts";

const USER = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fake TikTok + fake WebSocket so nothing touches the network. */
const fakeTikTok = () => Layer.mergeAll(fakeTikTokWebLayer({ live: true }), fakeWebSocketLayer().layer);

/** The server with an ephemeral port, plus the Node HTTP server it runs on. */
const serverLayer = (httpServer: HttpNodeServer, options: ServerOptions = {}) =>
  Server.layer({ tiktok: fakeTikTok(), serverVersion: "test", ...options }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => httpServer, {
        port: 0,
        host: "127.0.0.1",
        websocket: { maxPayload: 64 * 1024 },
      }),
    ),
  );

interface Base {
  readonly http: string;
  readonly ws: string;
  readonly port: number;
}

/** Runs `body` against a freshly started server; the server stops when the body finishes. */
const serve = (options: ServerOptions, body: (base: Base) => Promise<void>) => {
  const httpServer = createServer();
  return Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(serverLayer(httpServer, options));
      // Finalizers run last-in-first-out, so this runs before the server is asked to close. Keep-alive
      // connections left open by fetch would otherwise make shutdown wait (Bun's node:http doesn't
      // close idle sockets on server.close()).
      yield* Effect.addFinalizer(() => Effect.sync(() => httpServer.closeAllConnections()));
      const { address } = Context.get(ctx, HttpServer.HttpServer);
      const port = "port" in address ? address.port : 0;
      yield* Effect.promise(() =>
        body({ http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, port }),
      );
    }),
  );
};

/** Raw HTTP request, so the Host and Origin headers can be set freely. */
const raw = (
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });

type Msg = Record<string, any>;

interface Client {
  readonly messages: Array<Msg>;
  readonly send: (message: unknown) => void;
  /** Resolves with the first message (already received or future) matching `predicate`. */
  readonly waitFor: (predicate: (message: Msg) => boolean, label: string) => Promise<Msg>;
  readonly close: () => void;
}

/** Opens a WebSocket. Resolves to "rejected" if the handshake fails. */
const openSocket = (url: string) =>
  new Promise<Client | "rejected">((resolve) => {
    const ws = new WebSocket(url);
    const messages: Array<Msg> = [];
    const waiters: Array<{ predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Msg;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    };
    const client: Client = {
      messages,
      send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
      waitFor: (predicate, label) =>
        new Promise<Msg>((resolveWait, rejectWait) => {
          const existing = messages.find(predicate);
          if (existing) return resolveWait(existing);
          const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${label}`)), 3000);
          waiters.push({
            predicate,
            resolve: (m) => {
              clearTimeout(timer);
              resolveWait(m);
            },
          });
        }),
      close: () => ws.close(),
    };
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve(client);
    };
    ws.onerror = () => {
      if (!opened) resolve("rejected");
    };
    ws.onclose = () => {
      if (!opened) resolve("rejected");
    };
  });

/** Opens a socket that the test is expected to be able to use, and closes it when the test ends. */
const connect = async (url: string, open: Array<Client>) => {
  const client = await openSocket(url);
  if (client === "rejected") throw new Error(`WebSocket failed to open: ${url}`);
  open.push(client);
  return client;
};

const post = (base: Base, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  body === undefined
    ? fetch(base.http + path, { method: "POST", headers })
    : fetch(base.http + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

const simulateFollow = (base: Base, msgId: string) =>
  post(base, "/api/sessions/demo/simulate", { type: "follow", user: USER, msgId });

const eventMessages = (client: Client) => client.messages.filter((m) => m.type === "event");

/** Closes sockets opened by a test, even when the test fails. */
const closeAll = (clients: Array<Client>) => {
  for (const client of clients) client.close();
};

const tmpDirs: Array<string> = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it.live("returns protocol info without auth, even with a token configured", () =>
    serve({ token: "s3cret" }, async (base) => {
      const res = await fetch(`${base.http}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, protocolVersion: 1 });
    }),
  );
});

describe("Host header check", () => {
  it.live("rejects hosts that are not loopback names", () =>
    serve({}, async (base) => {
      const res = await raw(base.port, "/api/sessions", { headers: { host: "evil.com" } });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Host not allowed" });
    }),
  );

  it.live("accepts loopback names", () =>
    serve({}, async (base) => {
      const res = await raw(base.port, "/api/sessions", { headers: { host: "localhost:1234" } });
      expect(res.status).toBe(200);
    }),
  );

  it.live('allows any host with allowedHosts: "any"', () =>
    serve({ allowedHosts: "any" }, async (base) => {
      const res = await raw(base.port, "/api/sessions", { headers: { host: "evil.com" } });
      expect(res.status).toBe(200);
    }),
  );

  it.live("accepts explicitly listed hosts", () =>
    serve({ allowedHosts: ["evil.com"] }, async (base) => {
      const res = await raw(base.port, "/api/sessions", { headers: { host: "evil.com" } });
      expect(res.status).toBe(200);
    }),
  );
});

describe("Origin check", () => {
  it.live("rejects cross-origin browser requests", () =>
    serve({}, async (base) => {
      const res = await raw(base.port, "/api/sessions/demo", {
        method: "POST",
        headers: { origin: "https://evil.com" },
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Origin not allowed" });
    }),
  );

  it.live("allows same-origin requests", () =>
    serve({}, async (base) => {
      const res = await raw(base.port, "/api/sessions/demo", {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${base.port}` },
      });
      expect(res.status).toBe(200);
    }),
  );

  it.live("allows origins listed in allowedOrigins", () =>
    serve({ allowedOrigins: ["https://overlay.example"] }, async (base) => {
      const res = await raw(base.port, "/api/sessions/demo", {
        method: "POST",
        headers: { origin: "https://overlay.example" },
      });
      expect(res.status).toBe(200);
    }),
  );

  it.live("allows requests without an Origin (non-browser clients)", () =>
    serve({}, async (base) => {
      const res = await fetch(`${base.http}/api/sessions`);
      expect(res.status).toBe(200);
    }),
  );
});

describe("Token auth", () => {
  it.live("requires the token for the API, via query or bearer header", () =>
    serve({ token: "s3cret" }, async (base) => {
      expect((await fetch(`${base.http}/api/sessions`)).status).toBe(401);
      expect((await fetch(`${base.http}/api/sessions?token=wrong`)).status).toBe(401);
      expect((await fetch(`${base.http}/api/sessions?token=s3cret`)).status).toBe(200);
      const bearer = await fetch(`${base.http}/api/sessions`, {
        headers: { authorization: "Bearer s3cret" },
      });
      expect(bearer.status).toBe(200);
    }),
  );

  it.live("requires the token to open the WebSocket", () =>
    serve({ token: "s3cret" }, async (base) => {
      const open: Array<Client> = [];
      try {
        expect(await openSocket(`${base.ws}/ws`)).toBe("rejected");
        const client = await connect(`${base.ws}/ws?token=s3cret`, open);
        await client.waitFor((m) => m.type === "hello", "hello");
      } finally {
        closeAll(open);
      }
    }),
  );
});

describe("authorize hook", () => {
  it.live("replaces the token check", () =>
    serve(
      {
        token: "s3cret",
        authorize: (request) => Effect.succeed(request.headers["x-allow"] === "yes"),
      },
      async (base) => {
        // The token alone no longer grants access.
        expect((await fetch(`${base.http}/api/sessions?token=s3cret`)).status).toBe(401);
        const allowed = await fetch(`${base.http}/api/sessions`, { headers: { "x-allow": "yes" } });
        expect(allowed.status).toBe(200);
        // Health stays open.
        expect((await fetch(`${base.http}/api/health`)).status).toBe(200);
      },
    ),
  );
});

describe("sessions API", () => {
  it.live("starts a session on POST and reports it via GET and list", () =>
    serve({}, async (base) => {
      const posted = await post(base, "/api/sessions/demo");
      expect(posted.status).toBe(200);
      expect(await posted.json()).toMatchObject({ username: "demo", watching: true });

      const got = await fetch(`${base.http}/api/sessions/demo`);
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({ username: "demo", state: "live" });

      const list = (await (await fetch(`${base.http}/api/sessions`)).json()) as { sessions: Array<Msg> };
      expect(list.sessions).toEqual([expect.objectContaining({ username: "demo", watching: true })]);

      const removed = await fetch(`${base.http}/api/sessions/demo`, { method: "DELETE" });
      expect(removed.status).toBe(200);
    }),
  );

  it.live("returns 404 for a session that is not running and 400 for a bad username", () =>
    serve({}, async (base) => {
      expect((await fetch(`${base.http}/api/sessions/nobody`)).status).toBe(404);
      expect((await fetch(`${base.http}/api/sessions/${encodeURIComponent("bad name!")}`)).status).toBe(400);
    }),
  );
});

/**
 * TikTokWeb that counts gift catalog lookups. With `failFirst`, the first lookup fails
 * with a TikTok error.
 */
const countingGiftLookups = (failFirst = false) => {
  let calls = 0;
  const tiktok = Layer.effect(
    TikTokWeb.TikTokWeb,
    Effect.gen(function* () {
      const inner = yield* TikTokWeb.TikTokWeb;
      return TikTokWeb.TikTokWeb.of({
        ...inner,
        getGifts: () =>
          Effect.suspend(() => {
            calls++;
            if (failFirst && calls === 1) {
              return Effect.fail(new TikTokRequestError({ message: "TikTok is down", status: 503 }));
            }
            return inner.getGifts();
          }),
      });
    }),
  ).pipe(Layer.provide(fakeTikTokWebLayer()));
  return { tiktok: Layer.mergeAll(tiktok, fakeWebSocketLayer().layer), calls: () => calls };
};

describe("GET /api/gifts", () => {
  it.live("returns the gift catalog", () =>
    serve({}, async (base) => {
      const res = await fetch(`${base.http}/api/gifts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gifts: Array<Msg> };
      expect(body.gifts.map((gift) => gift.name)).toEqual(["Rose", "Lion"]);
      expect(body.gifts[0]).toMatchObject({ giftId: 5655, diamondCount: 1, streakable: true });
    }),
  );

  it.live("looks up the catalog once and serves later requests from cache", () => {
    const lookups = countingGiftLookups();
    return serve({ tiktok: lookups.tiktok }, async (base) => {
      expect((await fetch(`${base.http}/api/gifts`)).status).toBe(200);
      expect((await fetch(`${base.http}/api/gifts`)).status).toBe(200);
      expect(lookups.calls()).toBe(1);
    });
  });

  it.live("maps TikTok failures to 502 and retries them on the next request", () => {
    const lookups = countingGiftLookups(true);
    return serve({ tiktok: lookups.tiktok }, async (base) => {
      const failed = await fetch(`${base.http}/api/gifts`);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "TikTok is down" });

      expect((await fetch(`${base.http}/api/gifts`)).status).toBe(200);
      expect(lookups.calls()).toBe(2);
    });
  });

  it.live("requires the token like the other API routes", () =>
    serve({ token: "s3cret" }, async (base) => {
      expect((await fetch(`${base.http}/api/gifts`)).status).toBe(401);
      expect((await fetch(`${base.http}/api/gifts?token=s3cret`)).status).toBe(200);
    }),
  );
});

describe("POST /api/sessions/:username/simulate", () => {
  it.live("rejects non-JSON content types with 415", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const res = await fetch(`${base.http}/api/sessions/demo/simulate`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ type: "follow", user: USER }),
      });
      expect(res.status).toBe(415);
    }),
  );

  it.live("returns 404 when there is no session to inject into", () =>
    serve({}, async (base) => {
      const res = await post(base, "/api/sessions/demo/simulate", { type: "follow", user: USER });
      expect(res.status).toBe(404);
    }),
  );

  it.live("rejects an invalid event with 400", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const res = await post(base, "/api/sessions/demo/simulate", {
        type: "gift",
        user: USER,
        repeatCount: "3",
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as Msg).toHaveProperty("error");
    }),
  );

  it.live("delivers a valid event to WebSocket subscribers", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo" });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        const res = await simulateFollow(base, "sim-follow-1");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          ok: true,
          event: { type: "follow", msgId: "sim-follow-1" },
        });

        const delivered = await client.waitFor(
          (m) => m.type === "event" && m.event.msgId === "sim-follow-1",
          "follow",
        );
        expect(delivered).toMatchObject({ username: "demo", event: { type: "follow" } });
        expect(delivered.replay).toBeUndefined();
      } finally {
        closeAll(open);
      }
    }),
  );
});

describe("WebSocket protocol", () => {
  it.live("sends hello first with the protocol version", () =>
    serve({ serverVersion: "9.9.9" }, async (base) => {
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        const hello = await client.waitFor((m) => m.type === "hello", "hello");
        expect(hello).toEqual({ type: "hello", protocolVersion: 1, serverVersion: "9.9.9" });
        expect(client.messages[0]).toEqual(hello);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("reports invalid JSON and unknown actions as invalid_message", () =>
    serve({}, async (base) => {
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send("not json{");
        const first = await client.waitFor((m) => m.type === "error", "error 1");
        expect(first).toMatchObject({ type: "error", code: "invalid_message" });

        client.send({ action: "explode" });
        const second = await client.waitFor((m) => m.type === "error" && m !== first, "error 2");
        expect(second).toMatchObject({ type: "error", code: "invalid_message" });
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("reports bad usernames as invalid_username", () =>
    serve({}, async (base) => {
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "not valid!" });
        const error = await client.waitFor((m) => m.type === "error", "error");
        expect(error).toMatchObject({ code: "invalid_username" });
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("limits the number of streamers per socket", () =>
    serve({ maxSubscriptionsPerSocket: 2 }, async (base) => {
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo" });
        client.send({ action: "subscribe", username: "alpha" });
        client.send({ action: "subscribe", username: "beta" });
        const error = await client.waitFor((m) => m.type === "error", "error");
        expect(error).toMatchObject({ code: "too_many_subscriptions" });

        // Re-subscribing to an existing streamer doesn't count against the limit.
        client.send({ action: "subscribe", username: "demo" });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");
        expect(client.messages.filter((m) => m.type === "error")).toHaveLength(1);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("only delivers the event types requested", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo", events: ["gift"] });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        await post(base, "/api/sessions/demo/simulate", {
          type: "chat",
          user: USER,
          comment: "hi",
          emotes: [],
          msgId: "filter-chat",
        });
        await post(base, "/api/sessions/demo/simulate", {
          type: "gift",
          user: USER,
          giftId: 1,
          giftName: "Rose",
          giftImageUrl: "",
          diamondCount: 1,
          repeatCount: 1,
          streaking: false,
          totalDiamonds: 1,
          groupId: "g1",
          msgId: "filter-gift",
        });
        // Messages arrive in order, so once the gift is here any chat would already have arrived.
        await client.waitFor((m) => m.type === "event" && m.event.msgId === "filter-gift", "gift");

        expect(eventMessages(client).every((m) => m.event.type === "gift")).toBe(true);
        expect(eventMessages(client).some((m) => m.event.msgId === "filter-chat")).toBe(false);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("stops delivering a streamer after unsubscribe", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo" });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        client.send({ action: "unsubscribe", username: "demo" });
        await sleep(100);
        const mark = client.messages.length;

        await simulateFollow(base, "after-unsub");
        await sleep(300);
        expect(
          client.messages.slice(mark).some((m) => m.type === "event" && m.event.msgId === "after-unsub"),
        ).toBe(false);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("supports the /ws?username= shortcut with an events filter", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws?username=demo&events=chat`, open);
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        await post(base, "/api/sessions/demo/simulate", {
          type: "follow",
          user: USER,
          msgId: "short-follow",
        });
        await post(base, "/api/sessions/demo/simulate", {
          type: "chat",
          user: USER,
          comment: "yo",
          emotes: [],
          msgId: "short-chat",
        });
        await client.waitFor((m) => m.type === "event" && m.event.msgId === "short-chat", "chat");

        expect(eventMessages(client).every((m) => m.event.type === "chat")).toBe(true);
        expect(eventMessages(client).some((m) => m.event.msgId === "short-follow")).toBe(false);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("replays recent history when replay is requested", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      await simulateFollow(base, "replay-follow");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws?username=demo&replay=1`, open);
        const replayed = await client.waitFor(
          (m) => m.type === "event" && m.event.msgId === "replay-follow",
          "replayed follow",
        );
        expect(replayed).toMatchObject({ username: "demo", replay: true, event: { type: "follow" } });
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("does not replay when replay is not requested", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      await simulateFollow(base, "no-replay-follow");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws?username=demo`, open);
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");
        expect(client.messages.some((m) => m.replay === true)).toBe(false);
      } finally {
        closeAll(open);
      }
    }),
  );
});

describe("static files and client bundle", () => {
  const makeSite = () => {
    const root = mkdtempSync(join(tmpdir(), "tiklive-static-"));
    tmpDirs.push(root);
    const site = join(root, "site");
    mkdirSync(site);
    writeFileSync(join(site, "index.html"), "<h1>overlay</h1>");
    writeFileSync(join(root, "secret.txt"), "TOP SECRET");
    return { root, site };
  };

  it.live("serves index.html with hardening headers", () => {
    const { site } = makeSite();
    return serve({ staticDir: site }, async (base) => {
      const res = await fetch(`${base.http}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await res.text()).toBe("<h1>overlay</h1>");
    });
  });

  it.live("does not serve files outside the static directory", () => {
    const { site } = makeSite();
    return serve({ staticDir: site }, async (base) => {
      for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/..%2F..%2Fsecret.txt"]) {
        const res = await raw(base.port, path);
        expect(res.status).not.toBe(200);
        expect(res.body).not.toContain("TOP SECRET");
      }
      // Literal dot segments are normalized by the URL parser and stay inside the root.
      const literal = await raw(base.port, "/../secret.txt");
      expect(literal.status).not.toBe(200);
      expect(literal.body).not.toContain("TOP SECRET");
    });
  });

  it.live("returns a comment with 404 for /tiklive.js when no bundle is configured", () =>
    serve({}, async (base) => {
      const res = await fetch(`${base.http}/tiklive.js`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("client bundle not built");
    }),
  );

  it.live("serves the client bundle at /tiklive.js when configured", () => {
    const { root } = makeSite();
    const bundle = join(root, "tiklive.js");
    writeFileSync(bundle, "window.tiklive = {};");
    return serve({ clientBundle: bundle }, async (base) => {
      const res = await fetch(`${base.http}/tiklive.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toBe("window.tiklive = {};");
    });
  });

  const encoder = new TextEncoder();
  const embedded = new Map<string, Uint8Array>([
    ["/index.html", encoder.encode("<h1>embedded dashboard</h1>")],
    ["/overlays/chat.html", encoder.encode("<p>chat overlay</p>")],
    ["/tiklive.js", encoder.encode("window.tiklive = { embedded: true };")],
  ]);

  it.live("serves in-memory assets with the content type and hardening headers", () =>
    serve({ assets: embedded }, async (base) => {
      const res = await fetch(`${base.http}/overlays/chat.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await res.text()).toBe("<p>chat overlay</p>");
    }),
  );

  it.live("serves index.html for / and for directory URLs", () =>
    serve({ assets: embedded }, async (base) => {
      for (const path of ["/", "/index.html"]) {
        const res = await fetch(`${base.http}${path}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<h1>embedded dashboard</h1>");
      }
    }),
  );

  it.live("returns 404 for unknown asset paths", () =>
    serve({ assets: embedded }, async (base) => {
      const res = await fetch(`${base.http}/overlays/missing.html`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("chat overlay");
    }),
  );

  it.live("serves /tiklive.js from assets when no bundle file is configured", () =>
    serve({ assets: embedded }, async (base) => {
      const res = await fetch(`${base.http}/tiklive.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toBe("window.tiklive = { embedded: true };");
    }),
  );

  it.live("prefers the staticDir over in-memory assets", () => {
    const { site } = makeSite();
    return serve({ staticDir: site, assets: embedded }, async (base) => {
      const res = await fetch(`${base.http}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>overlay</h1>");
      const chat = await fetch(`${base.http}/overlays/chat.html`);
      expect(chat.status).toBe(404);
    });
  });
});
