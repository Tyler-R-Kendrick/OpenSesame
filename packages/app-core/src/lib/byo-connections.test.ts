import { itemTypeRegistry } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BYO_CONNECTION_FIELD,
  type ByoConnectionInput,
  byoConnectionProblems,
  createByoConnection,
  readByoConnection,
} from "./byo-connections.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import {
  deviceConnection,
  revokeDeviceConnection,
} from "./device-connectors.js";
import { kvForgetAll } from "./kv.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const PASSWORD = "correct horse battery staple";

const BASIC: ByoConnectionInput = {
  name: "Acme basic",
  service: "Acme",
  method: "basic",
  baseUrl: "https://api.acme.test",
  authorizationUrl: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  username: "ada",
  password: "hunter2",
  apiKey: "",
  header: "X-Api-Key",
  scopes: "",
  samlEntityId: "",
  samlMetadataUrl: "",
  samlMetadataXml: "",
  samlPrivateKey: "",
  refreshToken: "",
};

async function openVault(): Promise<void> {
  kvForgetAll();
  await vfsFlush();
  await vaultStore.create(PASSWORD);
}

async function closeVault(): Promise<void> {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vaultStore.destroy();
}

beforeEach(openVault);
afterEach(closeVault);

describe("BYO connections", () => {
  it("keeps the credential in a generated vault item, never on the connection", async () => {
    const connection = await createByoConnection(BASIC);
    expect(connection.providerId).toBe("byo-connection");
    expect(connection.status).toBe("active");
    expect(connection.statusDetail).toContain("Credentials are stored");
    expect(itemTypeRegistry().has("byo-connection")).toBe(true);

    const row = readDeviceRows().find(
      (entry) => entry.connectionId === connection.connectionId,
    );
    expect(row?.providerId).toBe("byo-connection");
    expect(row?.fields[BYO_CONNECTION_FIELD]).toContain("basic");
    expect(row?.fields[BYO_CONNECTION_FIELD]).not.toContain("hunter2");
    expect(readDeviceSecrets()[connection.connectionId]).toBeUndefined();

    const record = readByoConnection(connection);
    expect(record?.method).toBe("basic");
    const item = vaultStore
      .getSnapshot()
      .items.find((candidate) => candidate.id === record?.itemId);
    expect(item?.kind).toBe("typed");
    if (item?.kind !== "typed") throw new Error("Expected a typed item");
    expect(item.values.credential).toBe("hunter2");
    expect(item.values.username).toBe("ada");
    expect(item.name).toBe("Acme basic");
  });

  it("normalises a pasted SAML PEM into a concealed multiline credential", async () => {
    const connection = await createByoConnection({
      ...BASIC,
      name: "Acme SAML",
      method: "saml",
      samlEntityId: "urn:acme",
      samlMetadataUrl: "https://idp.acme.test/metadata",
      samlPrivateKey:
        "-----BEGIN PRIVATE KEY-----MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA-----END PRIVATE KEY-----",
    });
    const record = readByoConnection(connection);
    const item = vaultStore
      .getSnapshot()
      .items.find((candidate) => candidate.id === record?.itemId);
    if (item?.kind !== "typed") throw new Error("Expected a typed item");
    const credential = item.values.credential;
    expect(credential).toEqual(expect.any(String));
    expect(credential).toContain("\n");
    expect(credential).toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("stops calling the connection active when its item is trashed", async () => {
    const connection = await createByoConnection(BASIC);
    const record = readByoConnection(connection);
    if (!record) throw new Error("Expected a BYO record");
    await vaultStore.trashItem(record.itemId);
    expect(deviceConnection(connection.connectionId)?.status).toBe("pending");
  });

  it("revokes the connection row while leaving the credential item in the vault", async () => {
    const connection = await createByoConnection(BASIC);
    const record = readByoConnection(connection);
    await revokeDeviceConnection(connection.connectionId);
    expect(deviceConnection(connection.connectionId)).toBeNull();
    expect(readDeviceRows()).toEqual([]);
    expect(
      vaultStore.getSnapshot().items.some((item) => item.id === record?.itemId),
    ).toBe(true);
  });

  it("reuses the installed type for a second connection", async () => {
    await createByoConnection(BASIC);
    await expect(
      createByoConnection({ ...BASIC, name: "Acme second" }),
    ).resolves.toMatchObject({ providerId: "byo-connection" });
  });

  it("validates each method before writing anything", () => {
    expect(byoConnectionProblems(BASIC)).toEqual([]);
    expect(
      byoConnectionProblems({
        ...BASIC,
        method: "api-key",
        password: "",
        apiKey: "",
        header: "X-Api-Key",
      }),
    ).toContain("Enter an API key");
    expect(
      byoConnectionProblems({
        ...BASIC,
        method: "saml",
        samlEntityId: "",
        samlMetadataUrl: "",
        samlMetadataXml: "",
      }),
    ).toEqual(
      expect.arrayContaining([
        "Enter the SAML entity ID",
        "Enter SAML metadata URL or XML",
      ]),
    );
  });

  it("does not install a type or write a row for an invalid method", async () => {
    await expect(
      createByoConnection({ ...BASIC, baseUrl: "http://api.acme.test" }),
    ).rejects.toThrow("HTTPS base URL");
    expect(readDeviceRows()).toEqual([]);
    expect(itemTypeRegistry().has("byo-connection")).toBe(false);
  });
});
