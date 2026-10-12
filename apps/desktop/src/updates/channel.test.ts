import { describe, expect, it } from "@effect/vitest";
import { defaultChannel, isNightlyVersion, updaterOptions } from "./channel.ts";

describe("update channels", () => {
  it("recognizes nightly versions", () => {
    expect(isNightlyVersion("0.6.0-nightly.20261012173210")).toBe(true);
    expect(isNightlyVersion("0.6.0")).toBe(false);
    expect(isNightlyVersion("0.6.0-next.1")).toBe(false);
  });

  it("a nightly build follows nightlies by default", () => {
    expect(defaultChannel("0.6.0-nightly.20261012173210")).toBe("nightly");
    expect(defaultChannel("0.6.0")).toBe("latest");
  });

  it("only a nightly build on the stable channel may move to an older version", () => {
    expect(updaterOptions("latest", "0.6.0")).toEqual({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(updaterOptions("latest", "0.7.0-nightly.20261012173210")).toEqual({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: true,
    });
    expect(updaterOptions("nightly", "0.6.0")).toEqual({
      channel: "nightly",
      allowPrerelease: true,
      allowDowngrade: false,
    });
  });
});
