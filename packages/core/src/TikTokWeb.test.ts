import { describe, expect, it } from "@effect/vitest";
import { parseGiftList, pickHlsUrl } from "./TikTokWeb.ts";

describe("parseGiftList", () => {
  it("maps catalog entries to GiftInfo, skipping entries without an id or name", () => {
    const gifts = parseGiftList({
      status_code: 0,
      data: {
        gifts: [
          {
            id: 5655,
            name: "Rose",
            diamond_count: 1,
            type: 1,
            image: { url_list: ["https://img.example/rose.webp"] },
          },
          { name: "No id", diamond_count: 5, type: 0 },
          { id: 1, diamond_count: 5, type: 0 },
          { id: 2, name: "Lion", diamond_count: 29999, type: 0 },
        ],
      },
    });

    expect(gifts).toEqual([
      {
        giftId: 5655,
        name: "Rose",
        diamondCount: 1,
        imageUrl: "https://img.example/rose.webp",
        streakable: true,
      },
      { giftId: 2, name: "Lion", diamondCount: 29999, imageUrl: "", streakable: false },
    ]);
  });

  it("sorts by price, then name", () => {
    const gifts = parseGiftList({
      data: {
        gifts: [
          { id: 3, name: "Zeta", diamond_count: 5 },
          { id: 4, name: "Alpha", diamond_count: 5 },
          { id: 5, name: "Cheap", diamond_count: 1 },
        ],
      },
    });
    expect(gifts.map((g) => g.name)).toEqual(["Cheap", "Alpha", "Zeta"]);
  });

  it("returns an empty list for unexpected shapes", () => {
    expect(parseGiftList(null)).toEqual([]);
    expect(parseGiftList({})).toEqual([]);
    expect(parseGiftList({ data: { gifts: "nope" } })).toEqual([]);
  });
});

describe("pickHlsUrl", () => {
  const streamData = (data: unknown) => JSON.stringify({ common: {}, data });

  it("prefers a small video quality and skips audio only", () => {
    const url = pickHlsUrl(
      streamData({
        ao: { main: { hls: "https://cdn.example/ao.m3u8" } },
        hd: { main: { hls: "https://cdn.example/hd.m3u8" } },
        sd: { main: { hls: "https://cdn.example/sd.m3u8" } },
      }),
    );
    expect(url).toBe("https://cdn.example/sd.m3u8");
    expect(
      pickHlsUrl(
        streamData({
          ao: { main: { hls: "https://cdn.example/ao.m3u8" } },
          hd: { main: { hls: "https://cdn.example/hd.m3u8" } },
        }),
      ),
    ).toBe("https://cdn.example/hd.m3u8");
  });

  it("falls back to an unknown quality name", () => {
    expect(pickHlsUrl(streamData({ fhd: { main: { hls: "https://cdn.example/fhd.m3u8" } } }))).toBe(
      "https://cdn.example/fhd.m3u8",
    );
  });

  it("returns undefined for missing, invalid or non-https data", () => {
    expect(pickHlsUrl(undefined)).toBeUndefined();
    expect(pickHlsUrl("not json")).toBeUndefined();
    expect(pickHlsUrl("null")).toBeUndefined();
    expect(pickHlsUrl(streamData({}))).toBeUndefined();
    expect(pickHlsUrl(streamData({ sd: { main: { hls: "javascript:alert(1)" } } }))).toBeUndefined();
    expect(pickHlsUrl(streamData({ ao: { main: { hls: "https://cdn.example/ao.m3u8" } } }))).toBeUndefined();
  });
});
