#!/usr/bin/env node
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { parseCli } from "./cli.ts";

let clientBundle: string | undefined;
try {
  clientBundle = fileURLToPath(import.meta.resolve("@tiklive/client/tiklive.js"));
} catch {
  clientBundle = undefined;
}

const options = parseCli(process.argv.slice(2), clientBundle ? { clientBundle } : {});

const platform =
  typeof Bun !== "undefined" ? await import("./platform/bun.ts") : await import("./platform/node.ts");
platform.runMain(Layer.launch(platform.layer(options)));
