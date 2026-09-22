#!/usr/bin/env node
/**
 * Writes src/lib/vault/fixtures/vault-vectors.json (ADR 0133 §7).
 *
 * The vault modules read the runtime env through the app-core host, which
 * `src/host/boot.ts` installs from Vite's `import.meta.env`, so they load
 * through Vite's SSR module runner rather than plain Node, with the host
 * installed first. Run once; the fixture is the contract:
 *   pnpm --filter @opensesame/pages vectors:vault -- --force
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src/lib/vault/fixtures/vault-vectors.json");

if (existsSync(out) && !process.argv.includes("--force")) {
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
  const { emitVaultVectors } = await server.ssrLoadModule(
    "/scripts/vault-vectors/emit.ts",
  );
  writeFileSync(out, await emitVaultVectors());
  console.log(`wrote ${out}`);
} finally {
  await server.close();
}
