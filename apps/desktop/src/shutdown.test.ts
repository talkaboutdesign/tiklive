import { describe, expect, it } from "@effect/vitest";
import { makeQuitHandler } from "./shutdown.ts";

describe("desktop quit", () => {
  it("waits for cleanup and shares it across repeated quit requests", async () => {
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let disposals = 0;
    let quits = 0;
    let prevented = 0;
    const quit = makeQuitHandler({
      dispose: () => {
        disposals++;
        return cleanup;
      },
      quit: () => {
        quits++;
      },
      onError: () => {
        throw new Error("unexpected failure");
      },
    });
    const event = {
      preventDefault: () => {
        prevented++;
      },
    };
    const first = quit(event);
    expect(quit(event)).toBe(first);
    await Promise.resolve();
    expect(disposals).toBe(1);
    expect(quits).toBe(0);
    expect(prevented).toBe(2);
    finish();
    await first;
    expect(quits).toBe(1);
    expect(quit(event)).toBeUndefined();
    expect(prevented).toBe(2);
  });

  it("reports cleanup failure before allowing quit", async () => {
    const calls: string[] = [];
    const quit = makeQuitHandler({
      dispose: () => Promise.reject(new Error("disk failed")),
      onError: () => {
        calls.push("error");
      },
      quit: () => {
        calls.push("quit");
      },
    });
    await quit({
      preventDefault: () => {
        calls.push("prevent");
      },
    });
    expect(calls).toEqual(["prevent", "error", "quit"]);
  });
});
