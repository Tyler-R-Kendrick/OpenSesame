import {
  DEFAULT_RULES,
  type LegacyLoginItem,
  type LoginMethod,
  completePassword,
  createItem,
  migrateLegacyLogin,
  producePassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_WORKFLOW_TOOLS } from "../../webmcp/password-workflow-tools.js";
import { shareReachSeams } from "../local-share-reach.js";
import { stampedEdit } from "./body-edits.js";
import { writeItem } from "./item-path.js";
import { accountMethodField } from "./password-workflow-account.js";
import {
  comparePrivatePassword,
  localInventory,
  localReference,
  passwordWorkflowAudit,
  resolveLocalReference,
} from "./password-workflows.js";
import {
  openWorkflowVault,
  readBody,
  sealedBody,
  testAccount,
} from "./password-workflows.test-support.js";
import { vaultStore } from "./store.js";
beforeEach(() => {
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
function methods(): LoginMethod[] {
  return [
    ...testAccount("Account", "ACCOUNT_PASSWORD_PRIVATE").methods.map(
      (method) => ({ ...method, id: "plain:one" }),
    ),
    ...testAccount("Second", "SECOND_PASSWORD_PRIVATE").methods.map(
      (method) => ({ ...method, id: "plain:two" }),
    ),
    {
      id: "api",
      type: "api-key",
      key: "ACCOUNT_KEY_PRIVATE",
      header: "X-API-Key",
    },
    {
      id: "token",
      type: "token",
      token: "ACCOUNT_TOKEN_PRIVATE",
      expiresAt: "",
    },
    {
      id: "oauth",
      type: "oauth",
      clientId: "client",
      clientSecret: "ACCOUNT_OAUTH_PRIVATE",
      tokenUrl:
        "https://user:USER_PRIVATE@example.test/oauth/TOKEN_PATH_PRIVATE?token=QUERY_PRIVATE",
      scopes: "read",
      refreshToken: "ACCOUNT_REFRESH_PRIVATE",
    },
    {
      id: "authenticator",
      type: "authenticator",
      secret: "ACCOUNT_SEED_PRIVATE",
    },
    {
      id: "peppered",
      type: "password",
      generator: { id: "manual" },
      pepper: true,
      secret: "NEVER_REVEAL_PEPPER_PRIVATE",
      changedAt: "",
    },
    {
      id: "sphinx",
      type: "password",
      generator: {
        id: "sphinx",
        rules: DEFAULT_RULES,
        realm: "example.test",
        counter: 1,
        oprfKeyB64: "NEVER_REVEAL_OPRF_PRIVATE",
      },
      pepper: true,
      secret: "",
      changedAt: "",
    },
  ];
}
describe("account password workflow custody", () => {
  it("exposes every available method by exact reference while preserving all other methods on update", async () => {
    const item = testAccount("Account");
    item.methods = methods();
    item.updatedAt = "2000-01-01T00:00:00.000Z";
    const state = openWorkflowVault([item]);
    const tool = PASSWORD_WORKFLOW_TOOLS.find(
      (entry) => entry.name === "opensesame_vault_inventory",
    );
    if (!tool) throw new Error("Inventory tool is missing");
    expect(JSON.stringify(await tool.execute({}))).not.toMatch(/PRIVATE/);
    const inventory = localInventory("personal", [item]);
    expect(inventory[0]?.kind).toBe("account");
    expect(inventory[0]?.urls).toEqual(["https://example.test"]);
    const refs =
      inventory[0]?.fields.flatMap((field) => (field.ref ? [field.ref] : [])) ??
      [];
    expect(refs).toHaveLength(7);
    for (const [id, field, value] of [
      ["plain:one", "secret", "ACCOUNT_PASSWORD_PRIVATE"],
      ["api", "key", "ACCOUNT_KEY_PRIVATE"],
      ["token", "token", "ACCOUNT_TOKEN_PRIVATE"],
      ["oauth", "clientSecret", "ACCOUNT_OAUTH_PRIVATE"],
      ["oauth", "refreshToken", "ACCOUNT_REFRESH_PRIVATE"],
    ]) {
      const ref = localReference(
        "personal",
        item.id,
        accountMethodField(id ?? "", field ?? ""),
      );
      expect(refs).toContain(ref);
      expect(await resolveLocalReference(ref)).toBe(value);
    }
    await expect(comparePrivatePassword(item.id, "new", true)).rejects.toThrow(
      "exactly one",
    );
    const retained = structuredClone(item.methods.slice(1));
    expect(
      await comparePrivatePassword(item.id, "new", true, "plain:one"),
    ).toMatchObject({ verified: true, applied: true });
    const saved = state.items.find((entry) => entry.id === item.id);
    if (saved?.kind !== "account") throw new Error("Account was not saved");
    expect(saved.methods.slice(1)).toEqual(retained);
    expect(saved.methods[0]).toMatchObject({
      type: "password",
      secret: "new",
      generator: { id: "manual" },
    });
  });
  it("fails closed for pepper and Sphinx inputs and never downgrades protected methods", async () => {
    for (const method of methods().filter(
      (entry) => entry.id === "peppered" || entry.id === "sphinx",
    )) {
      const item = testAccount("Protected");
      item.methods = [method];
      const state = openWorkflowVault([item]);
      expect(
        localInventory("personal", [item])[0]?.fields.every(
          (field) => field.ref === undefined,
        ),
      ).toBe(true);
      for (const field of ["password", accountMethodField(method.id, "secret")])
        await expect(
          resolveLocalReference(localReference("personal", item.id, field)),
        ).rejects.toThrow("human pepper or Sphinx");
      for (const apply of [false, true])
        await expect(
          comparePrivatePassword(item.id, "candidate", apply, method.id),
        ).rejects.toThrow("human pepper or Sphinx");
      expect(state.items[0]).toEqual(item);
      expect(vaultStore.saveItem).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
        "operator",
      );
      vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
    }
  });
  it("fails closed for duplicate method IDs and reserved custom field collisions", async () => {
    const item = testAccount("Ambiguous", "SECRET_PRIVATE");
    const method = item.methods[0];
    if (!method) throw new Error("Missing method fixture");
    item.methods.push({ ...method });
    openWorkflowVault([item]);
    expect(
      localInventory("personal", [item])[0]?.fields.every(
        (field) => field.ref === undefined,
      ),
    ).toBe(true);
    await expect(
      comparePrivatePassword(item.id, "candidate", true, method.id),
    ).rejects.toThrow("exactly one");
    await expect(
      resolveLocalReference(
        localReference(
          "personal",
          item.id,
          accountMethodField(method.id, "secret"),
        ),
      ),
    ).rejects.toThrow("ambiguous");
    item.methods = [method];
    item.fields = [
      {
        id: accountMethodField(method.id, "secret"),
        name: "Imported",
        hidden: true,
        value: "OTHER_PRIVATE",
      },
    ];
    expect(
      localInventory("personal", [item])[0]?.fields.every(
        (field) => field.ref === undefined,
      ),
    ).toBe(true);
    await expect(
      resolveLocalReference(
        localReference(
          "personal",
          item.id,
          accountMethodField(method.id, "secret"),
        ),
      ),
    ).rejects.toThrow("ambiguous");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });

  it("reads a normalized legacy login and keeps its authenticator on password update", async () => {
    const base = createItem("account", "Legacy");
    const legacy: LegacyLoginItem = {
      ...base,
      kind: "login",
      password: "LEGACY_PRIVATE",
      totp: "LEGACY_SEED_PRIVATE",
      passwordChangedAt: base.updatedAt,
    };
    const item = migrateLegacyLogin(legacy);
    const state = openWorkflowVault([item]);
    expect(
      await resolveLocalReference(
        localReference("personal", item.id, "password"),
      ),
    ).toBe("LEGACY_PRIVATE");
    const retained = structuredClone(item.methods[1]);
    expect(await comparePrivatePassword(item.id, "new", true)).toMatchObject({
      verified: true,
    });
    const saved = state.items[0];
    if (saved?.kind !== "account") throw new Error("Account missing");
    expect(saved.methods[1]).toEqual(retained);
  });
  it("verifies whole account content after persisted property order changes", async () => {
    const account = testAccount("Canonical account", "OLD_PRIVATE");
    const state = openWorkflowVault([account]);
    vi.mocked(vaultStore.saveItem).mockImplementationOnce(async (item) => {
      if (item.kind !== "account") throw new Error("Expected account");
      const body = sealedBody(state.items);
      stampedEdit((draft) => writeItem(draft, item))(body);
      const persisted = readBody(body)[0];
      if (persisted?.kind !== "account")
        throw new Error("Expected persisted account");
      const { methods: persistedMethods, ...persistedProperties } = persisted;
      state.items = [{ methods: persistedMethods, ...persistedProperties }];
    });
    await expect(
      comparePrivatePassword(account.id, "NEW_PRIVATE", true),
    ).resolves.toMatchObject({ applied: true, verified: true });
    expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
  });
  it("resolves and compares a derived password without ever returning its stored root", async () => {
    const account = testAccount("Derived account");
    const method = account.methods[0];
    if (method?.type !== "password")
      throw new Error("Expected password fixture");
    method.secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    method.generator = { id: "derived", rules: DEFAULT_RULES, counter: 3 };
    const produced = completePassword(producePassword(method));
    if (produced === null) throw new Error("Expected derived password");
    expect(produced).not.toBe(method.secret);
    openWorkflowVault([account]);
    const ref = localReference(
      "personal",
      account.id,
      accountMethodField(method.id, "secret"),
    );
    expect(localInventory("personal", [account])[0]?.fields[0]?.ref).toBe(ref);
    expect(await resolveLocalReference(ref)).toBe(produced);
    expect(
      await resolveLocalReference(
        localReference("personal", account.id, "password"),
      ),
    ).toBe(produced);
    expect(await comparePrivatePassword(account.id, produced)).toMatchObject({
      matches: true,
    });
    expect(
      await comparePrivatePassword(account.id, method.secret),
    ).toMatchObject({ matches: false });
    method.pepper = true;
    expect(
      localInventory("personal", [account])[0]?.fields[0]?.ref,
    ).toBeUndefined();
    await expect(resolveLocalReference(ref)).rejects.toThrow("human pepper");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });
  it("rejects corrupted unrelated method readback without retry or secret leakage", async () => {
    const item = testAccount("Account", "old");
    item.methods.push({
      id: "api",
      type: "api-key",
      key: "RETAIN_PRIVATE",
      header: "X-API-Key",
    });
    const state = openWorkflowVault([item]);
    const save = vi
      .spyOn(vaultStore, "saveItem")
      .mockImplementationOnce(async (written) => {
        if (written.kind !== "account") throw new Error("Unexpected item");
        state.items = [
          {
            ...written,
            methods: written.methods.map((method) =>
              method.type === "api-key"
                ? { ...method, key: "CORRUPTED_PRIVATE" }
                : method,
            ),
          },
        ];
      });
    const error = await comparePrivatePassword(item.id, "new", true).catch(
      (cause: Error) => cause,
    );
    expect(String(error)).toContain("unverified");
    expect(String(error)).not.toMatch(/PRIVATE/);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("audits old password accounts and transient OAuth endpoints using origin-only metadata", async () => {
    const account = testAccount("Old", "old");
    account.updatedAt = "2000-01-01T00:00:00.000Z";
    account.methods.push(
      ...methods().filter((method) => method.type === "oauth"),
    );
    const api = createItem("account", "API only");
    api.updatedAt = account.updatedAt;
    api.methods = [
      { id: "api", type: "api-key", key: "ONLY_PRIVATE", header: "" },
    ];
    openWorkflowVault([account, api]);
    const report = await passwordWorkflowAudit();
    expect(report.oldLogins.map((item) => item.id)).toEqual([account.id]);
    expect(
      report.untaggedMachineCredentials.map((item) => item.id).sort(),
    ).toEqual([account.id, api.id].sort());
    expect(report.urlsToReview).toEqual([
      {
        id: account.id,
        title: account.name,
        urls: ["https://example.test"],
        reason: "transient-url",
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE/);
  });
});
