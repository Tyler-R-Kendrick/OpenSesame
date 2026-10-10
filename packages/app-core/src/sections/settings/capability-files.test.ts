/**
 * Settings › Capabilities as files (ADR 0134): the capability documents sit
 * beside `config.yaml` and are written through the S04 adapter, so the file
 * viewer meets the refusals the switches do.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_POLICY_SOURCE_KV_KEY,
  SELECTION_SOURCE_KV_KEY,
} from "../../lib/configuration/capabilities-keys.js";
import type { CapabilityConfigPorts } from "../../lib/configuration/capabilities-resources.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_MANAGED_POLICY,
} from "../../lib/configuration/doubles/composition-fixture.js";
import { PWA_DEFAULT_OPTIONALS } from "../../lib/capabilities/pwa-defaults.js";
import {
  double,
  installDoublePorts,
  resetDouble,
} from "../../lib/configuration/doubles/test-support.js";
import {
  EFFECTIVE_FILE,
  POLICY_FILE,
  SELECTION_FILE,
  STARTER_REVISION,
  capabilityFiles,
} from "./capability-files.js";

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
let operator: boolean;
let ports: CapabilityConfigPorts;

const files = () =>
  capabilityFiles({ ports: () => ports, operator: () => operator });

beforeEach(() => {
  resetDouble({ selection: SELECTION });
  store = new Map();
  operator = true;
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

describe("capabilities as files", () => {
  it("lists the selection, the operator's policy and the effective plan, all beside config.yaml", () => {
    const listed = files().list();
    expect(listed.map((file) => file.path)).toEqual([
      SELECTION_FILE,
      POLICY_FILE,
      EFFECTIVE_FILE,
    ]);
    expect(listed[0]?.readOnly).toBe(false);
    expect(listed[1]?.readOnly).toBe(false);
    expect(listed[2]?.readOnly).toBe(true);
    for (const file of listed) {
      expect(file.path.startsWith("settings/capabilities/")).toBe(true);
    }
  });

  it("does not list the instance policy to anyone but the operator", () => {
    operator = false;
    expect(
      files()
        .list()
        .map((file) => file.path),
    ).toEqual([SELECTION_FILE, EFFECTIVE_FILE]);
  });

  it("lists the operator's policy writable, with no read-only reason", () => {
    const policy = files()
      .list()
      .find((file) => file.path === POLICY_FILE);
    expect(policy).toMatchObject({ readOnly: false });
    expect(policy?.readOnlyLabel).toBeUndefined();
  });

  describe("the instance policy is the operator's alone (SURFACE-06)", () => {
    const POLICY_TEXT = "kind: InstanceCapabilityPolicy\n";

    it("read returns nothing, check and write refuse, when not the operator", async () => {
      const provider = files();
      const operatorText = await provider.read(POLICY_FILE);
      expect(operatorText).toContain("kind:");
      operator = false;
      expect(await provider.read(POLICY_FILE)).toBe("");
      expect(provider.check(POLICY_FILE, operatorText)).toEqual({
        ok: false,
        message: "This file is read-only.",
      });
      expect(await provider.write(POLICY_FILE, operatorText)).toEqual({
        ok: false,
        message: "This file is read-only.",
      });
      expect(store.has(LOCAL_POLICY_SOURCE_KV_KEY)).toBe(false);
    });

    it("a deployment's policy is neither listed nor writable to a non-operator", async () => {
      resetDouble({
        policy: FIXTURE_MANAGED_POLICY,
        provenance: "same-origin-deployment",
      });
      operator = false;
      const provider = files();
      expect(provider.list().map((file) => file.path)).toEqual([
        SELECTION_FILE,
        EFFECTIVE_FILE,
      ]);
      expect(await provider.read(POLICY_FILE)).toBe("");
      expect(await provider.write(POLICY_FILE, POLICY_TEXT)).toMatchObject({
        ok: false,
      });
    });

    it("refuses a write while a deployment owns the policy, even for the operator flag", async () => {
      resetDouble({
        policy: FIXTURE_MANAGED_POLICY,
        provenance: "same-origin-deployment",
      });
      const provider = files();
      expect(provider.check(POLICY_FILE, POLICY_TEXT)).toMatchObject({
        ok: false,
      });
      expect(
        await provider.write(POLICY_FILE, await provider.read(POLICY_FILE)),
      ).toEqual({ ok: false, message: "This file is read-only." });
      expect(store.has(LOCAL_POLICY_SOURCE_KV_KEY)).toBe(false);
    });
  });

  it("reads each document as YAML", async () => {
    const provider = files();
    expect(await provider.read(SELECTION_FILE)).toContain(
      "kind: InstallationCapabilitySelection",
    );
    expect(await provider.read(EFFECTIVE_FILE)).toContain(
      "approvedCapabilities",
    );
    expect(await provider.read("settings/capabilities/nope.yaml")).toBe("");
  });

  it("refuses text the adapter's parser refuses, and any write to the effective plan", async () => {
    const provider = files();
    expect(provider.check(SELECTION_FILE, "kind: [")).toMatchObject({
      ok: false,
    });
    expect(
      provider.check(SELECTION_FILE, await provider.read(SELECTION_FILE)),
    ).toEqual({ ok: true });
    expect(provider.check(EFFECTIVE_FILE, "x: 1")).toMatchObject({ ok: false });
    expect(await provider.write(EFFECTIVE_FILE, "x: 1")).toMatchObject({
      ok: false,
    });
  });

  it("a comments-only write keeps the bytes and commits nothing", async () => {
    const provider = files();
    const text = `# my note\n${await provider.read(SELECTION_FILE)}`;
    expect(await provider.write(SELECTION_FILE, text)).toEqual({
      ok: true,
      path: SELECTION_FILE,
      message: "Saved source comments. Nothing else changed.",
      tone: "ok",
      text,
    });
    expect(double.commits).toHaveLength(0);
    expect(store.get(SELECTION_SOURCE_KV_KEY)).toBe(text);
  });

  it("says a session-only write is kept for this session only, in a warn tone", async () => {
    resetDouble({ selection: SELECTION, durability: "session-only" });
    const provider = files();
    const text = `# mine\n${await provider.read(SELECTION_FILE)}`;
    expect(await provider.write(SELECTION_FILE, text)).toMatchObject({
      ok: true,
      tone: "warn",
      message:
        "Saved source comments. Nothing else changed. Kept for this session only.",
    });
  });

  it("a semantic write goes through the store's commit", async () => {
    const provider = files();
    const text = (await provider.read(SELECTION_FILE))
      .replace("- agents.webmcp", "- agents.webmcp\n  - vault.passkey-records")
      .replace("revision: '1'", "revision: '2'")
      .replace('revision: "1"', 'revision: "2"');
    expect(await provider.write(SELECTION_FILE, text)).toMatchObject({
      ok: true,
      tone: "ok",
      message: "Installation selection saved.",
    });
    expect(double.commits).toHaveLength(1);
  });

  it("a write against a stale read is a conflict, not an overwrite", async () => {
    const provider = files();
    const text = `# mine\n${await provider.read(SELECTION_FILE)}`;
    double.invalidate("another-session");
    const outcome = await provider.write(SELECTION_FILE, text);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("another session");
  });

  describe("with no committed selection", () => {
    beforeEach(() => resetDouble({ selection: null }));

    it("reads a starter document that passes check, not an empty file", async () => {
      const provider = files();
      const text = await provider.read(SELECTION_FILE);
      expect(text).toContain("kind: InstallationCapabilitySelection");
      expect(text).toContain("installationId: inst-1");
      expect(provider.check(SELECTION_FILE, text)).toEqual({ ok: true });
      expect(await provider.read(SELECTION_FILE)).toBe(text);
    });

    it("commits the starter once through the store and then reads it back", async () => {
      const provider = files();
      const text = await provider.read(SELECTION_FILE);
      expect(await provider.write(SELECTION_FILE, text)).toMatchObject({
        ok: true,
        path: SELECTION_FILE,
      });
      expect(double.commits).toHaveLength(1);
      expect(double.commits[0]?.draft.revision).toBe(STARTER_REVISION);
      expect(double.getSnapshot().selection).toMatchObject({
        revision: STARTER_REVISION,
        selectedOptional: [...PWA_DEFAULT_OPTIONALS],
      });
      expect(await provider.read(SELECTION_FILE)).toContain(
        `revision: ${STARTER_REVISION}`,
      );
    });

    it("leaves the effective plan and policy as they were", async () => {
      const provider = files();
      expect(await provider.read(EFFECTIVE_FILE)).toContain(
        "approvedCapabilities",
      );
      expect(await provider.read(POLICY_FILE)).toContain("kind:");
    });
  });

  it("cannot be removed", async () => {
    expect(await files().remove(SELECTION_FILE)).toMatchObject({ ok: false });
  });
});
