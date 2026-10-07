import {
  createItem,
  createTypedItem,
  itemTypeRegistry,
  manualPassword,
} from "@opensesame/vault-core";
import { dropPack, loadPack } from "@opensesame/vault-item-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_WORKFLOW_TOOLS } from "../../webmcp/password-workflow-tools.js";
import { webmcpNavigationSeam } from "../../webmcp/seams.js";
import { shareReachSeams } from "../local-share-reach.js";
import {
  comparePrivatePassword,
  localInventory,
  passwordWorkflowAudit,
  passwordWorkflowFind,
  passwordWorkflowInventory,
  resolveLocalEnvTemplate,
  resolveLocalReference,
} from "./password-workflows.js";
import { vaultStore } from "./store.js";

import {
  openWorkflowVault as open,
  testAccount,
} from "./password-workflows.test-support.js";
beforeEach(() => {
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
});
afterEach(() => {
  dropPack("api-credential");
  vi.restoreAllMocks();
});
describe("local password workflow adapter", () => {
  it("rejects whitespace-only private passwords without saving", async () => {
    const login = testAccount("Example");
    open([login]);
    for (const candidate of ["", " ", "\t\r\n"])
      await expect(
        comparePrivatePassword(login.id, candidate, true),
      ).rejects.toThrow("Enter a private password");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });
  it("opens sensitive WebMCP workflows by metadata-only human handoff and rejects private inputs", async () => {
    const state = open([]);
    const navigate = vi
      .spyOn(webmcpNavigationSeam, "navigate")
      .mockImplementation(() => {});
    const tool = PASSWORD_WORKFLOW_TOOLS.find(
      (entry) => entry.name === "opensesame_open_password_workflow",
    );
    if (!tool) throw new Error("The human workflow handoff is missing");
    expect(await tool.execute({ action: "create" })).toEqual({
      status: "ceremony_opened",
      location: "/vault/new/secret",
    });
    for (const action of ["compare", "update", "read", "env-resolve"]) {
      expect(await tool.execute({ action, item: "itm_1" })).toEqual({
        status: "ceremony_opened",
        location: "/vault/itm_1",
      });
    }
    expect(await tool.execute({ action: "read" })).toEqual({
      status: "ceremony_opened",
      location: "/vault",
    });
    expect(navigate.mock.calls).toEqual([
      ["/vault/new/secret"],
      ["/vault/itm_1"],
      ["/vault/itm_1"],
      ["/vault/itm_1"],
      ["/vault/itm_1"],
      ["/vault"],
    ]);
    expect(() =>
      tool.execute({
        action: "create",
        credential: "PRIVATE_HANDOFF_SENTINEL",
      }),
    ).toThrow("action and an item id only");
    expect(() => tool.execute({ action: "unknown" })).toThrow("Unknown");
    expect(navigate).toHaveBeenCalledTimes(6);
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...state,
      status: "locked",
    });
    expect(() => tool.execute({ action: "read" })).toThrow("vault_locked");
    expect(navigate).toHaveBeenCalledTimes(6);
  });
  it("inventory ordering and typed concealed references retain metadata without values through WebMCP", async () => {
    await loadPack("api-credential");
    const definition = itemTypeRegistry().get("api-credential");
    if (!definition)
      throw new Error("The API credential definition is missing");
    const typed = createTypedItem(
      definition,
      {
        service: "Example",
        apiKey: "TYPED_PRIVATE_SENTINEL",
        clientSecret: "SECOND_PRIVATE_SENTINEL",
      },
      "A typed key",
    );
    const login = testAccount("Z login");
    open([login, typed]);
    const metadata = await passwordWorkflowInventory();
    expect(metadata.map((entry) => entry.title)).toEqual([
      "A typed key",
      "Z login",
    ]);
    expect(metadata[0]?.kind).toBe("api-credential");
    expect(metadata[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "API key",
          type: "concealed",
          ref: `os://personal/${typed.id}/apiKey`,
        }),
        expect.objectContaining({
          label: "Client secret",
          type: "concealed",
          ref: `os://personal/${typed.id}/clientSecret`,
        }),
      ]),
    );
    const tool = PASSWORD_WORKFLOW_TOOLS.find(
      (entry) => entry.name === "opensesame_vault_find_references",
    );
    const result = await tool?.execute({ queries: ["typed"] });
    expect(JSON.stringify(result)).toContain("/apiKey");
    expect(JSON.stringify(result) + JSON.stringify(metadata)).not.toMatch(
      /TYPED_PRIVATE_SENTINEL|SECOND_PRIVATE_SENTINEL/,
    );
    const typo = await tool?.execute({ queries: ["typd"] });
    expect(typo).toEqual(
      expect.objectContaining({
        matches: [],
        suggestions: expect.arrayContaining([
          expect.objectContaining({
            query: "typd",
            ref: `os://personal/${typed.id}/apiKey`,
          }),
        ]),
      }),
    );
  });
  it("audits exact duplicate machine old-login and transient-url findings through WebMCP", async () => {
    await loadPack("api-credential");
    const secret = createItem("secret", "SAME");
    secret.value = "AUDIT_PRIVATE_SENTINEL";
    const login = testAccount("same");
    login.updatedAt = "2000-01-01T00:00:00.000Z";
    login.uris = [
      {
        id: "url",
        uri: "https://user:URL_PRIVATE@example.test/reset/PATH_PRIVATE?token=QUERY_PRIVATE#HASH_PRIVATE",
        match: "domain",
      },
    ];
    const definition = itemTypeRegistry().get("api-credential");
    if (!definition)
      throw new Error("The API credential definition is missing");
    const typed = createTypedItem(
      definition,
      { service: "Example", apiKey: "TYPED_PRIVATE" },
      "Typed API",
    );
    open([typed, login, secret]);
    const tool = PASSWORD_WORKFLOW_TOOLS.find(
      (entry) => entry.name === "opensesame_vault_audit_organization",
    );
    const report = await tool?.execute({});
    expect(report).toEqual(
      expect.objectContaining({
        summary: { items: 3, tagged: 0, untagged: 3 },
        duplicateTitles: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ id: secret.id }),
              expect.objectContaining({ id: login.id }),
            ]),
          }),
        ],
        untaggedMachineCredentials: expect.arrayContaining([
          expect.objectContaining({ id: secret.id }),
          expect.objectContaining({ id: typed.id }),
        ]),
        oldLogins: [expect.objectContaining({ id: login.id })],
        urlsToReview: [
          {
            id: login.id,
            title: login.name,
            urls: ["https://example.test"],
            reason: "transient-url",
          },
        ],
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(
      /AUDIT_PRIVATE_SENTINEL|TYPED_PRIVATE|URL_PRIVATE|PATH_PRIVATE|QUERY_PRIVATE|HASH_PRIVATE/,
    );
  });
  it("preserves custom concealed fields while refusing passkey password updates", async () => {
    const login = testAccount("Example");
    login.methods[0] = {
      ...login.methods[0],
      ...manualPassword(`${login.id}:password`, "old", login.updatedAt),
    };
    login.fields = [
      {
        id: "imported",
        name: "Imported",
        hidden: true,
        value: "PRESERVE_PRIVATE",
      },
    ];
    const passkey = createItem("passkey", "Passkey");
    const state = open([login, passkey]);
    await expect(
      comparePrivatePassword(passkey.id, "new", true),
    ).rejects.toThrow("account");
    expect(await comparePrivatePassword(login.id, "new", true)).toEqual(
      expect.objectContaining({ verified: true }),
    );
    expect(state.items.find((entry) => entry.id === login.id)?.fields).toEqual(
      login.fields,
    );
    const save = vi
      .spyOn(vaultStore, "saveItem")
      .mockRejectedValue(new Error("PASSWORD_PRIVATE_SENTINEL"));
    save.mockClear();
    const error = await comparePrivatePassword(
      login.id,
      "PASSWORD_PRIVATE_SENTINEL",
      true,
    ).catch((value: Error) => value);
    expect(String(error)).toContain("unverified");
    expect(String(error)).not.toContain("PASSWORD_PRIVATE_SENTINEL");
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("discovers multiple queries and audits only metadata, including safe WebMCP handlers", async () => {
    const one = createItem("secret", "OpenAI API Key");
    one.value = "PRIVATE_VALUE_SENTINEL";
    const two = testAccount("Stripe");
    two.methods[0] = manualPassword(
      `${two.id}:password`,
      "PASSWORD_SENTINEL",
      two.updatedAt,
    );
    open([one, two]);
    const found = await passwordWorkflowFind(["openai", "stripe"]);
    expect(found.matches).toHaveLength(2);
    expect(found.matches.map((match) => match.ref)).toContain(
      `os://personal/${one.id}/value`,
    );
    const inventory = await passwordWorkflowInventory();
    expect(JSON.stringify(inventory)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|PASSWORD_SENTINEL/,
    );
    expect((await passwordWorkflowAudit()).summary.items).toBe(2);
    for (const name of [
      "opensesame_vault_find_references",
      "opensesame_vault_inventory",
      "opensesame_vault_audit_organization",
    ]) {
      const tool = PASSWORD_WORKFLOW_TOOLS.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      const result = await tool?.execute({ queries: ["openai", "stripe"] });
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_VALUE_SENTINEL|PASSWORD_SENTINEL/,
      );
    }
  });
  it("compares or applies a login password", async () => {
    const login = testAccount("Example");
    login.methods[0] = {
      ...login.methods[0],
      ...manualPassword(`${login.id}:password`, "old", login.updatedAt),
    };
    const state = open([login]);
    expect(await comparePrivatePassword(login.id, "new")).toMatchObject({
      matches: false,
      applied: false,
    });
    expect(state.items[0]).toMatchObject({
      methods: [expect.objectContaining({ secret: "old" })],
    });
    expect(await comparePrivatePassword(login.id, "new", true)).toMatchObject({
      verified: true,
      applied: true,
    });
    expect(state.items.find((item) => item.id === login.id)).toMatchObject({
      methods: [expect.objectContaining({ secret: "new" })],
    });
  });
  it("fails closed while locked or outside shared item reach", async () => {
    const secret = createItem("secret", "Restricted");
    secret.value = "restricted";
    const state = open([secret]);
    state.status = "locked";
    await expect(passwordWorkflowInventory()).rejects.toThrow("Unlock");
    state.status = "unlocked";
    vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(false);
    vi.spyOn(shareReachSeams, "currentSession").mockReturnValue(null);
    expect(await passwordWorkflowInventory()).toEqual([]);
    await expect(comparePrivatePassword(secret.id, "x", true)).rejects.toThrow(
      "share_grant_denied",
    );
  });
  it("projects no typed or custom concealed field values and renders reference templates", async () => {
    const item = createItem("secret", "Key");
    item.value = "DO_NOT_PRINT";
    item.fields = [
      { id: "field", name: "hidden", hidden: true, value: "CUSTOM_SECRET" },
    ];
    expect(JSON.stringify(localInventory("personal", [item]))).not.toMatch(
      /DO_NOT_PRINT|CUSTOM_SECRET/,
    );
    open([item]);
    const tool = PASSWORD_WORKFLOW_TOOLS.find(
      (entry) => entry.name === "opensesame_vault_env_template",
    );
    expect(
      await tool?.execute({
        assignments:
          "KEY=os://personal/item/value\nREMOTE=op://Personal/Item/credential",
      }),
    ).toEqual({
      template:
        "KEY=os://personal/item/value\nREMOTE=op://Personal/Item/credential\n",
    });
    expect(() => tool?.execute({ assignments: "KEY=plaintext" })).toThrow();
  });
  it("sanitizes URLs, resolves local references only and preserves secret newlines", async () => {
    const secret = createItem("secret", "Existing");
    secret.value = "first\nlast";
    const login = testAccount("Example");
    login.uris = [
      {
        id: "uri",
        uri: "https://user:URL_SECRET@example.com/reset/PATH_SECRET?token=QUERY_SECRET#HASH_SECRET",
        match: "domain",
      },
    ];
    open([secret, login]);
    const items = await passwordWorkflowInventory();
    expect(items.find((item) => item.id === login.id)?.urls).toEqual([
      "https://example.com",
    ]);
    expect(JSON.stringify(items)).not.toMatch(
      /URL_SECRET|PATH_SECRET|QUERY_SECRET|HASH_SECRET/,
    );
    const ref = `os://personal/${secret.id}/value`;
    expect(await resolveLocalReference(ref)).toBe("first\nlast");
    expect(await resolveLocalEnvTemplate(`KEY=${ref}`)).toEqual({
      content: 'KEY="first\\nlast"',
      count: 1,
    });
    await expect(
      resolveLocalReference(`os://other/${secret.id}/value`),
    ).rejects.toThrow("different vault");
    await expect(
      resolveLocalReference("op://Personal/Item/value"),
    ).rejects.toThrow("native CLI");
    const typo = await passwordWorkflowFind(["existng"]);
    expect(typo.suggestions?.[0]?.ref).toBe(ref);
  });
  it("suppresses uncertain private write errors without retrying", async () => {
    const login = testAccount("Example");
    login.methods[0] = {
      ...login.methods[0],
      ...manualPassword(`${login.id}:password`, "old", login.updatedAt),
    };
    open([login]);
    const save = vi
      .spyOn(vaultStore, "saveItem")
      .mockRejectedValue(new Error("PRIVATE_WRITE_SENTINEL"));
    await expect(
      comparePrivatePassword(login.id, "PRIVATE_WRITE_SENTINEL", true),
    ).rejects.toThrow("unverified");
    expect(save).toHaveBeenCalledTimes(1);
    try {
      await comparePrivatePassword(login.id, "PRIVATE_WRITE_SENTINEL", true);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_WRITE_SENTINEL");
    }
  });
});
