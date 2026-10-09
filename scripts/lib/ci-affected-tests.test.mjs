import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCrateNodes,
  loadPackageNodes,
  planCrates,
  planPackages,
  repoRootFromHere,
} from "./ci-affected-tests.mjs";

const root = repoRootFromHere();
const packages = loadPackageNodes(root);
const crates = loadCrateNodes(root);
const ciOnly = [
  ".github/workflows/ci.yml",
  "scripts/lib/ci-affected-tests.mjs",
  "scripts/lib/ci-affected-graph.mjs",
  "scripts/lib/ci-affected-tests.test.mjs",
  "docs/contributing/README.md",
  "AGENTS.md",
];

describe("affected packages", () => {
  it("tests Pages for a Pages file and skips Identity", () => {
    const plan = planPackages(["apps/pages/src/main.tsx"], packages);
    expect(plan.scope).toBe("packages");
    expect(plan.packages).toContain("@opensesame/pages");
    expect(plan.packages).not.toContain("@opensesame/control-plane");
    expect(plan.lintArtifacts).toBe(true);
    expect(plan.verifyExperience).toBe(true);
    expect(plan.verifyPackages).toContain("@opensesame/pages");
  });

  it("tests Pages when app-core changes", () => {
    const plan = planPackages(
      ["packages/app-core/src/lib/vaults.ts"],
      packages,
    );
    expect(plan.packages).toContain("@opensesame/app-core");
    expect(plan.packages).toContain("@opensesame/pages");
    expect(plan.packages).not.toContain("@opensesame/control-plane");
  });

  it("does not test Pages when control-plane changes", () => {
    const plan = planPackages(["packages/control-plane/src/app.ts"], packages);
    expect(plan.packages).toContain("@opensesame/control-plane");
    expect(plan.packages).not.toContain("@opensesame/pages");
  });

  it("tests vault consumers when conformance vectors change", () => {
    const plan = planPackages(
      ["spec/conformance/vault-vectors.json"],
      packages,
    );
    expect(plan.packages).toContain("@opensesame/vault-core");
    expect(plan.packages).toContain("@opensesame/pages");
    expect(plan.packages).not.toContain("@opensesame/control-plane");
  });

  it("tests nothing in turbo for scripts, workflows, and docs", () => {
    const plan = planPackages(ciOnly, packages);
    expect(plan.scope).toBe("none");
    expect(plan.packages).toEqual([]);
    expect(plan.verifyExperience).toBe(false);
    expect(plan.lintArtifacts).toBe(false);
  });

  it("tests every package when the lockfile or turbo config changes", () => {
    expect(planPackages(["pnpm-lock.yaml"], packages).scope).toBe("all");
    expect(planPackages(["turbo.json"], packages).scope).toBe("all");
    expect(planPackages(["package.json"], packages).lintArtifacts).toBe(true);
    expect(planPackages(["tsconfig.json"], packages).scope).toBe("all");
  });

  it("runs the auth artifact lint for its own files", () => {
    const plan = planPackages(
      ["scripts/lib/static-auth-artifacts.test.mjs"],
      packages,
    );
    expect(plan.scope).toBe("none");
    expect(plan.lintArtifacts).toBe(true);
  });
});

describe("affected crates", () => {
  it("tests sealed-store and the cli that depends on it, not the gateway", () => {
    const plan = planCrates(["crates/sealed-store/src/lib.rs"], crates);
    expect(plan.scope).toBe("packages");
    expect(plan.packages).toContain("opensesame-sealed-store");
    expect(plan.packages).toContain("opensesame-cli");
    expect(plan.packages).toContain("opensesame-gateway");
    expect(plan.packages).not.toContain("opensesame-domain");
    expect(plan.packages).not.toContain("opensesame-transport-security");
    expect(plan.bitwarden).toBe(true);
  });

  it("includes the gateway when domain changes", () => {
    const plan = planCrates(["crates/domain/src/lib.rs"], crates);
    expect(plan.packages).toContain("opensesame-domain");
    expect(plan.packages).toContain("opensesame-gateway");
    expect(plan.bitwarden).toBe(true);
  });

  it("tests the whole workspace for the lockfile, spec, and a crate manifest is narrow", () => {
    expect(planCrates(["Cargo.lock"], crates)).toMatchObject({
      scope: "all",
      bitwarden: true,
    });
    expect(planCrates(["spec/connectors/catalog.json"], crates).scope).toBe(
      "all",
    );
    expect(planCrates(["Cargo.toml"], crates).scope).toBe("all");
    const manifest = planCrates(["crates/sealed-store/Cargo.toml"], crates);
    expect(manifest.scope).toBe("packages");
    expect(manifest.packages).toContain("opensesame-sealed-store");
    expect(manifest.packages).toContain("opensesame-gateway");
    expect(manifest.packages).not.toContain("opensesame-domain");
  });

  it("tests nothing for docs, fuzz fixtures, and TypeScript-only paths", () => {
    expect(planCrates(["docs/adr/0090.md", "AGENTS.md"], crates).scope).toBe(
      "none",
    );
    expect(
      planCrates(["tests/fuzz/cargo/fuzz_targets/foo.rs"], crates).scope,
    ).toBe("none");
    expect(planCrates(ciOnly, crates).scope).toBe("none");
    expect(planCrates(["apps/pages/src/main.tsx"], crates).scope).toBe("none");
    expect(planCrates(["clippy.toml"], crates).scope).toBe("all");
  });
});

describe("workflow wiring", () => {
  it("keeps the keyboard journey between the bundle and rust jobs", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const bundle = workflow.split("  bundle:")[1]?.split("  rust:")[0];
    expect(bundle).toContain("pnpm --filter @opensesame/pages verify:keyboard");
    expect(workflow).toContain("ci-affected-tests.mjs plan");
    expect(workflow).toContain("ci-affected-tests.mjs run-ts");
    expect(workflow).toContain("ci-affected-tests.mjs cargo");
    expect(workflow).toContain("ci-affected-tests.mjs run-cargo");
    expect(workflow).toContain("name: Rust\n");
    expect(workflow).toContain("name: Bundle budgets\n");
  });
});
