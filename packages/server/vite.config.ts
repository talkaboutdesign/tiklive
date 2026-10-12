import { mergeConfig } from "vite-plus";
import root from "../../vite.config.ts";

// The published `tiklive` package. contracts, core and client are private
// workspace packages bundled in here, code and types, from their src/.
const SOURCE_CONDITION = "@tiklive/source";
const WORKSPACE = /^@tiklive\//;

export default mergeConfig(root, {
  pack: {
    entry: [
      "src/index.ts",
      "src/bin.ts",
      "src/platform/bun.ts",
      "src/platform/node.ts",
      "src/core.ts",
      "src/contracts.ts",
      "src/client.ts",
      "src/testing.ts",
    ],
    inputOptions: { resolve: { conditionNames: [SOURCE_CONDITION, "import", "module", "node", "default"] } },
    deps: { alwaysBundle: WORKSPACE },
    dts: { tsconfig: "tsconfig.build.json" },
    sourcemap: true,
    clean: true,
  },
  test: { include: ["src/**/*.test.ts"] },
});
