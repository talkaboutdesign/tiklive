import { describe, expect, it } from "@effect/vitest";
import { parseGiftList } from "./TikTokWeb.ts";

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
