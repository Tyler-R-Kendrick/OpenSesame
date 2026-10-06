import { describe, expect, it } from "vitest";
import {
  type CredentialStore,
  type ServiceSettings,
  authenticatedPort,
} from "../../packages/app-core/src/lib/password-agent/auth.js";
import { doctor } from "../../packages/app-core/src/lib/password-agent/doctor.js";
import {
  connect,
  forget,
  recover,
  setup,
  status,
} from "../../packages/app-core/src/lib/password-agent/service-account.js";
import type {
  InvokeOptions,
  PasswordAgentPort,
} from "../../packages/app-core/src/lib/password-agent/transport.js";

const token = "ops_FICTIONAL-PRIVATE-TOKEN";
const automation = { id: "a".repeat(26), name: "Automation" };
const backup = { id: "b".repeat(26), name: "Personal" };
function storage() {
  let value: string | undefined;
  let settings: ServiceSettings | undefined;
  const events: string[] = [];
  const store: CredentialStore = {
    storage: "test-protected-store",
    async hasToken() {
      return value !== undefined;
    },
    async loadToken() {
      if (!value) throw new Error(token);
      return value;
    },
    async saveToken(next) {
      value = next;
      events.push("save-token");
    },
    async removeToken() {
      value = undefined;
      events.push("remove-token");
    },
    async loadSettings() {
      return settings;
    },
    async saveSettings(next) {
      settings = next;
      events.push("save-settings");
    },
    async removeSettings() {
      settings = undefined;
      events.push("remove-settings");
    },
  };
  return { store, events };
}
function provider(failBackup = false) {
  const calls: { args: readonly string[]; options: InvokeOptions }[] = [];
  let stored = "{}";
  const port: PasswordAgentPort = {
    async invoke(args, options) {
      calls.push({ args, options });
      if (args[0] === "service-account") return token;
      if (args[0] === "vault")
        return JSON.stringify(
          options.desktop ? [automation, backup] : [automation],
        );
      if (args[1] === "list") return "[]";
      if (args[1] === "create") {
        if (failBackup) throw new Error(token);
        stored = JSON.stringify({
          ...JSON.parse(options.input ?? "{}"),
          id: "c".repeat(26),
          vault: backup,
        });
      }
      return stored;
    },
  };
  return { port, calls };
}
describe("2password parity core", () => {
  it("auth.precedence", async () => {
    const fake = provider();
    const local = storage();
    await local.store.saveToken(token);
    await local.store.saveSettings({ name: "saved", vaults: [automation] });
    await authenticatedPort(fake.port, local.store, "ops_ENV", true).invoke(
      ["test"],
      {},
    );
    expect(
      fake.calls.at(-1)?.options.env?.OP_SERVICE_ACCOUNT_TOKEN,
    ).toBeUndefined();
    await authenticatedPort(fake.port, local.store, "ops_ENV").invoke(
      ["test"],
      {},
    );
    expect(fake.calls.at(-1)?.options.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "ops_ENV",
    );
    await authenticatedPort(fake.port, local.store).invoke(["test"], {});
    expect(fake.calls.at(-1)?.options.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      token,
    );
    await authenticatedPort(fake.port, storage().store).invoke(["test"], {});
    expect(fake.calls.at(-1)?.options.env).toEqual({});
  });
  it("auth.fail-closed", async () => {
    const fake = provider();
    const local = storage();
    await local.store.saveSettings({ name: "saved", vaults: [automation] });
    const failure = await authenticatedPort(fake.port, local.store)
      .invoke(["test"], {})
      .catch((value: Error) => value);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(token);
    expect(fake.calls).toHaveLength(0);
    const broken = {
      ...local.store,
      async loadSettings(): Promise<ServiceSettings | undefined> {
        throw new Error("broken");
      },
    };
    await expect(
      authenticatedPort(fake.port, broken).invoke(["test"], {}),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    await authenticatedPort(fake.port, broken, undefined, true).invoke(
      ["test"],
      {},
    );
    expect(fake.calls).toHaveLength(1);
  });
  it("service-account.setup", async () => {
    const fake = provider();
    const local = storage();
    const result = await setup(fake.port, local.store, {
      name: "Agent",
      vault: "Automation",
      saveVault: "Personal",
      createVault: false,
      write: false,
      expiresIn: "90d",
    });
    const create = fake.calls.find(
      (call) => call.args[0] === "service-account",
    );
    expect(create?.args).toContain(`${automation.id}:read_items`);
    expect(create?.args).toContain("90d");
    expect(create?.options.desktop).toBe(true);
    expect(result).toEqual(
      expect.objectContaining({
        verified: true,
        configured: true,
        write: false,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(token);
    const before = provider();
    await expect(
      setup(before.port, storage().store, {
        name: "Agent",
        vault: "Personal",
        saveVault: "Personal",
        createVault: false,
        write: false,
      }),
    ).rejects.toThrow("dedicated");
    expect(before.calls).toHaveLength(0);
    for (const expiresIn of ["0d", "-1d", "forever"]) {
      await expect(
        setup(before.port, storage().store, {
          name: "Agent",
          vault: "Automation",
          saveVault: "Personal",
          createVault: false,
          write: false,
          expiresIn,
        }),
      ).rejects.toThrow("positive duration");
    }
    const newVault = provider();
    const vaultWrites: string[][] = [];
    const createVaultPort: PasswordAgentPort = {
      async invoke(args, options) {
        if (args[0] === "vault" && options.desktop && args[1] === "list")
          return JSON.stringify([backup]);
        if (args[0] === "vault" && args[1] === "create") {
          vaultWrites.push([...args]);
          return JSON.stringify(automation);
        }
        return newVault.port.invoke(args, options);
      },
    };
    expect(
      await setup(createVaultPort, storage().store, {
        name: "Agent",
        vault: "Automation",
        saveVault: "Personal",
        createVault: true,
        write: false,
      }),
    ).toEqual(expect.objectContaining({ verified: true }));
    expect(vaultWrites).toEqual([
      ["vault", "create", "Automation", "--format", "json"],
    ]);
  });
  it("service-account.partial", async () => {
    const fake = provider(true);
    const local = storage();
    const error = await setup(fake.port, local.store, {
      name: "Agent",
      vault: "Automation",
      saveVault: "Personal",
      createVault: false,
      write: true,
    }).catch((value: Error) => value);
    expect(String(error)).toContain("unverified");
    expect(String(error)).not.toContain(token);
    expect(await local.store.loadToken()).toBe(token);
    expect(local.events[0]).toBe("save-token");
    expect(
      fake.calls.filter((call) => call.args[0] === "service-account"),
    ).toHaveLength(1);
    expect(
      fake.calls.find((call) => call.args[0] === "service-account")?.args,
    ).toContain(`${automation.id}:read_items,write_items`);
    const failedStorage = storage();
    const brokenSettings = {
      ...failedStorage.store,
      async saveSettings() {
        throw new Error(token);
      },
    };
    const storageFailure = await setup(provider().port, brokenSettings, {
      name: "Agent",
      vault: "Automation",
      saveVault: "Personal",
      createVault: false,
      write: false,
    }).catch((value: Error) => value);
    expect(String(storageFailure)).not.toContain(token);
    expect(await failedStorage.store.loadToken()).toBe(token);
  });
  it("service-account.connect", async () => {
    const fake = provider();
    const local = storage();
    expect(
      await connect(fake.port, local.store, `${token}\n`, "Agent"),
    ).toEqual(expect.objectContaining({ configured: true, verified: true }));
    expect(await local.store.loadToken()).toBe(token);
    expect(fake.calls[0]?.options.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(token);
    await expect(connect(fake.port, local.store, "ops_OTHER")).rejects.toThrow(
      "exists",
    );
    const corrupt = {
      ...storage().store,
      async loadToken() {
        return "ops_WRONG";
      },
    };
    await expect(connect(fake.port, corrupt, token)).rejects.toThrow(
      "unverified",
    );
  });
  it("service-account.status", async () => {
    const fake = provider();
    const local = storage();
    expect(await status(fake.port, local.store)).toEqual(
      expect.objectContaining({ configured: false }),
    );
    expect(fake.calls).toHaveLength(0);
    await connect(fake.port, local.store, token);
    const result = await status(fake.port, local.store);
    expect(result).toEqual(
      expect.objectContaining({ verified: true, vaults: [automation] }),
    );
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("service-account.recover", async () => {
    const fake = provider();
    const local = storage();
    await local.store.saveToken(token);
    expect(await recover(fake.port, local.store, "Recovered")).toEqual(
      expect.objectContaining({ verified: true }),
    );
    expect((await local.store.loadSettings())?.name).toBe("Recovered");
    expect(fake.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["vault", "list"],
    ]);
  });
  it("service-account.forget", async () => {
    const fake = provider();
    const local = storage();
    await connect(fake.port, local.store, token);
    expect(await forget(local.store)).toEqual({
      forgotten: true,
      remoteRevoked: false,
    });
    expect(await local.store.hasToken()).toBe(false);
    expect(await local.store.loadSettings()).toBeUndefined();
    const broken = {
      ...local.store,
      async hasToken() {
        return true;
      },
    };
    await expect(forget(broken)).rejects.toThrow("unverified");
  });
  it("doctor.safe", async () => {
    const calls: string[][] = [];
    const deadlines: number[] = [];
    const port: PasswordAgentPort = {
      async invoke(args, options) {
        calls.push([...args]);
        deadlines.push(options.timeoutMs ?? 0);
        return args[0] === "--version"
          ? "2.0"
          : JSON.stringify([{ name: token, email: token }]);
      },
    };
    const result = await doctor(port, {
      version: "0.1",
      platform: "test",
      runtime: "node",
      auth: "desktop app",
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.accounts).toBe(1);
    expect(calls).toEqual([
      ["--version"],
      ["account", "list", "--format", "json"],
    ]);
    expect(deadlines).toEqual([5_000, 5_000]);
  });
});
