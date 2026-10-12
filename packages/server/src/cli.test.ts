import { describe, expect, it } from "@effect/vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCli } from "./cli.ts";

/** Runs `fn` with TIKLIVE_DATA_DIR set to `value` (or unset), then restores it. */
const withDataDirEnv = <A>(value: string | undefined, fn: () => A): A => {
  const previous = process.env.TIKLIVE_DATA_DIR;
  if (value === undefined) delete process.env.TIKLIVE_DATA_DIR;
  else process.env.TIKLIVE_DATA_DIR = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TIKLIVE_DATA_DIR;
    else process.env.TIKLIVE_DATA_DIR = previous;
  }
};

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

  it("keeps data in ~/.tiklive by default", () => {
    withDataDirEnv(undefined, () => {
      expect(parseCli([]).dataDir).toBe(join(homedir(), ".tiklive"));
    });
  });

  it("takes the data directory from --data-dir", () => {
    withDataDirEnv(undefined, () => {
      expect(parseCli(["--data-dir", "./data"]).dataDir).toBe("./data");
    });
  });

  it("takes the data directory from TIKLIVE_DATA_DIR, and --data-dir wins over it", () => {
    withDataDirEnv("/srv/tiklive", () => {
      expect(parseCli([]).dataDir).toBe("/srv/tiklive");
      expect(parseCli(["--data-dir", "./data"]).dataDir).toBe("./data");
    });
  });
});
