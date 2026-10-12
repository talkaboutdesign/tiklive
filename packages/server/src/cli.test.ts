import { describe, expect, it, vi } from "@effect/vitest";
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

/** Runs `fn` with TIKLIVE_TOKEN set to `value` (or unset), then restores it. */
const withTokenEnv = <A>(value: string | undefined, fn: () => A): A => {
  const previous = process.env.TIKLIVE_TOKEN;
  if (value === undefined) delete process.env.TIKLIVE_TOKEN;
  else process.env.TIKLIVE_TOKEN = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TIKLIVE_TOKEN;
    else process.env.TIKLIVE_TOKEN = previous;
  }
};

/**
 * Runs `fn` with process.exit replaced by a throw, and console output captured. Returns the exit
 * code (undefined when it did not exit), the error lines and the warning lines.
 */
class ExitSignal extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const captureExit = (fn: () => void) => {
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitSignal(code === null ? undefined : Number(code));
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let code: number | undefined;
  let errors: string[] = [];
  let warnings: string[] = [];
  try {
    fn();
  } catch (cause) {
    if (!(cause instanceof ExitSignal)) throw cause;
    code = cause.code;
  } finally {
    errors = error.mock.calls.map(String);
    warnings = warn.mock.calls.map(String);
    exit.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  }
  return { code, errors, warnings };
};

describe("parseCli", () => {
  it("exits 1 when listening beyond localhost without a token", () => {
    withTokenEnv(undefined, () => {
      const result = captureExit(() => parseCli(["--host", "0.0.0.0"]));
      expect(result.code).toBe(1);
      expect(result.errors).toEqual([
        "error: --host 0.0.0.0 exposes tiklive beyond this computer. Set --token <secret> (or TIKLIVE_TOKEN), or pass --allow-no-token if that is really what you want.",
      ]);
    });
  });

  it("exits 1 for HOST set to a non-loopback address without a token", () => {
    withTokenEnv(undefined, () => {
      const previous = process.env.HOST;
      process.env.HOST = "192.168.1.20";
      try {
        expect(captureExit(() => parseCli([])).code).toBe(1);
      } finally {
        if (previous === undefined) delete process.env.HOST;
        else process.env.HOST = previous;
      }
    });
  });

  it("accepts a non-loopback host with --token", () => {
    withTokenEnv(undefined, () => {
      const result = captureExit(() => parseCli(["--host", "0.0.0.0", "--token", "secret"]));
      expect(result.code).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("accepts a non-loopback host when TIKLIVE_TOKEN is set", () => {
    withTokenEnv("secret", () => {
      const result = captureExit(() => parseCli(["--host", "0.0.0.0"]));
      expect(result.code).toBeUndefined();
      expect(result.errors).toEqual([]);
    });
  });

  it("accepts a non-loopback host with --allow-no-token and warns", () => {
    withTokenEnv(undefined, () => {
      const result = captureExit(() => {
        const options = parseCli(["--host", "0.0.0.0", "--allow-no-token"]);
        expect(options.host).toBe("0.0.0.0");
        expect(options.token).toBeUndefined();
      });
      expect(result.code).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([
        "warning: listening beyond localhost without --token; anyone who can reach this port can use it",
      ]);
    });
  });

  it("keeps working on loopback without a token, with no warning", () => {
    withTokenEnv(undefined, () => {
      const result = captureExit(() => {
        expect(parseCli(["--host", "127.0.0.1"]).host).toBe("127.0.0.1");
        expect(parseCli([]).host).toBe("127.0.0.1");
      });
      expect(result.code).toBeUndefined();
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("starts without a token on every loopback spelling", () => {
    withTokenEnv(undefined, () => {
      for (const host of ["localhost", "LOCALHOST", "[::1]", "::1", "127.0.0.2", "0:0:0:0:0:0:0:1"]) {
        const result = captureExit(() => parseCli(["--host", host]));
        expect(result.code, host).toBeUndefined();
        expect(result.errors, host).toEqual([]);
        expect(result.warnings, host).toEqual([]);
      }
    });
  });

  it("still exits 1 for 0.0.0.0 and :: without a token", () => {
    withTokenEnv(undefined, () => {
      for (const host of ["0.0.0.0", "::"]) {
        expect(captureExit(() => parseCli(["--host", host])).code, host).toBe(1);
      }
    });
  });

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
