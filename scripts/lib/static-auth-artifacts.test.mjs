import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  artifactOverride,
  artifactPaths,
  assertImmutableArtifacts,
  integrity,
  manifestPath,
  releaseManifest,
  validateStaticAuth,
} from "./static-auth-artifacts.mjs";

const roots = [];

it("adds a release without rewriting the legacy alias or historical versions", () => {
  const f = fixture();
  const artifacts = [
    { path: artifactPaths("1.0.3")[0], sri: integrity("void 0;") },
    f.manifest.artifacts[1],
  ];
  const next = releaseManifest("1.0.3", "b".repeat(40), artifacts, f.manifest);
  expect(next.artifacts).toEqual([...artifacts, f.manifest.artifacts[0]]);
  expect(next.sourceCommit).toBe("b".repeat(40));
  expect(releaseManifest("1.0.3", "c".repeat(40), artifacts, next)).toEqual(
    next,
  );
  expect(() =>
    releaseManifest(
      "1.0.3",
      "b".repeat(40),
      [artifacts[0], { ...artifacts[1], sri: integrity("changed alias") }],
      f.manifest,
    ),
  ).toThrow("Published artifact changed");
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "static-auth-contract-"));
  roots.push(root);
  const paths = artifactPaths("1.0.2");
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const json = (path, value) => write(path, JSON.stringify(value));
  const artifacts = paths.map((path) => {
    const bytes = "globalThis.OpenSesameStaticAuth = {};\n";
    write(path, bytes);
    write(`${path}.sha384`, `${integrity(bytes)}\n`);
    return { path, sri: integrity(bytes) };
  });
  const manifest = {
    version: "1.0.2",
    packageVersion: "1.0.2",
    sourceCommit: "a".repeat(40),
    sri: artifacts[0].sri,
    artifacts,
  };
  const config = {
    linter: { enabled: true },
    formatter: { enabled: true },
    organizeImports: { enabled: true },
    files: { ignore: ["**/node_modules/**"] },
    overrides: [artifactOverride(paths)],
  };
  json(manifestPath, manifest);
  json("biome.json", config);
  json("packages/static-auth/package.json", { version: "1.0.2" });
  return { root, paths, manifest, config, write, json };
}

it("accepts only the exact regular-file inventory with verified JS and hashes", () => {
  const f = fixture();
  expect(validateStaticAuth(f.root)).toEqual(f.manifest);
});

it.each([
  "apps/pages/public/static-auth/loader.js",
  "apps/pages/public/static-auth/1.0.2/extra.js",
])(
  "rejects undeclared artifact %s even when it is valid JavaScript",
  (path) => {
    const f = fixture();
    f.write(path, "void 0;");
    expect(() => validateStaticAuth(f.root)).toThrow("Undeclared artifact");
  },
);

it("rejects undeclared version directories, including empty ones", () => {
  const f = fixture();
  mkdirSync(join(f.root, "apps/pages/public/static-auth/9.9.9"));
  expect(() => validateStaticAuth(f.root)).toThrow(
    "Undeclared artifact directory",
  );
});

it.each([0, 1])("rejects changed bytes in artifact %i", (index) => {
  const f = fixture();
  f.write(f.paths[index], "void 0;");
  expect(() => validateStaticAuth(f.root)).toThrow("Artifact hash mismatch");
});

it("rejects changed sidecars and missing files", () => {
  const f = fixture();
  f.write(`${f.paths[0]}.sha384`, "sha384-invalid\n");
  expect(() => validateStaticAuth(f.root)).toThrow();
  rmSync(join(f.root, f.paths[0]));
  expect(() => validateStaticAuth(f.root)).toThrow();
});

it("syntax-checks even correctly hashed malformed JavaScript without executing it", () => {
  const f = fixture();
  const bytes = "globalThis.shouldNeverExecute = true; function (";
  f.write(f.paths[0], bytes);
  f.manifest.artifacts[0].sri = integrity(bytes);
  f.manifest.sri = integrity(bytes);
  f.write(`${f.paths[0]}.sha384`, `${integrity(bytes)}\n`);
  f.json(manifestPath, f.manifest);
  expect(() => validateStaticAuth(f.root)).toThrow(SyntaxError);
  expect(globalThis).not.toHaveProperty("shouldNeverExecute");
});

it("rejects symlinked artifacts and distribution directories", () => {
  const f = fixture();
  const file = join(f.root, f.paths[0]);
  renameSync(file, join(f.root, "saved.js"));
  symlinkSync(join(f.root, "saved.js"), file);
  expect(() => validateStaticAuth(f.root)).toThrow("Symlinked artifact");
  rmSync(file);
  renameSync(join(f.root, "saved.js"), file);
  const directory = dirname(file);
  renameSync(directory, join(f.root, "saved-directory"));
  symlinkSync(join(f.root, "saved-directory"), directory);
  expect(() => validateStaticAuth(f.root)).toThrow("Symlinked artifact");
});

it.each(["../outside", "1.0.2/other", "*"])(
  "rejects non-version path input %s",
  (version) => {
    expect(() => artifactPaths(version)).toThrow();
  },
);

it("rejects manifest inventory, top-level integrity and provenance drift", () => {
  const f = fixture();
  for (const patch of [
    { sourceCommit: "not-a-commit" },
    { sri: integrity("other") },
    { packageVersion: "1.0.3" },
    { extra: true },
    { artifacts: [{ path: "../../outside", sri: f.manifest.sri }] },
  ]) {
    f.json(manifestPath, { ...f.manifest, ...patch });
    expect(() => validateStaticAuth(f.root)).toThrow();
  }
});

it("refuses broad or authored-code exceptions and ignored artifact directories", () => {
  const f = fixture();
  for (const path of [
    "apps/pages/public/static-auth/**",
    "packages/static-auth/src/**",
  ]) {
    f.json("biome.json", {
      ...f.config,
      overrides: [artifactOverride([...f.paths, path])],
    });
    expect(() => validateStaticAuth(f.root)).toThrow(
      "Generated-code exception drift",
    );
  }
  f.json("biome.json", {
    ...f.config,
    files: { ignore: ["apps/pages/public/static-auth/**"] },
  });
  expect(() => validateStaticAuth(f.root)).toThrow("not ignored directories");
});

it("keeps both lint entrypoints gated by rebuilt artifacts and source tests", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url)),
  );
  expect(scripts.lint).toMatch(/^pnpm lint:artifacts && /);
  expect(scripts["lint:all"]).toMatch(/^pnpm lint:artifacts && /);
  expect(scripts["lint:artifacts"]).toContain("build-static-auth.mjs --check");
  expect(scripts["lint:artifacts"]).toContain(
    "pnpm --filter @opensesame/static-auth test",
  );
  expect(scripts["lint:artifacts"]).toContain("src/lib/auth-client.test.ts");
});

it("rejects global checks disabled outside the generated override", () => {
  const f = fixture();
  for (const tool of ["linter", "formatter", "organizeImports"]) {
    f.json("biome.json", { ...f.config, [tool]: { enabled: false } });
    expect(() => validateStaticAuth(f.root)).toThrow(
      "Authored-code checks must stay enabled",
    );
  }
});

it("rejects invalid UTF-8 rather than hashing replacement characters", () => {
  const f = fixture();
  const bytes = Buffer.from([0x2f, 0x2f, 0xff, 0x0a]);
  f.write(f.paths[0], bytes);
  const normalizedHash = integrity(bytes.toString("utf8"));
  f.manifest.sri = normalizedHash;
  f.manifest.artifacts[0].sri = normalizedHash;
  f.json(manifestPath, f.manifest);
  f.write(`${f.paths[0]}.sha384`, `${normalizedHash}\n`);
  expect(() => validateStaticAuth(f.root)).toThrow();
});

it.each(["**/*.js", "**", "apps", "**/public/**"])(
  "rejects indirect artifact exclusions through %s",
  (pattern) => {
    const f = fixture();
    f.json("biome.json", { ...f.config, files: { ignore: [pattern] } });
    expect(() => validateStaticAuth(f.root)).toThrow("not ignored directories");
  },
);

it("refuses rewriting or dropping a published artifact even with a new valid hash", () => {
  const f = fixture();
  expect(() =>
    assertImmutableArtifacts(f.manifest, structuredClone(f.manifest)),
  ).not.toThrow();
  const changed = structuredClone(f.manifest);
  changed.artifacts[0].sri = integrity(
    "a replacement with its own correct hash",
  );
  expect(() => assertImmutableArtifacts(f.manifest, changed)).toThrow(
    "Published artifact changed",
  );
  changed.artifacts.shift();
  expect(() => assertImmutableArtifacts(f.manifest, changed)).toThrow(
    "removed",
  );
});
