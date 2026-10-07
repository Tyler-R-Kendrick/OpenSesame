import { afterEach, beforeEach, expect, it } from "vitest";
import { clearNotices, listNotices } from "../notices.js";
import {
  ENVIRONMENTS_CAPABILITY,
  ENVIRONMENT_NOTICE_ID,
  activeEnvironment,
  assignEnvironmentValue,
  enableVaultEnvironments,
  environmentKey,
  environmentRequires,
  environmentSnapshot,
  markEnvironmentRequired,
  notifyMissingEnvironmentValues,
  readEnvironmentValue,
  renderEnvSchema,
  resetVaultEnvironments,
  subscribeVaultEnvironments,
  switchEnvironment,
  vaultEnvironmentsEnabled,
} from "./environments.js";

const PLAN = { approvedCapabilities: [ENVIRONMENTS_CAPABILITY] };
const OFF = { approvedCapabilities: [] };
const ITEMS = [
  { id: "database", key: "DATABASE_URL" },
  { id: "cache", key: "CACHE_URL" },
];
beforeEach(() => {
  resetVaultEnvironments();
  clearNotices();
});
afterEach(() => {
  resetVaultEnvironments();
  clearNotices();
});

it("refuses absent capability and unenabled vaults without installing state", () => {
  let changes = 0;
  const stop = subscribeVaultEnvironments(() => changes++);
  const before = environmentSnapshot("owner");
  expect(enableVaultEnvironments(null, "owner", ITEMS)).toBe(false);
  expect(enableVaultEnvironments(OFF, "owner")).toBe(false);
  expect(switchEnvironment(PLAN, "owner", "production")).toMatchObject({
    ok: false,
    reason: "disabled",
  });
  expect(
    assignEnvironmentValue(PLAN, "owner", "production", "database", "secret")
      .ok,
  ).toBe(false);
  expect(
    markEnvironmentRequired(PLAN, "owner", "production", "database", true).ok,
  ).toBe(false);
  expect(activeEnvironment(PLAN, "owner")).toBeNull();
  expect(
    readEnvironmentValue(PLAN, "owner", "production", "database"),
  ).toBeNull();
  expect(environmentRequires(PLAN, "owner", "production", "database")).toBe(
    false,
  );
  expect(renderEnvSchema(PLAN, "owner", ITEMS)).toBeNull();
  expect(environmentSnapshot("owner")).toBe(before);
  expect(changes).toBe(0);
  stop();
});

it("keeps values and required flags isolated by vault and named environment", () => {
  expect(enableVaultEnvironments(PLAN, "owner", ITEMS)).toBe(true);
  expect(enableVaultEnvironments(PLAN, "other")).toBe(true);
  expect(vaultEnvironmentsEnabled(PLAN, "owner")).toBe(true);
  expect(switchEnvironment(PLAN, "owner", " production ").ok).toBe(true);
  expect(switchEnvironment(PLAN, "owner", "development").ok).toBe(true);
  expect(
    assignEnvironmentValue(
      PLAN,
      "owner",
      "production",
      "database",
      "postgres://production",
    ).ok,
  ).toBe(true);
  expect(
    assignEnvironmentValue(
      PLAN,
      "owner",
      "development",
      "database",
      "postgres://development",
    ).ok,
  ).toBe(true);
  expect(
    markEnvironmentRequired(PLAN, "owner", "production", "database", true).ok,
  ).toBe(true);
  expect(readEnvironmentValue(PLAN, "owner", "production", "database")).toBe(
    "postgres://production",
  );
  expect(readEnvironmentValue(PLAN, "owner", "development", "database")).toBe(
    "postgres://development",
  );
  expect(readEnvironmentValue(PLAN, "other", "production", "database")).toBe(
    "",
  );
  expect(environmentRequires(PLAN, "owner", "development", "database")).toBe(
    false,
  );
  expect(environmentRequires(PLAN, "other", "production", "database")).toBe(
    false,
  );
  const before = environmentSnapshot("owner");
  expect(
    assignEnvironmentValue(PLAN, "owner", "unknown", "database", "bad").ok,
  ).toBe(false);
  expect(switchEnvironment(PLAN, "owner", "   ").ok).toBe(false);
  expect(environmentSnapshot("owner")).toBe(before);
  expect(switchEnvironment(PLAN, "owner", "production").ok).toBe(true);
  expect(environmentSnapshot("owner").names).toEqual([
    "production",
    "development",
  ]);
  expect(activeEnvironment(PLAN, "owner")).toBe("production");
  expect(vaultEnvironmentsEnabled(OFF, "owner")).toBe(false);
  expect(
    readEnvironmentValue(OFF, "owner", "production", "database"),
  ).toBeNull();
  expect(switchEnvironment(OFF, "owner", "development").ok).toBe(false);
  expect(activeEnvironment(PLAN, "owner")).toBe("production");
});

it("regenerates active schema and clears missing-value notices after resolution or lost capability", () => {
  enableVaultEnvironments(PLAN, "owner", ITEMS);
  notifyMissingEnvironmentValues(PLAN, "owner", ITEMS);
  expect(listNotices()).toEqual([]);
  switchEnvironment(PLAN, "owner", "production");
  markEnvironmentRequired(PLAN, "owner", "production", "database", true);
  expect(renderEnvSchema(PLAN, "owner", ITEMS)).toBe(
    "# @type=string\n# @required\nDATABASE_URL=\n\n# @type=string\nCACHE_URL=",
  );
  const same = environmentSnapshot("owner");
  renderEnvSchema(PLAN, "owner", ITEMS);
  enableVaultEnvironments(PLAN, "owner");
  expect(environmentSnapshot("owner")).toBe(same);
  notifyMissingEnvironmentValues(PLAN, "owner", ITEMS);
  expect(listNotices()).toMatchObject([
    { id: ENVIRONMENT_NOTICE_ID, body: "DATABASE_URL" },
  ]);
  assignEnvironmentValue(
    PLAN,
    "owner",
    "production",
    "database",
    "postgres://owner",
  );
  notifyMissingEnvironmentValues(PLAN, "owner", ITEMS);
  expect(listNotices()).toEqual([]);
  assignEnvironmentValue(PLAN, "owner", "production", "database", "");
  notifyMissingEnvironmentValues(PLAN, "owner", ITEMS);
  expect(listNotices()).toHaveLength(1);
  notifyMissingEnvironmentValues(OFF, "owner", ITEMS);
  expect(listNotices()).toEqual([]);
  markEnvironmentRequired(PLAN, "owner", "production", "database", false);
  expect(environmentRequires(PLAN, "owner", "production", "database")).toBe(
    false,
  );
  expect(renderEnvSchema(PLAN, "owner", ITEMS)).not.toContain("@required");
});

it("releases subscriptions and clears all vault environments on reset", () => {
  let changes = 0;
  const stop = subscribeVaultEnvironments(() => changes++);
  enableVaultEnvironments(PLAN, "owner");
  expect(changes).toBe(1);
  stop();
  resetVaultEnvironments();
  expect(changes).toBe(1);
  expect(vaultEnvironmentsEnabled(PLAN, "owner")).toBe(false);
  expect(environmentSnapshot("owner").names).toEqual([]);
  expect(environmentKey("  9-pay / token  ")).toBe("_9_PAY_TOKEN");
  expect(environmentKey("database URL")).toBe("DATABASE_URL");
  expect(environmentKey("  ---  ")).toBe("");
});
