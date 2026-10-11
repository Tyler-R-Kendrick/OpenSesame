import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areasForPaths,
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

function areas(paths) {
  return areasForPaths(paths, pages, pushDirs);
}

describe("the Web Push walk's area", () => {
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
});

describe("the Bundle budgets aggregate", () => {
  it("gates the Web Push job on bundle or push, and Bundle budgets still reports it", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    // The Web Push job runs for the Pages build (bundle) or the server code it
    // exercises (push), and `Bundle budgets` still reports it.
    expect(ci).toMatch(
      /push-e2e:[\s\S]*?if: needs\.changes\.outputs\.push == 'true'/,
    );
    // `Bundle budgets` reports every job the bundle or push area gates: derive
    // the list from the workflow so adding a job cannot leave it unreported.
    const jobs = [
      ...ci
        .slice(ci.indexOf("\njobs:"))
        .matchAll(
          /^ {2}([a-z0-9-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gm,
        ),
    ];
    const gated = jobs
      .filter(([, , body]) =>
        /\n {4}if: needs\.changes\.outputs\.(bundle_matrix|push|tutorials|device_inbox|device_identity|live_join) (==|!=) '(true|\[\])'/.test(
          `\n${body}`,
        ),
      )
      .map(([, name]) => name);
    const check = jobs.find(([, name]) => name === "bundle-check")?.[2] ?? "";
    const needs = /needs: \[([^\]]*)\]/.exec(check)?.[1] ?? "";
    const listed = needs.split(",").map((name) => name.trim());
    expect(gated).toEqual(
      expect.arrayContaining([
        "bundle",
        "push-e2e",
        "tutorials-e2e",
        "device-inbox",
        "device-identity-e2e",
        "live-join-e2e",
      ]),
    );
    for (const name of gated) {
      expect(listed).toContain(name);
    }
    expect(listed).toContain("changes");
  });

  it("runs the device identity walk in its own job, gated on the gate the diff reaches, and Bundle budgets still reports it", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const bundle = ci.split("  bundle:")[1]?.split("  push-e2e:")[0] ?? "";
    // Out of the twenty-minute bundle job, which it had filled.
    expect(bundle).not.toContain("verify:device-identity");
    const job =
      ci.split("  device-identity-e2e:")[1]?.split("\n  rust:")[0] ?? "";
    expect(job).toContain(
      "pnpm --filter @opensesame/pages verify:device-identity",
    );
    expect(job).toContain("needs: changes");
    expect(job).toContain(
      "if: needs.changes.outputs.device_identity == 'true'",
    );
    expect(job).toContain("node scripts/lib/ci-pages-build.mjs");
    expect(job).toMatch(/timeout-minutes: 15\b/);
    // The aggregate accepts only success or skipped from it.
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toContain(
      'identity="${{ needs.device-identity-e2e.result }}"',
    );
    expect(check).toMatch(
      /case "\$identity" in\n\s+success\|skipped\) exit 0 ;;\n\s+\*\) echo[^\n]*; exit 1 ;;/,
    );
  });
});
