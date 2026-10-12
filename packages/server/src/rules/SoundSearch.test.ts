/**
 * SoundSearch: parsing the MyInstants search page, the URL allow-list, and the search and
 * download calls against a fake fetch (nothing touches the network).
 */
import { describe, expect, it } from "@effect/vitest";
import { MAX_MEDIA_BYTES } from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  cleanQuery,
  isAllowedSoundUrl,
  layer,
  parseResults,
  SoundSearch,
  SoundSearchError,
} from "./SoundSearch.ts";

// A hand-written page in the same shape as MyInstants' search results. Not a copy of the real page.
const FIXTURE = `
<html><body><div class="results">
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/dj-airhorn-sound-effect-kingbeatz_1.mp3', 'loader-1', 'dj-airhorn')" title="Play DJ Airhorn sound" type="button"></button>
  <a href="/en/instant/dj-airhorn/" class="instant-link link-secondary">DJ Airhorn</a>
</div>
<div class="instant">
  <a class="instant-link link-secondary" href="/en/instant/tom-and-jerry/">Tom &amp; Jerry</a>
  <button class="small-button" onclick="play('/media/sounds/tom-jerry-theme.mp3', 'loader-2', 'tom')" type="button"></button>
</div>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/its-fine_2.mp3', 'loader-3', 'its')" type="button"></button>
  <a href="/en/instant/its-fine/" class="instant-link link-secondary">  It&#39;s fine &#x2014; really  </a>
</div>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/no-link.mp3', 'loader-4', 'x')" type="button"></button>
</div>
<div class="instant">
  <a href="/en/instant/no-play/" class="instant-link link-secondary">No play button</a>
</div>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/blank-title.mp3', 'loader-5', 'x')" type="button"></button>
  <a href="/en/instant/blank/" class="instant-link link-secondary">   </a>
</div>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/dj-airhorn-sound-effect-kingbeatz_1.mp3', 'loader-6', 'dup')" type="button"></button>
  <a href="/en/instant/dup/" class="instant-link link-secondary">Duplicate airhorn</a>
</div>
<div class="instant">
  <button class="small-button" onclick="play('/media/sounds/odd-link.mp3', 'loader-7', 'odd')" type="button"></button>
  <a href="http://elsewhere.example/x" class="instant-link link-secondary">Odd link &amp;lt;3</a>
</div>
</div></body></html>
`;

describe("parseResults", () => {
  it("reads titles, decodes entities, and builds absolute urls", () => {
    expect(parseResults(FIXTURE)).toEqual([
      {
        title: "DJ Airhorn",
        url: "https://www.myinstants.com/media/sounds/dj-airhorn-sound-effect-kingbeatz_1.mp3",
        pageUrl: "https://www.myinstants.com/en/instant/dj-airhorn/",
      },
      {
        title: "Tom & Jerry",
        url: "https://www.myinstants.com/media/sounds/tom-jerry-theme.mp3",
        pageUrl: "https://www.myinstants.com/en/instant/tom-and-jerry/",
      },
      {
        title: "It's fine — really",
        url: "https://www.myinstants.com/media/sounds/its-fine_2.mp3",
        pageUrl: "https://www.myinstants.com/en/instant/its-fine/",
      },
      {
        // Entities decode once: "&amp;lt;" becomes "&lt;", not "<".
        title: "Odd link &lt;3",
        url: "https://www.myinstants.com/media/sounds/odd-link.mp3",
        pageUrl: "https://www.myinstants.com/",
      },
    ]);
  });

  it("returns nothing for a page without results", () => {
    expect(parseResults("<html><body><p>No results</p></body></html>")).toEqual([]);
    expect(parseResults("")).toEqual([]);
  });
});

describe("isAllowedSoundUrl", () => {
  it.each([
    "https://www.myinstants.com/media/sounds/dj-airhorn.mp3",
    "https://myinstants.com/media/sounds/Some_File-1.2.mp3",
  ])("allows %s", (url) => {
    expect(isAllowedSoundUrl(url)).toBe(true);
  });

  it.each([
    ["http scheme", "http://www.myinstants.com/media/sounds/a.mp3"],
    ["other host", "https://example.com/media/sounds/a.mp3"],
    ["lookalike host", "https://myinstants.com.evil.com/media/sounds/a.mp3"],
    ["userinfo", "https://user@www.myinstants.com/media/sounds/a.mp3"],
    ["password", "https://user:pw@www.myinstants.com/media/sounds/a.mp3"],
    ["port", "https://www.myinstants.com:8443/media/sounds/a.mp3"],
    ["path traversal", "https://www.myinstants.com/media/sounds/../x.mp3"],
    ["other directory", "https://www.myinstants.com/media/other/a.mp3"],
    ["not an mp3", "https://www.myinstants.com/media/sounds/a.wav"],
    ["query string", "https://www.myinstants.com/media/sounds/a.mp3?x=1"],
    ["fragment", "https://www.myinstants.com/media/sounds/a.mp3#x"],
    ["not a url", "myinstants.com/media/sounds/a.mp3"],
    ["empty", ""],
  ])("refuses %s", (_label, url) => {
    expect(isAllowedSoundUrl(url)).toBe(false);
  });
});

describe("cleanQuery", () => {
  it("trims, and refuses empty or over-long queries", () => {
    expect(cleanQuery("  airhorn  ")).toBe("airhorn");
    expect(cleanQuery("   ")).toBeUndefined();
    expect(cleanQuery("a".repeat(100))).toBe("a".repeat(100));
    expect(cleanQuery("a".repeat(101))).toBeUndefined();
  });
});

// ---- service, with a fake fetch ----

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that records its calls and answers with `respond`. */
const fakeFetch = (respond: (url: string) => Response | Promise<Response> = () => htmlResponse(FIXTURE)) => {
  const calls: Array<Call> = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve().then(() => respond(url));
  };
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
};

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const audioResponse = (bytes: BodyInit, headers: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg", ...headers } });

/** Runs `body` with the service built on `fetch`. The clock is TestClock (provided by it.effect). */
const withService = <A, E>(
  fetch: typeof globalThis.fetch,
  body: (service: SoundSearch["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* SoundSearch;
    return yield* body(service);
  }).pipe(Effect.provide(layer({ fetch })));

describe("SoundSearch.search", () => {
  it.effect("builds the search URL with the encoded query and page", () => {
    const fake = fakeFetch();
    return withService(fake.fetch, (svc) => svc.search("  dj air&horn ", 2)).pipe(
      Effect.map((response) => {
        expect(fake.calls).toHaveLength(1);
        const url = new URL(fake.calls[0]!.url);
        expect(url.origin + url.pathname).toBe("https://www.myinstants.com/en/search/");
        expect(url.searchParams.get("name")).toBe("dj air&horn");
        expect(url.searchParams.get("page")).toBe("2");
        expect(response.page).toBe(2);
        expect(response.results).toHaveLength(4);
        expect(response.hasMore).toBe(false);
      }),
    );
  });

  it.effect("clamps the page number into 1 to 50", () => {
    const fake = fakeFetch(() => htmlResponse(FIXTURE));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const low = yield* svc.search("a", 0);
        const high = yield* svc.search("b", 999);
        expect(low.page).toBe(1);
        expect(high.page).toBe(50);
        expect(new URL(fake.calls[1]!.url).searchParams.get("page")).toBe("50");
      }),
    );
  });

  it.effect("reports hasMore for a full page, but not on the last page", () => {
    const block = (i: number) =>
      `<div class="instant"><button onclick="play('/media/sounds/s${i}.mp3', 'l', 'x')"></button>` +
      `<a href="/en/instant/s${i}/" class="instant-link">S${i}</a></div>`;
    const full = Array.from({ length: 36 }, (_, i) => block(i)).join("");
    const fake = fakeFetch(() => htmlResponse(full));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        expect((yield* svc.search("full", 1)).hasMore).toBe(true);
        const last = yield* svc.search("full", 50);
        expect(last.hasMore).toBe(false);
      }),
    );
  });

  it.effect("caches a page for 10 minutes and fetches again after that", () => {
    const fake = fakeFetch();
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        yield* svc.search("Airhorn", 1);
        yield* svc.search("airhorn", 1);
        expect(fake.calls).toHaveLength(1);
        yield* svc.search("airhorn", 2);
        expect(fake.calls).toHaveLength(2);

        yield* TestClock.adjust("9 minutes");
        yield* svc.search("airhorn", 1);
        expect(fake.calls).toHaveLength(2);

        yield* TestClock.adjust("1 minute");
        yield* svc.search("airhorn", 1);
        expect(fake.calls).toHaveLength(3);
      }),
    );
  });

  it.effect("turns a non-2xx response into a SoundSearchError and does not cache it", () => {
    const fake = fakeFetch(() => htmlResponse("<h1>Busy</h1>", 503));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const first = yield* svc.search("x", 1).pipe(Effect.flip);
        expect(first).toBeInstanceOf(SoundSearchError);
        expect(first.message).toBe("MyInstants returned HTTP 503");
        yield* svc.search("x", 1).pipe(Effect.flip);
        expect(fake.calls).toHaveLength(2);
      }),
    );
  });

  it.effect("turns a thrown fetch into a SoundSearchError", () => {
    const fake = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.search("x", 1).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SoundSearchError);
        expect(error.message).toBe("Couldn't reach MyInstants");
      }),
    );
  });

  it.effect("gives up after 10 seconds", () => {
    const fake = fakeFetch(() => new Promise<Response>(() => {}));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(svc.search("slow", 1).pipe(Effect.flip));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        const error = yield* Fiber.join(fiber);
        expect(error.message).toBe("Couldn't reach MyInstants");
      }),
    );
  });

  it.effect("refuses an empty or over-long query without calling MyInstants", () => {
    const fake = fakeFetch();
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const blank = yield* svc.search("   ", 1).pipe(Effect.flip);
        const long = yield* svc.search("a".repeat(101), 1).pipe(Effect.flip);
        expect(blank.message).toBe("Type 1 to 100 characters");
        expect(long.message).toBe("Type 1 to 100 characters");
        expect(fake.calls).toHaveLength(0);
      }),
    );
  });
});

describe("SoundSearch.download", () => {
  const SOUND = "https://www.myinstants.com/media/sounds/dj-airhorn.mp3";
  const BYTES = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);

  it.effect("returns the bytes and refuses redirects", () => {
    const fake = fakeFetch(() => audioResponse(BYTES));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const bytes = yield* svc.download(SOUND);
        expect(new Uint8Array(bytes)).toEqual(BYTES);
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]!.url).toBe(SOUND);
        expect(fake.calls[0]!.init?.redirect).toBe("error");
      }),
    );
  });

  it.effect("never calls fetch for a URL that is not an allowed sound", () => {
    const fake = fakeFetch(() => audioResponse(BYTES));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.download("https://example.com/media/sounds/a.mp3").pipe(Effect.flip);
        expect(error.message).toBe("Only MyInstants sound links can be imported");
        expect(fake.calls).toHaveLength(0);
      }),
    );
  });

  it.effect("refuses a response that isn't audio", () => {
    const fake = fakeFetch(() => htmlResponse("<html>not a sound</html>"));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(error.message).toBe("That link isn't an audio file");
      }),
    );
  });

  it.effect("refuses a declared size over the cap without reading the body", () => {
    const fake = fakeFetch(() => audioResponse(BYTES, { "content-length": String(MAX_MEDIA_BYTES + 1) }));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(error.message).toBe("File is over 25 MB");
      }),
    );
  });

  it.effect("stops a streamed body that goes over the cap", () => {
    // No content-length, so the size is only known as the bytes arrive.
    const fake = fakeFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(error.message).toBe("File is over 25 MB");
      }),
    );
  });

  it.effect("refuses an empty file and a non-2xx response", () => {
    let status = 200;
    const fake = fakeFetch(() =>
      status === 200 ? audioResponse(new Uint8Array(0)) : new Response("", { status }),
    );
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const empty = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(empty.message).toBe("That sound file is empty");
        status = 404;
        const missing = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(missing.message).toBe("MyInstants returned HTTP 404");
      }),
    );
  });

  it.effect("reports a failed download (including a refused redirect) as a SoundSearchError", () => {
    const fake = fakeFetch(() => Promise.reject(new TypeError("redirect mode is set to error")));
    return withService(fake.fetch, (svc) =>
      Effect.gen(function* () {
        const error = yield* svc.download(SOUND).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SoundSearchError);
        expect(error.message).toBe("Couldn't download that sound from MyInstants");
      }),
    );
  });
});
