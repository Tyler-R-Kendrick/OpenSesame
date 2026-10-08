/**
 * Vault environments: absent from the minimal installation and the default-off
 * set, and the mark and switch entry points refuse until a vault enables them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { optionalCapabilityIds } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  ENVIRONMENTS_CAPABILITY,
  ENVIRONMENT_REUSE_NOTICE_ID,
  activeEnvironment,
  assignEnvironmentValue,
  enableVaultEnvironments,
  environmentRequires,
  environmentSnapshot,
  markEnvironmentRequired,
  notifyEnvironmentValueReuse,
  notifyMissingEnvironmentValues,
  readEnvironmentValue,
  resetVaultEnvironments,
  switchEnvironment,
} from "@opensesame/app-core/lib/vault/environments.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  profilePlan,
  profileSelection,
} from "../../lib/capabilities/__tests__/vault-profiles.js";

const VAULT = "personal";
const ITEMS = [
  { id: "item-token", key: "API_TOKEN" },
  { id: "item-url", key: "API_URL" },
] as const;

function proof(name: string, body: string): void {
  const dir = process.env.ENVIRONMENTS_PROOF;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, body.endsWith("\n") ? body : `${body}\n`);
}

function approvedPlan() {
  return profilePlan("minimal-local", {
    installation: {
      ...profileSelection("minimal-local"),
      selectedOptional: [ENVIRONMENTS_CAPABILITY],
    },
  });
}

describe("vault environments", () => {
  afterEach(() => {
    resetVaultEnvironments();
    clearNotices();
  });

  it("is absent from the minimal installation and refuses mark and switch", () => {
    const minimal = profilePlan("minimal-local");
    const selection = profileSelection("minimal-local");
    expect(optionalCapabilityIds()).toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.approvedCapabilities).not.toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.capabilities[ENVIRONMENTS_CAPABILITY]?.selected).toBe(false);
    expect(minimal.capabilities[ENVIRONMENTS_CAPABILITY]?.approved).toBe(false);
    expect(selection.selectedOptional).not.toContain(ENVIRONMENTS_CAPABILITY);
    expect(minimal.approvedModules).not.toContain(
      `${ENVIRONMENTS_CAPABILITY}/runtime`,
    );

    const marked = markEnvironmentRequired(
      minimal,
      VAULT,
      "production",
      ITEMS[0].id,
      true,
    );
    const switched = switchEnvironment(minimal, VAULT, "production");
    expect(enableVaultEnvironments(minimal, VAULT)).toBe(false);
    expect(marked).toEqual({ ok: false, reason: "disabled" });
    expect(switched).toEqual({ ok: false, reason: "disabled" });

    const enabled = approvedPlan();
    expect(enableVaultEnvironments(enabled, VAULT)).toBe(true);
    expect(activeEnvironment(enabled, VAULT)).toBeNull();
    expect(environmentRequires(enabled, VAULT, "production", ITEMS[0].id)).toBe(
      false,
    );

    proof(
      "environments-capability.log",
      [
        `optional=${optionalCapabilityIds().includes(ENVIRONMENTS_CAPABILITY)}`,
        `minimalApproved=${minimal.approvedCapabilities.includes(ENVIRONMENTS_CAPABILITY)}`,
        `minimalSelected=${minimal.capabilities[ENVIRONMENTS_CAPABILITY]?.selected}`,
        `defaultOff=${!selection.selectedOptional.includes(ENVIRONMENTS_CAPABILITY)}`,
        `mark=${JSON.stringify(marked)}`,
        `switch=${JSON.stringify(switched)}`,
        `activeAfterEnable=${activeEnvironment(enabled, VAULT)}`,
        `requiredAfterRefusedMark=${environmentRequires(enabled, VAULT, "production", ITEMS[0].id)}`,
      ].join("\n"),
    );
  });

  it("renders .env.schema with @required only on marked keys", () => {
    const plan = approvedPlan();
    expect(enableVaultEnvironments(plan, VAULT, ITEMS)).toBe(true);
    expect(environmentSnapshot(VAULT).schema).toBe(
      "# @type=string\nAPI_TOKEN=\n\n# @type=string\nAPI_URL=",
    );
    expect(switchEnvironment(plan, VAULT, "production").ok).toBe(true);
    expect(
      markEnvironmentRequired(plan, VAULT, "production", ITEMS[0].id, true).ok,
    ).toBe(true);
    expect(enableVaultEnvironments(plan, VAULT, ITEMS)).toBe(true);
    const schema = environmentSnapshot(VAULT).schema;
    expect(schema).toBe(
      "# @type=string\n# @required\nAPI_TOKEN=\n\n# @type=string\nAPI_URL=",
    );
    expect(schema?.includes("# @required\nAPI_URL")).toBe(false);
    if (schema) proof("env.schema", schema);
  });

  it("keeps each environment's value when the active one changes", () => {
    const plan = approvedPlan();
    expect(enableVaultEnvironments(plan, VAULT)).toBe(true);
    expect(switchEnvironment(plan, VAULT, "staging").ok).toBe(true);
    expect(
      assignEnvironmentValue(plan, VAULT, "staging", ITEMS[0].id, "stage-value")
        .ok,
    ).toBe(true);
    expect(switchEnvironment(plan, VAULT, "production").ok).toBe(true);
    expect(
      assignEnvironmentValue(
        plan,
        VAULT,
        "production",
        ITEMS[0].id,
        "prod-value",
      ).ok,
    ).toBe(true);
    expect(switchEnvironment(plan, VAULT, "staging").ok).toBe(true);
    const staging = readEnvironmentValue(plan, VAULT, "staging", ITEMS[0].id);
    expect(activeEnvironment(plan, VAULT)).toBe("staging");
    expect(staging).toBe("stage-value");
    expect(switchEnvironment(plan, VAULT, "production").ok).toBe(true);
    const production = readEnvironmentValue(
      plan,
      VAULT,
      "production",
      ITEMS[0].id,
    );
    expect(activeEnvironment(plan, VAULT)).toBe("production");
    expect(production).toBe("prod-value");
    expect(readEnvironmentValue(plan, VAULT, "staging", ITEMS[0].id)).toBe(
      "stage-value",
    );
    proof(
      "environments-values.log",
      `staging=${staging}\nproduction=${production}\n`,
    );
  });

  it("warns when production reuses a secret value in another environment", () => {
    const plan = approvedPlan();
    enableVaultEnvironments(plan, VAULT);
    switchEnvironment(plan, VAULT, "production");
    assignEnvironmentValue(
      plan,
      VAULT,
      "production",
      ITEMS[0].id,
      "same-secret",
    );
    switchEnvironment(plan, VAULT, "staging");
    assignEnvironmentValue(plan, VAULT, "staging", ITEMS[0].id, "same-secret");
    notifyEnvironmentValueReuse(plan, VAULT, ITEMS);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]?.id).toBe(ENVIRONMENT_REUSE_NOTICE_ID);
    expect(listNotices()[0]?.body).toBe("API_TOKEN");

    assignEnvironmentValue(plan, VAULT, "staging", ITEMS[0].id, "different");
    notifyEnvironmentValueReuse(plan, VAULT, ITEMS);
    expect(listNotices()).toHaveLength(0);
  });

  it("notifies only for a required item with an empty value", () => {
    const empty = freshRequired("");
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]?.id).toBe("vault.environments.missing");
    expect(listNotices()[0]?.body).toBe("API_TOKEN");

    const filled = freshRequired("present");
    expect(listNotices()).toHaveLength(0);
    expect(filled).toEqual([]);

    const unmarked = freshUnmarked();
    expect(listNotices()).toHaveLength(0);
    expect(unmarked).toEqual([]);

    proof(
      "environments-notifications.log",
      [
        `requiredEmpty=${JSON.stringify(empty)}`,
        `requiredFilled=${JSON.stringify(filled)}`,
        `unmarked=${JSON.stringify(unmarked)}`,
      ].join("\n"),
    );
  });
});

function noticeRecords() {
  return listNotices().map((notice) => ({
    id: notice.id,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
  }));
}

function freshRequired(value: string) {
  resetVaultEnvironments();
  clearNotices();
  const plan = approvedPlan();
  enableVaultEnvironments(plan, VAULT);
  switchEnvironment(plan, VAULT, "production");
  markEnvironmentRequired(plan, VAULT, "production", ITEMS[0].id, true);
  if (value.length > 0) {
    assignEnvironmentValue(plan, VAULT, "production", ITEMS[0].id, value);
  }
  notifyMissingEnvironmentValues(plan, VAULT, ITEMS);
  return noticeRecords();
}

function freshUnmarked() {
  resetVaultEnvironments();
  clearNotices();
  const plan = approvedPlan();
  enableVaultEnvironments(plan, VAULT);
  switchEnvironment(plan, VAULT, "production");
  notifyMissingEnvironmentValues(plan, VAULT, ITEMS);
  return noticeRecords();
}
