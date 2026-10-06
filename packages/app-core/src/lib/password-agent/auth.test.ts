import { describe, expect, it, vi } from "vitest";
import {
  type CredentialStore,
  type ServiceSettings,
  authenticatedPort,
} from "./auth.js";
import { connect, forget, recover, setup, status } from "./service-account.js";
import type { InvokeOptions, PasswordAgentPort } from "./transport.js";
const vaultId = "a".repeat(26);
const backupId = "b".repeat(26);
const itemId = "c".repeat(26);
function memoryStore(): CredentialStore {
  let token: string | undefined;
  let settings: ServiceSettings | undefined;
  return {
    storage: "test",
    hasToken: async () => token !== undefined,
    loadToken: async () => {
      if (token === undefined) throw new Error("missing");
      return token;
    },
    saveToken: async (value) => {
      token = value;
    },
    removeToken: async () => {
      token = undefined;
    },
    loadSettings: async () => settings,
    saveSettings: async (value) => {
      settings = value;
    },
    removeSettings: async () => {
      settings = undefined;
    },
  };
}
function portWithVaults(): PasswordAgentPort {
  return {
    invoke: vi.fn(async () =>
      JSON.stringify([{ id: vaultId, name: "Automation" }]),
    ),
  };
}
describe("authentication and service-account parity", () => {
  it("auth.priority", async () => {
    const store = memoryStore();
    await store.saveToken("ops_saved");
    await store.saveSettings({ name: "saved", vaults: [] });
    const raw = portWithVaults();
    await authenticatedPort(raw, store, "ops_supplied").invoke(
      ["vault", "list"],
      {},
    );
    expect(raw.invoke).toHaveBeenLastCalledWith(
      ["vault", "list"],
      expect.objectContaining({
        env: expect.objectContaining({
          OP_SERVICE_ACCOUNT_TOKEN: "ops_supplied",
          OP_ACCOUNT: undefined,
        }),
      }),
    );
    await authenticatedPort(raw, store, "ops_supplied", true).invoke([], {});
    expect(raw.invoke).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        env: expect.objectContaining({ OP_SERVICE_ACCOUNT_TOKEN: undefined }),
      }),
    );
    await authenticatedPort(raw, store).invoke([], {});
    expect(raw.invoke).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        env: expect.objectContaining({ OP_SERVICE_ACCOUNT_TOKEN: "ops_saved" }),
      }),
    );
  });
  it("auth.fail-closed", async () => {
    const store = memoryStore();
    await store.saveSettings({ name: "broken", vaults: [] });
    const raw = portWithVaults();
    await expect(
      authenticatedPort(raw, store).invoke([], {}),
    ).rejects.toThrow();
    expect(raw.invoke).not.toHaveBeenCalled();
    await store.removeSettings();
    await store.saveToken("invalid");
    await expect(
      authenticatedPort(raw, store).invoke([], {}),
    ).rejects.toThrow();
    expect(raw.invoke).not.toHaveBeenCalled();
  });
  it("service.connect", async () => {
    const store = memoryStore();
    const port = portWithVaults();
    const receipt = await connect(port, store, "ops_private\r\n", "Work");
    expect(receipt.verified).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("ops_private");
    expect(await store.loadToken()).toBe("ops_private");
    await expect(connect(port, store, "ops_second")).rejects.toThrow(
      "saved account",
    );
  });
  it("service.status-recover-forget", async () => {
    const store = memoryStore();
    const port = portWithVaults();
    await store.saveToken("ops_orphan");
    expect(await status(port, store)).toMatchObject({
      configured: false,
      recoverable: true,
    });
    expect(await recover(port, store, "Recovered")).toMatchObject({
      configured: true,
      verified: true,
    });
    expect(await status(port, store)).toMatchObject({
      name: "Recovered",
      configured: true,
    });
    const before = vi.mocked(port.invoke).mock.calls.length;
    expect(await forget(store)).toEqual({
      forgotten: true,
      remoteRevoked: false,
    });
    expect(await store.hasToken()).toBe(false);
    expect(vi.mocked(port.invoke).mock.calls).toHaveLength(before);
  });
  it("service.setup", async () => {
    const store = memoryStore();
    const events: string[] = [];
    const save = store.saveToken;
    store.saveToken = async (token) => {
      events.push("saved");
      await save(token);
    };
    const item = {
      id: itemId,
      title: "1Password Work Service Account Token",
      category: "API_CREDENTIAL",
      vault: { id: backupId, name: "Personal" },
      fields: [
        {
          id: "credential",
          type: "CONCEALED",
          label: "credential",
          value: "ops_new",
        },
      ],
    };
    const port: PasswordAgentPort = {
      invoke: vi.fn(async (args, options: InvokeOptions) => {
        if (args[0] === "vault") {
          if (options.env?.OP_SERVICE_ACCOUNT_TOKEN)
            return JSON.stringify([{ id: vaultId, name: "Automation" }]);
          expect(options.desktop).toBe(true);
          return JSON.stringify([
            { id: vaultId, name: "Automation" },
            { id: backupId, name: "Personal" },
          ]);
        }
        if (args[0] === "service-account") {
          expect(args).toContain(`${vaultId}:read_items`);
          events.push("created");
          return "ops_new\n";
        }
        if (args[1] === "list") return "[]";
        events.push("backup");
        return JSON.stringify(item);
      }),
    };
    const result = await setup(port, store, {
      name: "Work",
      vault: "Automation",
      saveVault: "Personal",
      createVault: false,
      write: false,
    });
    expect(result).toMatchObject({
      configured: true,
      verified: true,
      write: false,
    });
    expect(events.indexOf("saved")).toBeLessThan(events.indexOf("backup"));
    expect(JSON.stringify(result)).not.toContain("ops_new");
  });
  it("service.setup-no-retry", async () => {
    const store = memoryStore();
    const raw = portWithVaults();
    await expect(
      setup(raw, store, {
        name: "Work",
        vault: "Personal",
        saveVault: "Backup",
        createVault: true,
        write: true,
      }),
    ).rejects.toThrow("dedicated");
    expect(raw.invoke).not.toHaveBeenCalled();
    const port: PasswordAgentPort = {
      invoke: vi.fn(async (args) => {
        if (args[0] === "vault")
          return JSON.stringify([
            { id: vaultId, name: "Automation" },
            { id: backupId, name: "Personal" },
          ]);
        if (args[0] === "service-account") throw new Error("ops_supersecret");
        return "[]";
      }),
    };
    await expect(
      setup(port, store, {
        name: "Work",
        vault: "Automation",
        saveVault: "Personal",
        createVault: false,
        write: false,
      }),
    ).rejects.toThrow("do not retry");
    expect(
      vi
        .mocked(port.invoke)
        .mock.calls.filter(([args]) => args[0] === "service-account"),
    ).toHaveLength(1);
  });
});
