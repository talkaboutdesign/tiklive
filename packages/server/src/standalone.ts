/**
 * Entry point of the standalone `tiklive` executable (`bun build --compile`).
 * Same CLI as bin.ts, always on Bun, and the dashboard and overlays are embedded
 * in the binary, so no flags are needed to open http://127.0.0.1:8080/.
 */
import * as Layer from "effect/Layer";
import { parseCli } from "./cli.ts";
import { assets } from "./generated/assets.ts";
import * as BunPlatform from "./platform/bun.ts";

const options = parseCli(process.argv.slice(2), {
  assets,
  helpFooter:
    "Dashboard: open http://127.0.0.1:8080/ in a browser (or the port you set) for the\n" +
    "built-in overlays (chat, goal, alerts). --static <dir> serves your own files instead.",
});

BunPlatform.runMain(Layer.launch(BunPlatform.layer(options)));
