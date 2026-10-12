#!/usr/bin/env node
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCli } from "./cli.ts";

// The browser client: copied next to the built bin (dist/tiklive.js) by the package build,
// or resolved from the workspace when running from src/.
let clientBundle: string | undefined = fileURLToPath(new URL("./tiklive.js", import.meta.url));
if (!existsSync(clientBundle)) {
  try {
    clientBundle = fileURLToPath(import.meta.resolve("@tiklive/client/tiklive.js"));
  } catch {
    clientBundle = undefined;
  }
}

// The dashboard and example overlays, copied next to the built bin (dist/overlays) by the package build.
const overlays = fileURLToPath(new URL("./overlays/", import.meta.url));

const options = parseCli(process.argv.slice(2), {
  ...(clientBundle ? { clientBundle } : {}),
  ...(existsSync(overlays)
    ? {
        defaultStaticDir: overlays,
        helpFooter:
          "Dashboard: open http://127.0.0.1:8080/ in a browser (or the port you set) for the\n" +
          "built-in overlays (chat, goal, alerts). --static <dir> serves your own files instead.",
      }
    : {}),
});

const platform =
  typeof Bun !== "undefined" ? await import("./platform/bun.ts") : await import("./platform/node.ts");
platform.runMain(Layer.launch(platform.layer(options)));
