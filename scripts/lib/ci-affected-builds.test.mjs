import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  buildCommand,
  planBuildCrates,
  planBuildPackages,
  readBuildPlan,
} from "./ci-affected-builds.mjs";
import {
  loadCrateNodes,
  loadPackageNodes,
  repoRootFromHere,
} from "./ci-affected-graph.mjs";

const graph = [
  { name: "shared", dir: "packages/shared", deps: [] },
  { name: "service", dir: "packages/service", deps: ["shared"] },
  { name: "app", dir: "apps/app", deps: ["service"] },
  { name: "unrelated", dir: "packages/unrelated", deps: [] },
];

test("builds changed packages and transitive consumers, leaving unrelated work out", () => {
  const plan = planBuildPackages(["packages/shared/src/index.ts"], graph);
  assert.equal(plan.scope, "packages");
  assert.deepEqual(plan.packages, ["app", "service", "shared"]);
  const command = buildCommand("packages", plan);
  assert.equal(command.command, "pnpm");
  assert.deepEqual(command.args, [
    "exec",
    "turbo",
    "run",
    "build",
    "--concurrency=4",
    "--filter=app",
    "--filter=service",
    "--filter=shared",
  ]);
});

test("the real package and Cargo graphs include downstream deployables", () => {
  const root = repoRootFromHere();
  const packages = planBuildPackages(
    ["packages/app-core/src/lib/vaults.ts"],
    loadPackageNodes(root),
  );
  assert.ok(packages.packages.includes("@opensesame/pages"));
  assert.ok(!packages.packages.includes("@opensesame/control-plane"));
  const crates = planBuildCrates(
    ["crates/sealed-store/src/lib.rs"],
    loadCrateNodes(root),
  );
  assert.ok(crates.packages.includes("opensesame-cli"));
  assert.ok(crates.packages.includes("opensesame-gateway"));
  assert.ok(!crates.packages.includes("opensesame-domain"));
});

test("the SQL workspace alias reaches storage and its transitive consumers", () => {
  const plan = planBuildCrates(
    ["crates/sql/src/lib.rs"],
    loadCrateNodes(repoRootFromHere()),
  );
  for (const name of [
    "opensesame-sql",
    "opensesame-storage",
    "opensesame-gateway",
    "opensesame-cli",
  ]) {
    assert.ok(plan.packages.includes(name), name);
  }
});

test("Cargo dependency aliases resolve inline, dotted and target-specific table declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "affected-crate-aliases-"));
  const manifests = {
    engine: '[package]\nname = "opensesame-engine"\n',
    inline:
      '[package]\nname = "opensesame-inline"\n[dependencies]\nsqlx = { workspace = true }\n',
    dotted:
      '[package]\nname = "opensesame-dotted"\n[build-dependencies]\nsqlx.workspace = true\n',
    table:
      '[package]\nname = "opensesame-table"\n[target.\'cfg(unix)\'.dependencies.local_database]\npackage = "opensesame-engine"\npath = "../engine"\n',
    direct:
      '[package]\nname = "opensesame-direct"\n[dev-dependencies]\ndatabase = { package = "opensesame-engine", path = "../engine" }\n',
    inherited:
      "[package]\nname = \"opensesame-inherited\"\n[target.'cfg(unix)'.build-dependencies.database]\nworkspace = true\n",
    unrelated: '[package]\nname = "opensesame-unrelated"\n',
  };
  try {
    writeFileSync(
      join(root, "Cargo.toml"),
      `[workspace]\nmembers = [${Object.keys(manifests)
        .map((dir) => `"crates/${dir}"`)
        .join(
          ", ",
        )}]\n[workspace.dependencies]\nsqlx = { package = "opensesame-engine", path = "crates/engine" }\n[workspace.dependencies.database]\npackage = "opensesame-engine"\npath = "crates/engine"\n`,
    );
    for (const [dir, text] of Object.entries(manifests)) {
      mkdirSync(join(root, "crates", dir), { recursive: true });
      writeFileSync(join(root, "crates", dir, "Cargo.toml"), text);
    }
    const plan = planBuildCrates(
      ["crates/engine/src/lib.rs"],
      loadCrateNodes(root),
    );
    assert.deepEqual(plan.packages, [
      "opensesame-direct",
      "opensesame-dotted",
      "opensesame-engine",
      "opensesame-inherited",
      "opensesame-inline",
      "opensesame-table",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cargo compilation selects reverse dependents without test targets", () => {
  const plan = planBuildCrates(["packages/shared/src/lib.rs"], graph);
  assert.deepEqual(plan.packages, ["app", "service", "shared"]);
  assert.deepEqual(buildCommand("cargo", plan), {
    command: "cargo",
    args: ["build", "--locked", "-p", "app", "-p", "service", "-p", "shared"],
  });
  assert.deepEqual(buildCommand("cargo", { scope: "all", packages: [] }), {
    command: "cargo",
    args: ["build", "--locked", "--workspace"],
  });
});

test("docs, CI plumbing and lint-only configuration do not start builds", () => {
  const paths = [
    "AGENTS.md",
    "docs/operators/ci-promotion.md",
    "spec/README.md",
    ".github/workflows/ci.yml",
    "scripts/lib/ci-affected-builds.mjs",
    "biome.json",
    "clippy.toml",
    "rustfmt.toml",
    "deny.toml",
  ];
  for (const plan of [
    planBuildPackages(paths, graph),
    planBuildCrates(paths, graph),
  ]) {
    assert.equal(plan.scope, "none");
    assert.equal(buildCommand("packages", plan), undefined);
    assert.equal(buildCommand("cargo", plan), undefined);
  }
});

test("shared compiler, dependency and embedded-spec inputs compile the whole graph", () => {
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.base.json",
    ".npmrc",
    "patches/dependency.patch",
    "spec/wit/host.wit",
  ]) {
    assert.equal(planBuildPackages([path], graph).scope, "all", path);
  }
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "spec/wit/host.wit",
  ]) {
    assert.equal(planBuildCrates([path], graph).scope, "all", path);
  }
  assert.deepEqual(buildCommand("packages", { scope: "all", packages: [] }), {
    command: "pnpm",
    args: ["exec", "turbo", "run", "build", "--concurrency=4"],
  });
});

test("workspace builds do not hide a separate no-emit typecheck", () => {
  const root = repoRootFromHere();
  for (const node of loadPackageNodes(root)) {
    const pkg = JSON.parse(
      readFileSync(join(root, node.dir, "package.json"), "utf8"),
    );
    if (!pkg.scripts?.build) continue;
    assert.doesNotMatch(pkg.scripts.build, /\btsc\b[^&]*--noEmit/, node.name);
    assert.doesNotMatch(
      pkg.scripts.build,
      /\b(?:pnpm|npm)(?:\s+run)?\s+typecheck\b/,
      node.name,
    );
  }
  for (const dir of ["apps/pages", "examples/rp-alpha", "examples/rp-beta"]) {
    const pkg = JSON.parse(
      readFileSync(join(root, dir, "package.json"), "utf8"),
    );
    assert.match(pkg.scripts.typecheck, /tsc\s+--noEmit/, dir);
  }
});

test("invalid empty selections fail instead of reporting a successful skipped build", () => {
  for (const kind of ["packages", "cargo"]) {
    assert.throws(
      () => buildCommand(kind, { scope: "packages", packages: [] }),
      /empty/,
    );
  }
});

test("removed package manifests trigger compilation instead of disappearing from the graph", () => {
  const root = mkdtempSync(join(tmpdir(), "affected-builds-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Tyler Kendrick",
        "-c",
        "user.email=145080887+Tyler-R-Kendrick@users.noreply.github.com",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    mkdirSync(join(root, "packages/shared"), { recursive: true });
    mkdirSync(join(root, "packages/service"), { recursive: true });
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeFileSync(
      join(root, "packages/shared/package.json"),
      JSON.stringify({ name: "shared" }),
    );
    writeFileSync(
      join(root, "packages/service/package.json"),
      JSON.stringify({
        name: "service",
        dependencies: { shared: "workspace:*" },
      }),
    );
    git("init");
    git("add", ".");
    git("commit", "-m", "fixture base");
    const base = git("rev-parse", "HEAD");
    git("rm", "-r", "packages/shared");
    git("commit", "-m", "remove dependency");
    const head = git("rev-parse", "HEAD");
    assert.equal(readBuildPlan(root, "packages", base, head).scope, "all");
    assert.equal(readBuildPlan(root, "packages", head, head).scope, "none");
    assert.equal(readBuildPlan(root, "packages", "missing", head).scope, "all");
    assert.equal(
      readBuildPlan(root, "cargo", base, "f".repeat(40)).scope,
      "all",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
