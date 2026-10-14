import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackendWireFixture,
  backendWireFixture,
} from "./infisical-passwordstate.test-support.js";
import { createInfisicalBackend } from "./infisical.js";
import { secretBackendDraft } from "./presets.js";

describe("Infisical native HTTP secrets", () => {
  let fixture: BackendWireFixture;
  let credential: string;
  beforeEach(async () => {
    credential = randomBytes(24).toString("base64url");
    fixture = await backendWireFixture("infisical", credential);
  });
  afterEach(async () => fixture.close());
  const config = () => ({
    ...secretBackendDraft("infisical"),
    baseUrl: fixture.baseUrl,
    projectId: "project-1",
    environment: "dev",
    secretPath: "/backups",
    token: credential,
  });

  it("authenticates Universal Auth and round-trips secrets, comments, rename and delete over real HTTP", async () => {
    const backend = createInfisicalBackend();
    const session = await backend.authenticate({
      ...config(),
      token: "",
      clientId: "machine-id",
      clientSecret: credential,
    });
    expect(JSON.stringify(session)).not.toContain(credential);
    expect(fixture.seen[0]).toMatchObject({
      method: "POST",
      path: "/mounted/api/v1/auth/universal-auth/login",
      authorization: "",
      body: { clientId: "machine-id", clientSecret: credential },
    });
    const input = {
      name: "backup",
      notes: "multiline\nnotes",
      secret: "${UNCHANGED_LITERAL}\nsecret",
    };
    const created = await backend.createItem?.(input, session);
    expect(created).toMatchObject({ ...input, id: "backup" });
    expect(await backend.listItems(session)).toEqual([
      { id: "backup", name: "backup", kind: "secret" },
    ]);
    expect(await backend.getNotes("backup", session)).toBe(input.notes);
    expect((await backend.getItem("backup", session)).secret).toBe(
      input.secret,
    );
    const read = fixture.seen.find(
      (req) =>
        req.path.startsWith("/mounted/api/v4/secrets/backup?") &&
        req.method === "GET",
    );
    expect(read?.path).toContain("expandSecretReferences=false");
    const updated = await backend.updateItem?.(
      "backup",
      { ...input, name: "renamed", secret: "rotated" },
      session,
    );
    expect(updated).toMatchObject({
      id: "renamed",
      name: "renamed",
      secret: "rotated",
    });
    await backend.deleteItem?.("renamed", session);
    expect(await backend.listItems(session)).toEqual([]);
  });

  it("binds token sessions to their configured endpoint and refuses forged or disconnected sessions", async () => {
    const backend = createInfisicalBackend();
    const draft = config();
    const session = await backend.authenticate(draft);
    draft.baseUrl = "https://must-not-receive-credentials.example";
    await backend.listItems(session);
    expect(fixture.seen).toHaveLength(2);
    expect(
      fixture.seen.every((req) => req.authorization === `Bearer ${credential}`),
    ).toBe(true);
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await backend.disconnect(session);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(fixture.seen).toHaveLength(2);
  });

  it("refuses incomplete login, unsafe names and unsupported field loss before write", async () => {
    const backend = createInfisicalBackend();
    await expect(
      backend.authenticate({
        ...config(),
        clientId: "machine-id",
        clientSecret: "",
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    const session = await backend.authenticate(config());
    await expect(backend.getItem("..", session)).rejects.toMatchObject({
      code: "configuration",
    });
    await expect(
      backend.createItem?.(
        { name: "secret", notes: "", secret: "", fields: { pin: "123" } },
        session,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fixture.seen).toHaveLength(1);
  });

  it("surfaces unreadable responses, hidden values and credential refusals without server text", async () => {
    const backend = createInfisicalBackend();
    const session = await backend.authenticate(config());
    await backend.createItem?.(
      { name: "hidden", notes: "", secret: credential },
      session,
    );
    fixture.mode("hidden");
    await expect(backend.getItem("hidden", session)).rejects.toMatchObject({
      code: "response",
    });
    fixture.mode("malformed");
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "response",
    });
    fixture.mode("reject");
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(backend.listItems(session)).rejects.not.toThrow(credential);
  });

  it("refuses credential-bearing redirects and reports browser CORS failures accurately", async () => {
    fixture.mode("redirect");
    await expect(
      createInfisicalBackend().authenticate(config()),
    ).rejects.toMatchObject({ code: "network" });
    const cors = createInfisicalBackend(async () => {
      throw new TypeError(`Failed to fetch ${credential}`);
    });
    await expect(cors.authenticate(config())).rejects.toThrow(/CORS/);
    await expect(cors.authenticate(config())).rejects.not.toThrow(credential);
  });
});
