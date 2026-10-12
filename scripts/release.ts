/**
 * Publishes every @tiklive/* package whose current version isn't on npm yet.
 *
 *   bun scripts/release.ts            # publish (what CI does; expects `bun run build` first)
 *   bun scripts/release.ts --dry-run  # pack and show what would be published
 *   bun scripts/release.ts --otp=123456  # local publish with a 2FA code
 *   bun scripts/release.ts --stage    # stage instead of publish (needs 2FA approval)
 *
 * Packages are packed with `bun pm pack` (which rewrites `workspace:` and
 * `catalog:` versions) and handed to npm, which handles npm trusted publishing
 * (OIDC) in GitHub Actions. With `--stage`, versions are uploaded with
 * `npm stage publish` and only go public once a maintainer approves them with
 * 2FA (`npm stage list`, `npm stage approve <id>`, in dependency order).
 * Prints a `New tag:` line for each package it publishes.
 */
import { $ } from "bun";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Dependency order: a package is published after everything it depends on.
const PACKAGES = ["contracts", "core", "client", "server"];
const OUT = join(import.meta.dir, "..", ".release");
const dryRun = process.argv.includes("--dry-run");
const stage = process.argv.includes("--stage");
/** `--otp=123456` is passed through to npm for local publishes with an authenticator app. */
const otp = process.argv.filter((arg) => arg.startsWith("--otp="));

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
}

async function isPublished(name: string, version: string): Promise<boolean> {
  const result = await $`npm view ${`${name}@${version}`} version`.quiet().nothrow();
  return result.exitCode === 0 && result.stdout.toString().trim() === version;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const published: Array<string> = [];
for (const dir of PACKAGES) {
  const cwd = join(import.meta.dir, "..", "packages", dir);
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Manifest;
  const id = `${manifest.name}@${manifest.version}`;
  if (manifest.private) continue;
  if (manifest.version === "0.0.0") {
    console.log(`skip ${id} (unreleased placeholder version)`);
    continue;
  }
  if (!readdirSync(cwd).includes("dist"))
    throw new Error(`${manifest.name} has no dist/. Run \`bun run build\` first.`);
  if (await isPublished(manifest.name, manifest.version)) {
    console.log(`skip ${id} (already on npm)`);
    continue;
  }

  const before = new Set(readdirSync(OUT));
  await $`bun pm pack --destination ${OUT}`.cwd(cwd).quiet();
  const tarball = readdirSync(OUT).find((file) => !before.has(file));
  if (!tarball) throw new Error(`Packing ${manifest.name} produced no tarball`);

  // Prereleases go to a dist-tag named after their identifier so `latest` stays stable:
  // 0.6.0-nightly.20261012173210 → `nightly`, 0.2.0-next.1 → `next`.
  const prerelease = /^[^-]+-([0-9A-Za-z]+)/.exec(manifest.version)?.[1];
  const tag = prerelease ?? "latest";
  const command = stage ? ["npm", "stage", "publish"] : ["npm", "publish"];
  if (dryRun) {
    console.log(`would ${stage ? "stage" : "publish"} ${id} (${tarball}) with tag ${tag}`);
    continue;
  }
  const args = [...command, join(OUT, tarball), "--access", "public", "--tag", tag, ...otp];
  if (stage) {
    // A staged version isn't visible to `npm view`, so a re-run tries to stage it again.
    const result = await $`${args}`.nothrow();
    const output = `${result.stdout}${result.stderr}`;
    if (result.exitCode !== 0) {
      if (/stag/i.test(output) && /already|exist|conflict|E409/i.test(output)) {
        console.log(`skip ${id} (already staged)`);
        continue;
      }
      throw new Error(`npm stage publish failed for ${id}`);
    }
  } else {
    // Inherit the terminal so npm can run its interactive 2FA / browser login when publishing locally.
    const npm = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
    if ((await npm.exited) !== 0) throw new Error(`npm publish failed for ${id}`);
  }
  published.push(id);
  console.log(`New tag: ${id}`);
}

if (!dryRun)
  console.log(
    published.length
      ? `${stage ? "Staged" : "Published"} ${published.length} package(s).${
          stage ? " Approve them with `npm stage list` / `npm stage approve <id>`." : ""
        }`
      : "Nothing to publish.",
  );
