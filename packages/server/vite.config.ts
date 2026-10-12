import { mergeConfig } from "vite-plus";
import root from "../../vite.config.ts";

export default mergeConfig(root, {
  pack: {
    entry: ["src/index.ts", "src/bin.ts", "src/platform/bun.ts", "src/platform/node.ts"],
    dts: { tsconfig: "tsconfig.build.json" },
    sourcemap: true,
    clean: true,
  },
  test: { include: ["src/**/*.test.ts"] },
});
