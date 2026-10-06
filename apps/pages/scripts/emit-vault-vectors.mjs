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
 *
 * `--add derived` adds the `derived` vector (ADR 0173) the same way: one new key
 * under `vectors` (a derived password kept in the clear and sealed under the
 * OPAQUE pepper seal), refusing when it is already there.
 *
 * `--add credentials` adds the `credentials` vector (ADR 0179) the same way:
 * a body holding credentials as entries of their own, bound and not.
 *
 * `--add accounts` adds the `account` vectors (ADR 0172) the same way: new
 * keys under `vectors` and the pepper that opens them, every existing byte
 * left alone, refusing when they are already there. The legacy `login`
 * vectors are never touched. It needs only `@opensesame/vault-core`, so it
 * does not load the app-core host.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "../../spec/conformance/vault-vectors.json");

const addIndex = process.argv.indexOf("--add");
const adding = addIndex !== -1;
const addWhat = adding ? (process.argv[addIndex + 1] ?? "device-identity") : "";
if (
  adding &&
  !["device-identity", "accounts", "derived", "credentials"].includes(addWhat)
) {
  console.error(
    `--add ${addWhat}: expected device-identity, accounts, derived or credentials.`,
  );
  process.exit(1);
}
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
  if (adding && addWhat === "credentials") {
    const credentials = await server.ssrLoadModule(
      "/scripts/vault-vectors/emit-credentials.ts",
    );
    const fixture = JSON.parse(readFileSync(out, "utf8"));
    const added = await credentials.emitCredentialVectors();
    const taken = Object.keys(added).filter((name) => fixture.vectors[name]);
    if (taken.length > 0) {
      console.error(`${taken.join(", ")} already in the fixture.`);
      process.exit(1);
    }
    Object.assign(fixture.vectors, added);
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    execFileSync("pnpm", ["exec", "biome", "format", "--write", out], {
      stdio: "inherit",
    });
    console.log(`wrote ${out}`);
    await server.close();
    process.exit(0);
  }
  if (adding && addWhat === "derived") {
    const accounts = await server.ssrLoadModule(
      "/scripts/vault-vectors/emit-accounts.ts",
    );
    const fixture = JSON.parse(readFileSync(out, "utf8"));
    const added = await accounts.emitDerivedVectors();
    const taken = Object.keys(added).filter((name) => fixture.vectors[name]);
    if (taken.length > 0) {
      console.error(`${taken.join(", ")} already in the fixture.`);
      process.exit(1);
    }
    Object.assign(fixture.vectors, added);
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    execFileSync("pnpm", ["exec", "biome", "format", "--write", out], {
      stdio: "inherit",
    });
    console.log(`wrote ${out}`);
    await server.close();
    process.exit(0);
  }
  if (adding && addWhat === "accounts") {
    const accounts = await server.ssrLoadModule(
      "/scripts/vault-vectors/emit-accounts.ts",
    );
    const fixture = JSON.parse(readFileSync(out, "utf8"));
    const added = await accounts.emitAccountVectors();
    const taken = Object.keys(added.vectors).filter(
      (name) => fixture.vectors[name],
    );
    if (taken.length > 0 || fixture.accountPepper) {
      console.error(
        `${taken.join(", ") || "accountPepper"} already in the fixture.`,
      );
      process.exit(1);
    }
    Object.assign(fixture.vectors, added.vectors);
    fixture.accountPepper = added.accountPepper;
    fixture.accountPepperAbout = added.accountPepperAbout;
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    execFileSync("pnpm", ["exec", "biome", "format", "--write", out], {
      stdio: "inherit",
    });
    console.log(`wrote ${out}`);
    await server.close();
    process.exit(0);
  }
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
