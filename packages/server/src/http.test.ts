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
import type { SoundSearchResponse } from "@tiklive/contracts";
import * as Server from "./server.ts";
import type { ServerOptions } from "./server.ts";
import { SoundSearch, SoundSearchError } from "./rules/SoundSearch.ts";

const USER = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fake TikTok + fake WebSocket so nothing touches the network. */
const fakeTikTok = () => Layer.mergeAll(fakeTikTokWebLayer({ live: true }), fakeWebSocketLayer().layer);

/** The server with an ephemeral port, plus the Node HTTP server it runs on. */
const serverLayer = (
  httpServer: HttpNodeServer,
  options: ServerOptions = {},
  sounds?: Layer.Layer<SoundSearch>,
) =>
  Server.layer({ tiktok: fakeTikTok(), serverVersion: "test", ...options }, sounds).pipe(
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
const serve = (
  options: ServerOptions,
  body: (base: Base) => Promise<void>,
  sounds?: Layer.Layer<SoundSearch>,
) => {
  const httpServer = createServer();
  return Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(serverLayer(httpServer, options, sounds));
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
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      // The dashboard's video preview loads HLS from TikTok's CDN, and nothing else remote.
      const connect = csp.split("; ").find((d) => d.startsWith("connect-src "));
      expect(connect).toContain("https://*.tiktokcdn-us.com");
      expect(connect?.split(" ")).not.toContain("https:");
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

// ---- Actions: rules, test button, media ----

const danceRule = {
  id: "dance",
  name: "Dance",
  enabled: true,
  trigger: { type: "chat", match: "command", text: "!dance" },
  steps: [{ kind: "speak", text: "{nickname} dances" }],
};

const saveRules = (base: Base, body: unknown) =>
  fetch(`${base.http}/api/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const chatCommand = (base: Base, msgId: string, comment = "!dance now") =>
  post(base, "/api/sessions/demo/simulate", { type: "chat", user: USER, comment, emotes: [], msgId });

const actionMessages = (client: Client) => client.messages.filter((m) => m.type === "action");

describe("GET and PUT /api/rules", () => {
  it.live("starts with an empty rule set", () =>
    serve({}, async (base) => {
      const res = await fetch(`${base.http}/api/rules`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revision: 0, rules: [] });
    }),
  );

  it.live("saves rules and bumps the revision", () =>
    serve({}, async (base) => {
      const saved = await saveRules(base, { revision: 0, rules: [danceRule] });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ revision: 1, rules: [danceRule] });

      const got = await fetch(`${base.http}/api/rules`);
      expect(await got.json()).toEqual({ revision: 1, rules: [danceRule] });
    }),
  );

  it.live("returns 409 with the current revision when the save is based on an old one", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      const stale = await saveRules(base, { revision: 0, rules: [] });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: "Rules changed since revision 0 (now 1). Reload and try again.",
        revision: 1,
      });
    }),
  );

  it.live("rejects a javascript: media URL with a short message naming the problem", () =>
    serve({}, async (base) => {
      const bad = {
        ...danceRule,
        steps: [{ kind: "sound", url: "javascript:alert(1)" }],
      };
      const res = await saveRules(base, { revision: 0, rules: [bad] });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as Msg;
      expect(error.length).toBeLessThanOrEqual(300);
      expect(error).toContain('at ["rules"][0]["steps"][0]["url"]');
    }),
  );

  it.live("rejects rules with more than 10 steps", () =>
    serve({}, async (base) => {
      const steps = Array.from({ length: 11 }, () => ({ kind: "speak", text: "hi" }));
      const res = await saveRules(base, { revision: 0, rules: [{ ...danceRule, steps }] });
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }),
  );

  it.live("rejects duplicate rule ids", () =>
    serve({}, async (base) => {
      const res = await saveRules(base, { revision: 0, rules: [danceRule, { ...danceRule, name: "Again" }] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Duplicate rule id: dance" });
    }),
  );

  it.live("rejects bodies that are not JSON, not JSON content, or too large", () =>
    serve({}, async (base) => {
      const wrongType = await fetch(`${base.http}/api/rules`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ revision: 0, rules: [] }),
      });
      expect(wrongType.status).toBe(415);

      const notJson = await fetch(`${base.http}/api/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{nope",
      });
      expect(notJson.status).toBe(400);
      expect(await notJson.json()).toEqual({ error: "Body must be JSON" });

      const huge = await saveRules(base, { revision: 0, rules: [], pad: "x".repeat(1024 * 1024) });
      expect(huge.status).toBe(413);
    }),
  );

  it.live("answers 405 for other methods", () =>
    serve({}, async (base) => {
      const res = await fetch(`${base.http}/api/rules`, { method: "DELETE" });
      expect(res.status).toBe(405);
    }),
  );

  it.live("answers 500 when the rules cannot be saved", () => {
    // A regular file where the data directory should be: the rules can't be written.
    const root = mkdtempSync(join(tmpdir(), "tiklive-rules-"));
    tmpDirs.push(root);
    const notADir = join(root, "not-a-dir");
    writeFileSync(notADir, "x");
    return serve({ dataDir: notADir }, async (base) => {
      const res = await saveRules(base, { revision: 0, rules: [danceRule] });
      expect(res.status).toBe(500);
      expect((await res.json()) as Msg).toHaveProperty("error");
    });
  });
});

describe("POST /api/rules/:id/test", () => {
  const testRule = (base: Base, id: string, body: unknown) => post(base, `/api/rules/${id}/test`, body);

  it.live("fires the rule to subscribers that asked for actions", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo", actions: true });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        const res = await testRule(base, "dance", { username: "demo" });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, action: { ruleId: "dance", test: true } });

        const action = await client.waitFor((m) => m.type === "action", "action");
        expect(action).toMatchObject({ username: "demo", action: { ruleId: "dance", test: true } });
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("returns 404 for an unknown rule id", () =>
    serve({}, async (base) => {
      await post(base, "/api/sessions/demo");
      const res = await testRule(base, "nope", { username: "demo" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No action with id nope" });
    }),
  );

  it.live("returns 404 when no session is running for the streamer", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      const res = await testRule(base, "dance", { username: "demo" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "No session for @demo. Open the dashboard or the actions player first.",
      });
    }),
  );

  it.live("validates the body", () =>
    serve({}, async (base) => {
      const missing = await testRule(base, "dance", {});
      expect(missing.status).toBe(400);
      const badName = await testRule(base, "dance", { username: "bad name!" });
      expect(badName.status).toBe(400);
      expect(await badName.json()).toEqual({ error: "Invalid username" });
      const plain = await fetch(`${base.http}/api/rules/dance/test`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "demo",
      });
      expect(plain.status).toBe(415);
    }),
  );
});

describe("actions on the WebSocket", () => {
  it.live("sends a matching action only to subscribers that asked for actions", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const withActions = await connect(`${base.ws}/ws`, open);
        withActions.send({ action: "subscribe", username: "demo", actions: true });
        const plain = await connect(`${base.ws}/ws`, open);
        plain.send({ action: "subscribe", username: "demo" });
        await withActions.waitFor((m) => m.type === "status" && m.username === "demo", "status");
        await plain.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        await chatCommand(base, "chat-action-1");
        const action = await withActions.waitFor((m) => m.type === "action", "action");
        expect(action).toMatchObject({
          username: "demo",
          action: { ruleId: "dance", user: { uniqueId: "viewer" }, steps: [{ text: "Viewer dances" }] },
        });
        // The chat itself still reaches the plain subscriber, but no action does.
        await plain.waitFor((m) => m.type === "event" && m.event.msgId === "chat-action-1", "chat");
        expect(actionMessages(plain)).toHaveLength(0);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("is not blocked by the events filter", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws`, open);
        client.send({ action: "subscribe", username: "demo", events: ["gift"], actions: true });
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");

        await chatCommand(base, "chat-filtered");
        await client.waitFor((m) => m.type === "action", "action");
        expect(eventMessages(client).some((m) => m.event.msgId === "chat-filtered")).toBe(false);
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("accepts actions=1 on the shortcut URL", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      await post(base, "/api/sessions/demo");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws?username=demo&actions=1`, open);
        await client.waitFor((m) => m.type === "status" && m.username === "demo", "status");
        await chatCommand(base, "chat-shortcut");
        const action = await client.waitFor((m) => m.type === "action", "action");
        expect(action).toMatchObject({ username: "demo", action: { ruleId: "dance" } });
      } finally {
        closeAll(open);
      }
    }),
  );

  it.live("never replays actions", () =>
    serve({}, async (base) => {
      await saveRules(base, { revision: 0, rules: [danceRule] });
      await post(base, "/api/sessions/demo");
      await chatCommand(base, "chat-before");
      const open: Array<Client> = [];
      try {
        const client = await connect(`${base.ws}/ws?username=demo&actions=1&replay=1`, open);
        // The replayed chat arrives after the status; actions are never part of the history.
        await client.waitFor((m) => m.type === "event" && m.event.msgId === "chat-before", "replayed chat");
        expect(actionMessages(client)).toHaveLength(0);
      } finally {
        closeAll(open);
      }
    }),
  );
});

describe("media library", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const newDataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tiklive-media-"));
    tmpDirs.push(dir);
    return dir;
  };
  const upload = (
    base: Base,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: string,
    name = "my pic.png",
    auth: Record<string, string> = {},
  ) =>
    fetch(`${base.http}/api/media`, {
      method: "POST",
      headers: { "content-type": contentType, "x-file-name": encodeURIComponent(name), ...auth },
      body: bytes,
    });

  it.live("uploads, lists, serves, and deletes a file", () =>
    serve({ dataDir: newDataDir() }, async (base) => {
      const created = await upload(base, PNG, "image/png");
      expect(created.status).toBe(201);
      const item = (await created.json()) as Msg;
      expect(item).toMatchObject({ name: "my pic.png", kind: "image", contentType: "image/png" });
      expect(item.url).toMatch(/^\/media\/[A-Za-z0-9._-]+\.png$/);

      const list = (await (await fetch(`${base.http}/api/media`)).json()) as { media: Array<Msg> };
      expect(list.media.map((m) => m.id)).toEqual([item.id]);

      const served = await fetch(`${base.http}${item.url}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

      const removed = await fetch(`${base.http}/api/media/${item.id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ ok: true });
      expect((await fetch(`${base.http}${item.url}`)).status).toBe(404);
      expect((await fetch(`${base.http}/api/media/${item.id}`, { method: "DELETE" })).status).toBe(404);
    }),
  );

  it.live("renames a file, keeping its URL", () =>
    serve({ dataDir: newDataDir() }, async (base) => {
      const item = (await (await upload(base, PNG, "image/png")).json()) as Msg;
      const rename = (id: string, body: unknown) =>
        fetch(`${base.http}/api/media/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const renamed = await rename(item.id as string, { name: "Logo" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ ...item, name: "Logo" });
      const list = (await (await fetch(`${base.http}/api/media`)).json()) as { media: Array<Msg> };
      expect(list.media).toEqual([{ ...item, name: "Logo" }]);

      expect((await rename(item.id as string, { name: "" })).status).toBe(400);
      expect((await rename(item.id as string, { title: "Logo" })).status).toBe(400);
      expect((await rename("0123456789abcdef", { name: "Logo" })).status).toBe(404);
      expect((await fetch(`${base.http}/api/media/${item.id}`, { method: "PUT" })).status).toBe(405);
    }),
  );

  it.live("rejects unsupported types with 415", () =>
    serve({ dataDir: newDataDir() }, async (base) => {
      const svg = await upload(base, new TextEncoder().encode("<svg/>"), "image/svg+xml", "x.svg");
      expect(svg.status).toBe(415);
      expect(await svg.json()).toHaveProperty("error");
      expect((await upload(base, PNG, "text/plain")).status).toBe(415);
    }),
  );

  it.live("rejects uploads whose content-length is over 25 MB with 413", () =>
    serve({ dataDir: newDataDir() }, async (base) => {
      const res = await raw(base.port, "/api/media", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: "File is over 25 MB." });
    }),
  );

  it.live("rejects an oversized upload without a content-length with 413", () =>
    serve({ dataDir: newDataDir() }, async (base) => {
      // Chunked, so the size isn't known up front: the server has to count the bytes as they arrive.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: base.port,
            path: "/api/media",
            method: "POST",
            headers: { "content-type": "image/png", "transfer-encoding": "chunked" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        const chunk = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < 26; i++) req.write(chunk);
        req.end();
      });
      expect(status).toBe(413);
    }),
  );

  it.live("answers 503 when the server has no data directory", () =>
    serve({}, async (base) => {
      const res = await upload(base, PNG, "image/png");
      expect(res.status).toBe(503);
      expect(((await res.json()) as Msg).error).toContain("--data-dir");
      expect(await (await fetch(`${base.http}/api/media`)).json()).toEqual({ media: [] });
    }),
  );

  it.live("serves uploads from /media even when staticDir has a media folder", () => {
    const dataDir = newDataDir();
    const site = join(dataDir, "site");
    mkdirSync(join(site, "media"), { recursive: true });
    return serve({ dataDir, staticDir: site }, async (base) => {
      const item = (await (await upload(base, PNG, "image/png")).json()) as Msg;
      const file = String(item.url).slice("/media/".length);
      writeFileSync(join(site, "media", file), "STATIC");
      const res = await fetch(`${base.http}${item.url}`);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    });
  });

  it.live("does not serve unknown names or paths outside the media directory", () => {
    const dataDir = newDataDir();
    writeFileSync(join(dataDir, "secret.txt"), "TOP SECRET");
    return serve({ dataDir }, async (base) => {
      expect((await fetch(`${base.http}/media/nope.png`)).status).toBe(404);
      for (const path of ["/media/..%2Fsecret.txt", "/media/..%2F..%2Fsecret.txt", "/media/../secret.txt"]) {
        const res = await raw(base.port, path);
        expect(res.status).toBe(404);
        expect(res.body).not.toContain("TOP SECRET");
      }
    });
  });

  it.live("requires the token for the API but not for /media files", () => {
    const dataDir = newDataDir();
    return serve({ dataDir, token: "s3cret" }, async (base) => {
      expect((await upload(base, PNG, "image/png")).status).toBe(401);
      const item = (await (
        await upload(base, PNG, "image/png", "a.png", { authorization: "Bearer s3cret" })
      ).json()) as Msg;
      expect(item).toHaveProperty("id");
      expect((await fetch(`${base.http}/api/media`)).status).toBe(401);
      // OBS loads these as plain <img> and <video> sources, without headers.
      expect((await fetch(`${base.http}${item.url}`)).status).toBe(200);
    });
  });
});

describe("sound search", () => {
  const SOUND = "https://www.myinstants.com/media/sounds/dj-airhorn.mp3";
  const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x21]);
  const PAGE_URL = "https://www.myinstants.com/en/instant/dj-airhorn/";
  const newDataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tiklive-sounds-"));
    tmpDirs.push(dir);
    return dir;
  };

  /** A SoundSearch that records its calls. `answers` replaces the default success for each method. */
  const fakeSounds = (
    answers: {
      readonly search?: (query: string, page: number) => Effect.Effect<SoundSearchResponse, SoundSearchError>;
      readonly download?: (url: string) => Effect.Effect<Uint8Array, SoundSearchError>;
    } = {},
  ) => {
    const calls = { search: [] as Array<[string, number]>, download: [] as Array<string> };
    const layer = Layer.succeed(SoundSearch)(
      SoundSearch.of({
        search: (query, page) => {
          calls.search.push([query, page]);
          return answers.search?.(query, page) ?? Effect.succeed({ results: [], page, hasMore: false });
        },
        download: (url) => {
          calls.download.push(url);
          return answers.download?.(url) ?? Effect.succeed(MP3);
        },
      }),
    );
    return { layer, calls };
  };

  const importSound = (base: Base, body: unknown) =>
    fetch(`${base.http}/api/media/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it.live("returns one page of results from the search", () => {
    const sounds = fakeSounds({
      search: (_query, page) =>
        Effect.succeed({
          results: [{ title: "DJ Airhorn", url: SOUND, pageUrl: PAGE_URL }],
          page,
          hasMore: true,
        }),
    });
    return serve(
      {},
      async (base) => {
        const res = await fetch(`${base.http}/api/sounds/search?q=%20airhorn%20&page=3`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          results: [{ title: "DJ Airhorn", url: SOUND, pageUrl: PAGE_URL }],
          page: 3,
          hasMore: true,
        });
        expect(sounds.calls.search).toEqual([["airhorn", 3]]);
      },
      sounds.layer,
    );
  });

  it.live("rejects an empty or over-long query with 400 without searching", () => {
    const sounds = fakeSounds();
    return serve(
      {},
      async (base) => {
        for (const path of [
          "/api/sounds/search",
          "/api/sounds/search?q=%20%20",
          `/api/sounds/search?q=${"a".repeat(101)}`,
        ]) {
          const res = await fetch(`${base.http}${path}`);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "Type 1 to 100 characters" });
        }
        expect(sounds.calls.search).toHaveLength(0);
      },
      sounds.layer,
    );
  });

  it.live("returns 502 when MyInstants fails", () => {
    const sounds = fakeSounds({
      search: () => Effect.fail(new SoundSearchError({ message: "MyInstants returned HTTP 503" })),
    });
    return serve(
      {},
      async (base) => {
        const res = await fetch(`${base.http}/api/sounds/search?q=airhorn`);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "MyInstants returned HTTP 503" });
        expect((await fetch(`${base.http}/api/sounds/search?q=airhorn`, { method: "POST" })).status).toBe(
          405,
        );
      },
      sounds.layer,
    );
  });

  it.live("imports a sound into the media library, named after the file by default", () => {
    const sounds = fakeSounds();
    return serve(
      { dataDir: newDataDir() },
      async (base) => {
        const created = await importSound(base, { url: SOUND });
        expect(created.status).toBe(201);
        const item = (await created.json()) as Msg;
        expect(item).toMatchObject({
          name: "dj-airhorn",
          kind: "audio",
          contentType: "audio/mpeg",
          size: MP3.length,
        });
        expect(item.url).toMatch(/^\/media\/[A-Za-z0-9._-]+\.mp3$/);
        expect(sounds.calls.download).toEqual([SOUND]);

        const list = (await (await fetch(`${base.http}/api/media`)).json()) as { media: Array<Msg> };
        expect(list.media.map((m) => m.id)).toEqual([item.id]);
        const served = await fetch(`${base.http}${item.url}`);
        expect(served.headers.get("content-type")).toBe("audio/mpeg");
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(MP3);

        const named = await importSound(base, { url: SOUND, name: "Air horn" });
        expect((await named.json()) as Msg).toMatchObject({ name: "Air horn" });
      },
      sounds.layer,
    );
  });

  it.live("refuses URLs that are not MyInstants sound links, without downloading", () => {
    const sounds = fakeSounds();
    return serve(
      { dataDir: newDataDir() },
      async (base) => {
        for (const url of [
          "https://example.com/media/sounds/a.mp3",
          "http://www.myinstants.com/media/sounds/a.mp3",
          "https://www.myinstants.com/media/sounds/../a.mp3",
        ]) {
          const res = await importSound(base, { url });
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "Only MyInstants sound links can be imported" });
        }
        expect(sounds.calls.download).toHaveLength(0);
      },
      sounds.layer,
    );
  });

  it.live("returns 502 when the download fails and 400 for a malformed body", () => {
    const sounds = fakeSounds({
      download: () => Effect.fail(new SoundSearchError({ message: "That link isn't an audio file" })),
    });
    return serve(
      { dataDir: newDataDir() },
      async (base) => {
        const failed = await importSound(base, { url: SOUND });
        expect(failed.status).toBe(502);
        expect(await failed.json()).toEqual({ error: "That link isn't an audio file" });

        expect((await importSound(base, { name: "no url" })).status).toBe(400);
        const notJson = await fetch(`${base.http}/api/media/import`, { method: "POST", body: "{}" });
        expect(notJson.status).toBe(415);
      },
      sounds.layer,
    );
  });

  it.live("returns 503 when there is no data directory for the library", () => {
    const sounds = fakeSounds();
    return serve(
      {},
      async (base) => {
        const res = await importSound(base, { url: SOUND });
        expect(res.status).toBe(503);
        expect((await res.json()) as Msg).toHaveProperty("error");
      },
      sounds.layer,
    );
  });
});
