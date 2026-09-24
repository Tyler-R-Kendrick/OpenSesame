import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_CATALOG,
  FIXTURE_MANAGED_POLICY,
} from "./doubles/composition-fixture.js";
import { double, resetDouble } from "./doubles/test-support.js";

import { PREFS_PATH_ALIASES } from "./aliases.js";
import {
  commitInstallationSelectionSource,
  commitInstancePolicySource,
  commitVaultRestrictionSource,
  readCapabilitySource,
} from "./capabilities-adapter.js";
import {
  documentToYaml,
  parseCapabilityYaml,
} from "./capabilities-document.js";
import {
  exportInstanceConfiguration,
  reimportMatches,
} from "./capabilities-export.js";
import {
  CAPABILITY_PATH_ALIASES,
  LOCAL_POLICY_KV_KEY,
  LOCAL_POLICY_SOURCE_KV_KEY,
  SELECTION_SOURCE_KV_KEY,
} from "./capabilities-keys.js";
import {
  type CapabilityConfigPorts,
  capabilityResource,
  revisionToken,
} from "./capabilities-resources.js";
import { installDoublePorts } from "./doubles/test-support.js";
import { lookupConfigResource } from "./registry.js";

installDoublePorts();

const SELECTION = {
  schemaVersion: 1 as const,
  kind: "InstallationCapabilitySelection" as const,
  instanceId: "personal-local",
  installationId: "inst-1",
  basePolicyRevision: "0",
  revision: "1",
  acceptedRequired: [],
  selectedOptional: ["agents.webmcp"],
  chosenAlternatives: {},
  delivery: { prefetch: "none" as const, offlineCache: "shell-only" as const },
};

let store: Map<string, string>;
let ports: CapabilityConfigPorts;

beforeEach(() => {
  resetDouble({ selection: SELECTION });
  store = new Map();
  ports = {
    snapshot: () => double.getSnapshot(),
    catalog: () => FIXTURE_CATALOG,
    previewPlan: (draft) => double.preview(draft),
    commitSelection: (draft, receipt) => double.commit(draft, receipt),
    invalidate: (reason) => double.invalidate(reason),
    now: () => "2026-09-22T00:00:00Z",
    readKey: (key) => store.get(key) ?? null,
    writeKey: async (key, value) => {
      store.set(key, value);
    },
    tomb: () => "personal",
  };
});

function base() {
  return revisionToken(double.getSnapshot());
}

describe("resources resolve by display path (ADV-01 stays closed)", () => {
  it("registers every capability alias and keeps prefs and ledgers as they were", () => {
    for (const [alias, key] of CAPABILITY_PATH_ALIASES) {
      expect(lookupConfigResource(alias)).toEqual({
        ok: true,
        resourceKey: key,
      });
    }
    expect(lookupConfigResource(PREFS_PATH_ALIASES[0] ?? "")).toMatchObject({
      ok: true,
    });
    expect(
      lookupConfigResource("capabilities/../config/identity-grants").ok,
    ).toBe(false);
    expect(lookupConfigResource("capabilities/receipt.yaml").ok).toBe(false);
  });

  it("marks the effective plan read-only and a managed policy read-only", () => {
    expect(
      capabilityResource("effective-plan", double.getSnapshot()).capabilities
        .edit,
    ).toBe(false);
    expect(
      capabilityResource("instance-policy", double.getSnapshot()).capabilities
        .edit,
    ).toBe(true);
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    expect(
      capabilityResource("instance-policy", double.getSnapshot()).capabilities
        .edit,
    ).toBe(false);
  });
});

describe("CONSENT-06 — a comments-only save is presentation-only", () => {
  it("keeps the authored bytes and commits nothing", async () => {
    const source = `# my note\n${readCapabilitySource("installation-selection", ports)}`;
    const result = await commitInstallationSelectionSource(ports, {
      source,
      baseRevision: base(),
    });
    expect(result.status).toBe("applied_durable");
    expect(result.message).toContain("Nothing else changed");
    expect(double.commits).toHaveLength(0);
    expect(store.get(SELECTION_SOURCE_KV_KEY)).toBe(source);
    expect(readCapabilitySource("installation-selection", ports)).toBe(source);
  });

  it("a semantic edit goes through the store's commit with a receipt bound to the draft", async () => {
    const source = readCapabilitySource("installation-selection", ports)
      .replace("- agents.webmcp", "- agents.webmcp\n  - vault.passkey-records")
      .replace("revision: '1'", "revision: '2'")
      .replace('revision: "1"', 'revision: "2"');
    const result = await commitInstallationSelectionSource(ports, {
      source,
      baseRevision: base(),
    });
    expect(result.status).toBe("applied_durable");
    expect(double.commits).toHaveLength(1);
    expect(double.commits[0]?.draft.selectedOptional).toEqual([
      "agents.webmcp",
      "vault.passkey-records",
    ]);
    expect(double.commits[0]?.receipt.selectionRevision).toBe(
      double.commits[0]?.draft.revision,
    );
  });
});

describe("CONSENT-07 — clever YAML is refused before any commit", () => {
  const good = () => readCapabilitySource("installation-selection", ports);

  it.each([
    ["duplicate key", (s: string) => `${s}revision: '9'\n`, "Duplicate"],
    [
      "alias",
      (s: string) => `${s.replace("delivery:", "x: &a 1\ndelivery:")}y: *a\n`,
      "anchors",
    ],
    ["alias only", (s: string) => `${s}y: *a\n`, "alias"],
    [
      "tag",
      (s: string) => s.replace("kind:", "kind: !!js/function 'x'\nunused:"),
      "tag",
    ],
    ["unknown field", (s: string) => `${s}extra: true\n`, "unknown field"],
    [
      "depth",
      (s: string) =>
        `${s}deep: {a: {b: {c: {d: {e: {f: {g: {h: {i: 1}}}}}}}}}\n`,
      "deeper",
    ],
  ])("rejects %s with no commit", async (_name, mutate, expected) => {
    const result = await commitInstallationSelectionSource(ports, {
      source: mutate(good()),
      baseRevision: base(),
    });
    expect(result.status).toBe("refused");
    expect(result.message.toLowerCase()).toContain(expected.toLowerCase());
    expect(double.commits).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("rejects a document over 64 KiB", () => {
    const result = parseCapabilityYaml(`k: ${"x".repeat(64 * 1024)}\n`);
    expect(result.ok).toBe(false);
  });

  it("conflicts on a stale base revision and hands back the current source", async () => {
    const result = await commitInstallationSelectionSource(ports, {
      source: good(),
      baseRevision: "stale",
    });
    expect(result.status).toBe("conflict");
    expect(result.currentSource).toBe(good());
    expect(double.commits).toHaveLength(0);
  });
});

describe("the personal-local policy and the vault restriction", () => {
  it("writes capabilities.policy.local.v1 for a personal-local device and invalidates the store", async () => {
    const source = readCapabilitySource("instance-policy", ports).replace(
      "optional: []",
      "optional:\n  - agents.webmcp",
    );
    const result = await commitInstancePolicySource(ports, {
      source,
      baseRevision: base(),
    });
    expect(result.status).toBe("applied_durable");
    expect(
      JSON.parse(store.get(LOCAL_POLICY_KV_KEY) ?? "{}").capabilities.optional,
    ).toEqual(["agents.webmcp"]);
    expect(store.get(LOCAL_POLICY_SOURCE_KV_KEY)).toBe(source);
    expect(double.invalidations).toEqual(["local-policy-updated"]);
  });

  it("refuses to edit a policy the deployment or a signature provided", async () => {
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    const source = readCapabilitySource("instance-policy", ports);
    const result = await commitInstancePolicySource(ports, {
      source: `# c\n${source}`,
      baseRevision: base(),
    });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("read-only");
    expect(store.size).toBe(0);
  });

  it("stores a vault restriction under the tomb's own key, and only for that tomb", async () => {
    const doc = {
      schemaVersion: 1,
      kind: "VaultCapabilitySelection",
      instanceId: "personal-local",
      installationId: "inst-1",
      vaultId: "personal",
      revision: "1",
      disabled: ["agents.webmcp"],
    };
    const ok = await commitVaultRestrictionSource(ports, {
      source: documentToYaml(doc),
      baseRevision: base(),
    });
    expect(ok.status).toBe("applied_durable");
    expect(store.get("tomb/personal/capabilities.v1")).toContain(
      "agents.webmcp",
    );
    const other = await commitVaultRestrictionSource(ports, {
      source: documentToYaml({ ...doc, vaultId: "project-1" }),
      baseRevision: base(),
    });
    expect(other.status).toBe("refused");
  });
});

describe("CONSENT-10 — export reads back as the same document", () => {
  it("round-trips policy and selection through YAML with no service", () => {
    const file = exportInstanceConfiguration(double.getSnapshot());
    expect(file.fileName).toBe("opensesame-instance-configuration.yaml");
    expect(reimportMatches(file.yaml, double.getSnapshot())).toBe(true);
    expect(
      reimportMatches(`${file.yaml}extra: 1\n`, double.getSnapshot()),
    ).toBe(false);
  });
});
