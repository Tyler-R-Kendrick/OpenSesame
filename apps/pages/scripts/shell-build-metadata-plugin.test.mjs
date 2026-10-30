import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { afterEach, expect, it } from "vitest";
import { securityProfile } from "./security-profile.mjs";
import {
  SHELL_BUILD_METADATA,
  shellBuildMetadata,
} from "./shell-build-metadata-plugin.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const appRoot = join(root, "apps/pages");
const scratch = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const area = await mkdtemp(join(tmpdir(), "opensesame-shell-metadata-"));
  scratch.push(area);
  const manifestPath = "apps/pages/public/static-auth/manifest.json";
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  const files = [
    "biome.json",
    "packages/static-auth/package.json",
    "apps/pages/public/security-profile.json",
    manifestPath,
    ...manifest.artifacts.flatMap(({ path }) => [path, `${path}.sha384`]),
  ];
  for (const path of files) {
    await mkdir(dirname(join(area, path)), { recursive: true });
    await copyFile(join(root, path), join(area, path));
  }
  return {
    area,
    manifest,
    profile: join(area, "apps/pages/public/security-profile.json"),
  };
}

async function serve(root, app = join(root, "apps/pages")) {
  const cacheDir = await mkdtemp(join(tmpdir(), "opensesame-metadata-vite-"));
  scratch.push(cacheDir);
  const server = await createServer({
    root: app,
    cacheDir,
    configFile: false,
    logLevel: "silent",
    plugins: [shellBuildMetadata(root)],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", preTransformRequests: false },
  });
  servers.push(server);
  await server.listen(0);
  return server;
}

async function watching(server, file) {
  await expect
    .poll(() => server.watcher.getWatched()[dirname(file)] ?? [], {
      timeout: 5000,
    })
    .toContain(basename(file));
}

async function metadataFailure(server) {
  try {
    await server.ssrLoadModule(SHELL_BUILD_METADATA);
    return "accepted";
  } catch (error) {
    return error.message;
  }
}

it("transforms the actual shell without importing public JSON as JavaScript", async () => {
  const server = await serve(root, appRoot);
  const origin = server.resolvedUrls.local[0];
  const response = await fetch(new URL("src/host/shell-build.ts", origin));
  expect(response.status).toBe(200);
  const code = await response.text();
  for (const [, url] of code.matchAll(/^import .*?from "([^"]+)"/gm)) {
    const dependency = await fetch(new URL(url, origin));
    expect(dependency.status, url).toBe(200);
  }
  expect(code).not.toContain("/public/");
  expect(code).toContain(SHELL_BUILD_METADATA);
});

it("compiles the actual stamped profile and exact SDK release in serve and build modes", async () => {
  const { area, manifest, profile } = await fixture();
  const stamped = securityProfile({
    PAGES_DEPLOYMENT_PROFILE: "dedicated_origin",
    PAGES_CANONICAL_ORIGIN: "https://vault.example.test",
    PAGES_HEADER_SECURITY: "1",
  });
  await writeFile(profile, JSON.stringify(stamped));
  const server = await serve(area);
  const loaded = await server.ssrLoadModule(SHELL_BUILD_METADATA);
  expect(loaded.SECURITY_PROFILE).toEqual(stamped);
  expect(loaded.STATIC_AUTH).toEqual({
    version: manifest.version,
    sri: manifest.sri,
  });
  const entry = join(area, "entry.mjs");
  await writeFile(
    entry,
    `export * from ${JSON.stringify(SHELL_BUILD_METADATA)};`,
  );
  const result = await build({
    root: area,
    configFile: false,
    logLevel: "silent",
    plugins: [shellBuildMetadata(area)],
    build: { write: false, minify: false, lib: { entry, formats: ["es"] } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => output.output);
  expect(chunks).toHaveLength(1);
  const code = chunks[0].code;
  expect(code).toContain(stamped.canonicalOrigin);
  expect(code).toContain(manifest.sri);
});

it("invalidates loaded metadata when the watched stamp changes", async () => {
  const { area, profile } = await fixture();
  const server = await serve(area);
  const prior = await server.ssrLoadModule(SHELL_BUILD_METADATA);
  const stamped = securityProfile({
    PAGES_DEPLOYMENT_PROFILE: "loopback_development",
    PAGES_CANONICAL_ORIGIN: "http://127.0.0.1:5180",
  });
  expect(prior.SECURITY_PROFILE).not.toEqual(stamped);
  await watching(server, profile);
  await writeFile(profile, JSON.stringify(stamped));
  await expect
    .poll(
      async () =>
        (await server.ssrLoadModule(SHELL_BUILD_METADATA)).SECURITY_PROFILE,
      { timeout: 5000 },
    )
    .toEqual(stamped);
});

it("refuses malformed stamps and a modified SDK before returning metadata", async () => {
  const malformed = await fixture();
  await writeFile(malformed.profile, JSON.stringify({ version: 2 }));
  const badStamp = await serve(malformed.area);
  await expect(badStamp.ssrLoadModule(SHELL_BUILD_METADATA)).rejects.toThrow(
    "Invalid stamped security profile",
  );
  const tampered = await fixture();
  await writeFile(
    join(tampered.area, tampered.manifest.artifacts[0].path),
    "modified",
  );
  const badSdk = await serve(tampered.area);
  await expect(badSdk.ssrLoadModule(SHELL_BUILD_METADATA)).rejects.toThrow(
    "Artifact hash mismatch",
  );
});

it("invalidates cached release metadata when a watched SDK artifact is modified", async () => {
  const { area, manifest } = await fixture();
  const server = await serve(area);
  await server.ssrLoadModule(SHELL_BUILD_METADATA);
  const artifact = join(area, manifest.artifacts[0].path);
  await watching(server, artifact);
  await writeFile(artifact, "modified");
  await expect
    .poll(() => metadataFailure(server), { timeout: 5000 })
    .toContain("Artifact hash mismatch");
});

it("invalidates admitted metadata when only the SDK package version changes", async () => {
  const { area } = await fixture();
  const server = await serve(area);
  await server.ssrLoadModule(SHELL_BUILD_METADATA);
  const file = join(area, "packages/static-auth/package.json");
  const changed = JSON.parse(await readFile(file, "utf8"));
  changed.version = "99.0.0";
  await watching(server, file);
  await writeFile(file, JSON.stringify(changed));
  await expect
    .poll(() => metadataFailure(server), { timeout: 5000 })
    .toContain("SDK package version drift");
});

it("invalidates admitted metadata when authored-code checks are disabled", async () => {
  const { area } = await fixture();
  const server = await serve(area);
  await server.ssrLoadModule(SHELL_BUILD_METADATA);
  const file = join(area, "biome.json");
  const changed = JSON.parse(await readFile(file, "utf8"));
  changed.linter.enabled = false;
  await watching(server, file);
  await writeFile(file, JSON.stringify(changed));
  await expect
    .poll(() => metadataFailure(server), { timeout: 5000 })
    .toContain("Authored-code checks must stay enabled");
});
