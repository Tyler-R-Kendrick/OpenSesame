import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areasForPaths,
  bundlePackageDirs,
  pushPackageDirs,
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

  it("runs the Web Push walk for the server code it exercises, which Pages does not ship", () => {
    // verify:push runs the control-plane, the push adapters and their stand-in,
    // the Host's delivery and the repositories as source: none is a Pages
    // dependency, so `bundle` alone skipped it for a change to any of them.
    for (const path of [
      "packages/control-plane/src/routes/push-subscriptions.ts",
      "packages/control-plane/src/app.ts",
      "packages/notification-adapters/src/webpush.ts",
      "packages/notification-adapters/test-support/push-standin.ts",
      "packages/identity-worker/src/web-push-channel.ts",
      "packages/identity-worker/src/cleanup.ts",
      "packages/database/src/repos/push-subscriptions-memory.ts",
      "packages/os-domain/src/notifications.ts",
    ]) {
      expect(areas([path]), path).toMatchObject({ push: true, bundle: false });
    }
  });

  it("runs the Web Push walk for the walk's own files and the harness that reuses its stack", () => {
    for (const path of [
      "apps/pages/scripts/verify-push.mjs",
      "apps/pages/scripts/lib/push-stack.mjs",
      "apps/pages/scripts/lib/push-browser-shim.mjs",
      "apps/pages/scripts/lib/push-verify-kit.mjs",
      "apps/pages/scripts/lib/capture-harness.mjs",
      "apps/pages/scripts/lib/capture-push-steps.mjs",
      "apps/pages/vite.sw-push.config.ts",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
    ]) {
      expect(areas([path]).push, path).toBe(true);
    }
  });

  it("does not run the Web Push walk for what it cannot reach", () => {
    for (const path of [
      "crates/sealed-store/src/lib.rs",
      "packages/vault-core/src/index.ts",
      "docs/operators/capability-composition.md",
      "apps/pages/scripts/lib/j-travel-journey.mjs",
    ]) {
      expect(areas([path]).push, path).toBe(false);
    }
  });

  it("walks the real graph the Web Push walk imports as source", () => {
    const dirs = pushPackageDirs(root);
    for (const dir of [
      "packages/control-plane",
      "packages/identity-worker",
      "packages/notification-adapters",
      "packages/database",
      "packages/os-domain",
    ]) {
      expect(dirs).toContain(dir);
    }
    expect(dirs).not.toContain("apps/pages");
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
    expect(ci).toContain("needs.changes.outputs.bundle == 'true'");
    expect(ci).toContain("needs.changes.outputs.rust == 'true'");
    expect(ci).toContain("needs.changes.outputs.mtls == 'true'");
    // The Web Push job runs for the Pages build (bundle) or the server code it
    // exercises (push), and `Bundle budgets` still reports it.
    expect(ci).toMatch(
      /push-e2e:[\s\S]*?if: needs\.changes\.outputs\.bundle == 'true' \|\| needs\.changes\.outputs\.push == 'true'/,
    );
    expect(ci).toMatch(
      /bundle-check:\n[\s\S]*?needs: \[changes, bundle, push-e2e\]/,
    );
    expect(ci).toContain("always() && !cancelled()");
  });
});
