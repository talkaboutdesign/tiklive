import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite-plus";

/** Resolves workspace packages to their TypeScript source instead of built `dist/`. */
const SOURCE_CONDITION = "@tiklive/source";

export default defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
      externalConditions: [SOURCE_CONDITION],
    },
  },
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
