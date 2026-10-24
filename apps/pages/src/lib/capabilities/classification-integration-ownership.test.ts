import { describe, expect, it } from "vitest";
import { classify } from "./classification.js";
describe("new route-shell and shared integration metadata ownership", () => {
  it("keeps precise core/shared owners and preserves optional runtime exclusion", () => {
    expect(classify("src/app-vault-shell.tsx")).toMatchObject({
      classification: "core",
      capability: "shell.navigation",
    });
    expect(classify("src/lib/integration-ai-labs.ts")).toMatchObject({
      classification: "shared",
      capability: null,
    });
    expect(classify("src/components/Notices.tsx")).toMatchObject({
      classification: "core",
      capability: "shell.navigation",
    });
    expect(classify("src/lib/ai-connections/runtime.ts")).toMatchObject({
      classification: "optional",
      capability: "connectors.external",
    });
    for (const path of [
      "src/app-vault-shelling.tsx",
      "src/app-vault-shell-runtime.tsx",
      "src/lib/integration-ai-labs-runtime.ts",
    ])
      expect(classify(path), path).toBeNull();
  });
});

describe("signed GitHub saved-backup ownership", () => {
  it("keeps the concrete backup owner family in always-on Git remote backup", () => {
    for (const path of [
      "src/lib/vault-backup-github.ts",
      "src/lib/vault-backup-github-owner.ts",
      "src/lib/vault-backup-github.test.ts",
      "src/lib/vault-backup-github-fifo.test.ts",
      "src/lib/github-app-backup-direct.ts",
      "src/lib/github-app-backup-discovery.test-support.ts",
      "src/lib/vault-backup-sync-confirmation.ts",
      "src/lib/vault-backup-observer.ts",
    ])
      expect(classify(path), path).toMatchObject({
        classification: "core",
        capability: "backup.git-remote",
      });
    for (const path of [
      "src/lib/vault-backup-githubber.ts",
      "src/lib/vault-backup-githubish-owner.ts",
    ])
      expect(classify(path), path).toBeNull();
  });
});
