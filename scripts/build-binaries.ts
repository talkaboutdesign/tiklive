/**
 * Builds standalone tiklive executables with `bun build --compile`.
 *
 *   bun scripts/build-binaries.ts              current platform only
 *   bun scripts/build-binaries.ts --all        every target below
 *   bun scripts/build-binaries.ts bun-linux-x64 bun-darwin-arm64
 *
 * Output: dist/bin/tiklive-<os>-<arch>[.exe]
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embedAssets } from "./embed-assets.ts";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;
type Target = (typeof TARGETS)[number];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages", "server", "src", "standalone.ts");
const outDir = join(root, "dist", "bin");

const isTarget = (value: string): value is Target => (TARGETS as ReadonlyArray<string>).includes(value);

/** bun-<os>-<arch> for the machine running this script. */
const currentTarget = (): Target => {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const target = `bun-${os}-${process.arch}`;
  if (!isTarget(target)) throw new Error(`No standalone target for ${os}-${process.arch}`);
  return target;
};

const outputName = (target: Target) => {
  const [, os, arch] = target.split("-");
  return `tiklive-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
};

const run = async (cmd: Array<string>) => {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Command failed (exit ${code}): ${cmd.join(" ")}`);
};

const args = process.argv.slice(2);
const unknown = args.filter((arg) => !arg.startsWith("--") && !isTarget(arg));
if (unknown.length) throw new Error(`Unknown target(s): ${unknown.join(", ")}. Valid: ${TARGETS.join(", ")}`);
const explicit = args.filter(isTarget);
const targets: ReadonlyArray<Target> = explicit.length
  ? explicit
  : args.includes("--all")
    ? TARGETS
    : [currentTarget()];

await run(["bun", "run", "--filter", "@tiklive/client", "build"]);
const embedded = embedAssets();
console.log(`embedded ${embedded.count} files`);

mkdirSync(outDir, { recursive: true });
const built: Array<{ name: string; size: number }> = [];
for (const target of targets) {
  const outfile = join(outDir, outputName(target));
  console.log(`\n==> ${target} -> ${relative(root, outfile)}`);
  await run([
    process.execPath,
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    "--conditions=@tiklive/source",
    `--target=${target}`,
    entry,
    "--outfile",
    outfile,
  ]);
  built.push({ name: outputName(target), size: statSync(outfile).size });
}

console.log("\nSizes:");
for (const { name, size } of built) {
  console.log(`  ${name.padEnd(28)} ${(size / 1024 / 1024).toFixed(1)} MiB`);
}
