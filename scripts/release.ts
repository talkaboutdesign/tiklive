/**
 * Publishes every @tiklive/* package whose current version isn't on npm yet.
 *
 *   bun scripts/release.ts            # publish (expects `bun run build` first)
 *   bun scripts/release.ts --dry-run  # pack and show what would be published
 *
 * Packages are packed with `bun pm pack` (which rewrites `workspace:` and
 * `catalog:` versions) and published with npm, which handles npm trusted
 * publishing (OIDC) and provenance in GitHub Actions. Prints `New tag:` lines
 * that changesets/action uses to detect a release.
 */
import { $ } from "bun";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Dependency order: a package is published after everything it depends on.
const PACKAGES = ["contracts", "core", "client", "server"];
const OUT = join(import.meta.dir, "..", ".release");
const dryRun = process.argv.includes("--dry-run");

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

  // Prereleases (e.g. 0.2.0-next.1) go to the `next` dist-tag so `latest` stays stable.
  const tag = manifest.version.includes("-") ? "next" : "latest";
  if (dryRun) {
    console.log(`would publish ${id} (${tarball}) with tag ${tag}`);
    continue;
  }
  await $`npm publish ${join(OUT, tarball)} --access public --tag ${tag}`;
  published.push(id);
  console.log(`New tag: ${id}`);
}

if (!dryRun)
  console.log(published.length ? `Published ${published.length} package(s).` : "Nothing to publish.");
