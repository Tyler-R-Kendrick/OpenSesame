import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areasForPaths,
  bundlePackageDirs,
  repoRootFromHere,
} from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const pages = ["apps/pages", "packages/app-core", "packages/vault-core"];
const pushDirs = [
  "packages/control-plane",
  "packages/database",
  "packages/identity-worker",
  "packages/notification-adapters",
  "packages/os-domain",
];

function areas(paths, dirs = pages, push = pushDirs) {
  return areasForPaths(paths, dirs, push);
}

describe("ci changed areas", () => {
  it("runs Pages checks for a journey script and skips Rust and mTLS", () => {
    expect(areas(["apps/pages/scripts/lib/j-travel-journey.mjs"])).toEqual({
      typescript: true,
      bundle: true,
      rust: false,
      mtls: false,
      push: false,
    });
  });

  it("runs Rust alone for a crate outside the mTLS set", () => {
    expect(areas(["crates/sealed-store/src/lib.rs"])).toEqual({
      typescript: false,
      bundle: false,
      rust: true,
      mtls: false,
      push: false,
    });
  });

  it("runs Rust and mTLS for the gateway and the transport crates", () => {
    expect(
      areas(["crates/gateway/src/routes/taskbus_config_tests.rs"]).mtls,
    ).toBe(true);
    expect(areas(["crates/gateway/src/lib.rs"])).toMatchObject({
      rust: true,
      mtls: true,
      typescript: false,
      bundle: false,
    });
    expect(areas(["crates/transport-security/src/lib.rs"]).mtls).toBe(true);
    expect(areas(["crates/task-bus/src/lib.rs"]).mtls).toBe(true);
  });

  it("runs mTLS for the packages and Pages files that suite executes", () => {
    expect(
      areas(["packages/os-domain/src/index.ts"], ["packages/os-domain"]),
    ).toMatchObject({
      typescript: true,
      bundle: true,
      mtls: true,
      rust: false,
    });
    expect(areas(["packages/oauth-provider/src/index.ts"], [])).toEqual({
      typescript: true,
      bundle: false,
      rust: false,
      mtls: true,
      push: false,
    });
    expect(areas(["packages/control-plane/src/app.ts"], [])).toEqual({
      typescript: true,
      bundle: false,
      rust: false,
      mtls: false,
      push: true,
    });
    expect(
      areas(["packages/control-plane/src/transport/mod.ts"], []).mtls,
    ).toBe(true);
    expect(areas(["apps/pages/scripts/lib/transport-journey.mjs"]).mtls).toBe(
      true,
    );
    expect(areas(["apps/pages/scripts/verify-transport.mjs"]).mtls).toBe(true);
    expect(areas(["packages/app-core/src/lib/transport-status.ts"]).mtls).toBe(
      true,
    );
  });
});

describe("docs and workflow files", () => {
  it("runs nothing heavy for docs, and ignores docs beside a real change", () => {
    expect(
      areas(["docs/adr/0090-static.md", "AGENTS.md", "README.md"]),
    ).toEqual({
      typescript: false,
      bundle: false,
      rust: false,
      mtls: false,
      push: false,
    });
    expect(areas(["crates/foo/README.md", "crates/foo/src/lib.rs"])).toEqual({
      typescript: false,
      bundle: false,
      rust: true,
      mtls: false,
      push: false,
    });
    expect(areas([])).toEqual({
      typescript: false,
      bundle: false,
      rust: false,
      mtls: false,
      push: false,
    });
  });

  it("runs the TypeScript contract when the workflow changes, not Rust", () => {
    expect(areas([".github/workflows/ci.yml"])).toEqual({
      typescript: true,
      bundle: false,
      rust: false,
      mtls: false,
      push: true,
    });
    expect(areas(["scripts/lib/ci-changed-areas.mjs"], [])).toMatchObject({
      typescript: true,
      rust: false,
      bundle: false,
      mtls: false,
      push: false,
    });
  });
});

describe("Pages graph and required check names", () => {
  it("rebuilds Pages for a Pages dependency and not for Identity", () => {
    expect(areas(["packages/app-core/src/lib/vaults.ts"])).toMatchObject({
      typescript: true,
      bundle: true,
      rust: false,
      mtls: false,
      push: false,
    });
    expect(areas(["packages/vault-core/src/index.ts"]).bundle).toBe(true);
    expect(areas(["packages/control-plane/src/app.ts"]).bundle).toBe(false);
    expect(areas(["tools/quality/bundle-budgets.json"]).bundle).toBe(true);
    expect(areas(["marketplace/item-types/builtin/login.json"])).toEqual({
      typescript: true,
      bundle: true,
      rust: true,
      mtls: false,
      push: false,
    });
  });

  it("treats the lockfiles as the package managers they belong to", () => {
    expect(areas(["Cargo.lock"])).toEqual({
      typescript: false,
      bundle: false,
      rust: true,
      mtls: true,
      push: false,
    });
    expect(areas(["pnpm-lock.yaml"])).toEqual({
      typescript: true,
      bundle: true,
      rust: false,
      mtls: true,
      push: true,
    });
    expect(areas(["crates/sealed-store/Cargo.toml"]).mtls).toBe(false);
    expect(areas(["crates/gateway/Cargo.toml"]).mtls).toBe(true);
  });

  it("fails open on a path it does not recognize", () => {
    expect(areas(["ops/compose/docker-compose.yml"])).toEqual({
      typescript: true,
      bundle: true,
      rust: true,
      mtls: true,
      push: true,
    });
  });

  it("walks the real Pages production graph", () => {
    const dirs = bundlePackageDirs(root);
    expect(dirs).toContain("apps/pages");
    expect(dirs).toContain("packages/app-core");
    expect(dirs).toContain("packages/vault-core");
    expect(dirs).toContain("packages/os-domain");
    expect(dirs).not.toContain("packages/control-plane");
    expect(dirs).not.toContain("packages/oauth-provider");
  });

  it("keeps the required check names and skips heavy jobs from those outputs", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci.indexOf("check-pr-signatures.mjs")).toBeLessThan(
      ci.indexOf("- name: Install"),
    );
    for (const name of ["TypeScript", "Bundle budgets", "Rust"]) {
      expect(ci).toContain(`name: ${name}\n`);
    }
    expect(ci).toContain("needs.changes.outputs.typescript == 'true'");
    expect(ci).toContain("needs.changes.outputs.bundle_matrix != '[]'");
    expect(ci).toContain("needs.changes.outputs.rust == 'true'");
    expect(ci).toContain("needs.changes.outputs.mtls == 'true'");
    expect(ci).toContain("always() && !cancelled()");
  });
});
