import { mergeConfig } from "vite-plus";
import root from "../../vite.config.ts";

export default mergeConfig(root, {
  pack: { entry: ["src/index.ts"], dts: { tsconfig: "tsconfig.build.json" }, sourcemap: true, clean: true },
  test: { include: ["src/**/*.test.ts"] },
});
