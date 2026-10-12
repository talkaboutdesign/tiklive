import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
  lint: {
    ignorePatterns: [".repos/**", "**/dist/**"],
    options: {
      reportUnusedDisableDirectives: "error",
    },
  },
  fmt: {
    ignorePatterns: [".repos/**", "**/dist/**"],
    printWidth: 110,
  },
});
