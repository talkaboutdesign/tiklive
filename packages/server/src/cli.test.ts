import { describe, expect, it } from "@effect/vitest";
import { parseCli } from "./cli.ts";

describe("parseCli", () => {
  it("serves the default static directory when --static is not given", () => {
    expect(parseCli([], { defaultStaticDir: "/pkg/dist/overlays" }).staticDir).toBe("/pkg/dist/overlays");
  });

  it("prefers --static over the default directory", () => {
    expect(parseCli(["--static", "./mine"], { defaultStaticDir: "/pkg/dist/overlays" }).staticDir).toBe(
      "./mine",
    );
  });

  it("serves no static directory without either", () => {
    expect(parseCli([]).staticDir).toBeUndefined();
  });
});
