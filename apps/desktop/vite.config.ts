import { builtinModules } from "node:module";
import { mergeConfig } from "vite-plus";
import root from "../../vite.config.ts";

// The main process and preload are bundled into single CJS files. Every
// dependency is inlined except Electron and Node built-ins, so electron-builder
// packages no node_modules from this app.
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const isExternal = (id: string) => id === "electron" || id.startsWith("electron/") || BUILTINS.has(id);

// Pack does not read the root `resolve.conditions`, so the @tiklive/source
// condition is added here. Workspace packages then bundle from src/, not dist/.
const SOURCE_CONDITION = "@tiklive/source";

const bundled = {
  format: "cjs",
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  clean: false,
  outExtensions: () => ({ js: ".cjs" }),
  inputOptions: {
    resolve: { conditionNames: [SOURCE_CONDITION, "import", "module", "node", "default"] },
  },
  outputOptions: { codeSplitting: false },
  deps: {
    onlyBundle: false,
    neverBundle: isExternal,
    alwaysBundle: (id: string) => !isExternal(id),
  },
} as const;

export default mergeConfig(root, {
  pack: [
    { ...bundled, entry: { main: "src/main.ts" }, clean: true },
    { ...bundled, entry: { preload: "src/preload.ts" } },
  ],
  test: { include: ["src/**/*.test.ts"] },
});
