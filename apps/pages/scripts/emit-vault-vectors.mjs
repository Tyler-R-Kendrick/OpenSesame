#!/usr/bin/env node
/**
 * Writes spec/conformance/vault-vectors.json
 * (ADR 0133 §7).
 *
 * The vault modules read the runtime env through the app-core host, which
 * `src/host/boot.ts` installs from Vite's `import.meta.env`, so they load
 * through Vite's SSR module runner rather than plain Node, with the host
 * installed first. Run once; the fixture is the contract:
 *   pnpm --filter @opensesame/pages vectors:vault -- --force
 *
 * `--add device-identity` adds the one vector the device identity key needs
 * (ADR 0160 §5) to the file as it stands, leaving every other byte alone; it
 * refuses when that vector is already there.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "../../spec/conformance/vault-vectors.json");

const adding = process.argv.includes("--add");
if (existsSync(out) && !adding && !process.argv.includes("--force")) {
  console.error(
    `${out} exists. The vectors are a frozen contract; pass --force only to replace them deliberately.`,
  );
  process.exit(1);
}

const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false },
});
try {
  await server.ssrLoadModule("/src/host/boot.ts");
  const emit = await server.ssrLoadModule("/scripts/vault-vectors/emit.ts");
  if (adding) {
    const fixture = JSON.parse(readFileSync(out, "utf8"));
    if (fixture.vectors["backup-device-identity"]) {
      console.error("backup-device-identity is already in the fixture.");
      process.exit(1);
    }
    fixture.vectors["backup-device-identity"] =
      await emit.emitDeviceIdentityVector();
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    // The repository's formatter keeps a short array on one line.
    execFileSync("pnpm", ["exec", "biome", "format", "--write", out], {
      stdio: "inherit",
    });
  } else {
    writeFileSync(out, await emit.emitVaultVectors());
  }
  console.log(`wrote ${out}`);
} finally {
  await server.close();
}
