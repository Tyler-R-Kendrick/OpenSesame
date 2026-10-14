import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackendWireFixture,
  backendWireFixture,
} from "./infisical-passwordstate.test-support.js";
import { createPasswordstateBackend } from "./passwordstate.js";
import { secretBackendDraft } from "./presets.js";

describe("Passwordstate native HTTP passwords", () => {
  let fixture: BackendWireFixture;
  let credential: string;
  beforeEach(async () => {
    credential = randomBytes(24).toString("base64url");
    fixture = await backendWireFixture("passwordstate", credential);
  });
  afterEach(async () => fixture.close());
  const config = () => ({
    ...secretBackendDraft("passwordstate"),
    baseUrl: fixture.baseUrl,
    passwordListId: "77",
    token: credential,
  });

  it("authenticates an API key and round-trips password CRUD with documented wire fields", async () => {
    const backend = createPasswordstateBackend();
    const session = await backend.authenticate(config());
    expect(JSON.stringify(session)).not.toContain(credential);
    const item = {
      name: "OpenSesame backup",
      notes: "backup\nnotes",
      secret: "protected-secret",
      username: "alice",
      url: "https://example.com",
    };
    const created = await backend.createItem?.(item, session);
    expect(created).toMatchObject(item);
    if (!created) throw new Error("Expected native create support");
    expect(fixture.seen[0]?.path).toBe(
      "/mounted/api/passwords/77?QueryAll&ExcludePassword=True",
    );
    expect(fixture.seen[1]).toMatchObject({
      method: "POST",
      path: "/mounted/api/passwords",
      authorization: credential,
      body: {
        PasswordListID: 77,
        Title: item.name,
        Notes: item.notes,
        Password: item.secret,
        UserName: item.username,
        URL: item.url,
        PasswordResetEnabled: false,
      },
    });
    expect(await backend.listItems(session)).toEqual([
      { id: created.id, name: item.name, kind: "login" },
    ]);
    expect(await backend.getNotes(item.name, session)).toBe(item.notes);
    expect((await backend.getItem(created.id, session)).secret).toBe(
      item.secret,
    );
    expect(
      await backend.updateItem?.(
        created.id,
        { ...item, secret: "changed" },
        session,
      ),
    ).toMatchObject({ id: created.id, secret: "changed" });
    await backend.deleteItem?.(created.id, session);
    expect(
      fixture.seen.some(
        (req) =>
          req.path ===
            `/mounted/api/passwords/${created.id}?MoveToRecycleBin=True` &&
          req.method === "DELETE",
      ),
    ).toBe(true);
    expect(await backend.listItems(session)).toEqual([]);
  });

  it("refuses ambiguous names and IDs outside the selected password list", async () => {
    const backend = createPasswordstateBackend();
    const session = await backend.authenticate(config());
    const item = { name: "duplicate", notes: "", secret: "value" };
    const first = await backend.createItem?.(item, session);
    await backend.createItem?.(item, session);
    await expect(backend.getItem(item.name, session)).rejects.toMatchObject({
      code: "ambiguous",
    });
    await expect(backend.getItem("999999", session)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(
      fixture.seen.some((req) => req.path === "/mounted/api/passwords/999999"),
    ).toBe(false);
    if (!first) throw new Error("Expected native create support");
    expect((await backend.getItem(first.id, session)).id).toBe(first.id);
  });

  it("does not report managed password reset queues as completed updates", async () => {
    const backend = createPasswordstateBackend();
    const session = await backend.authenticate(config());
    const item = { name: "managed", notes: "", secret: "old" };
    const created = await backend.createItem?.(item, session);
    if (!created) throw new Error("Expected native create support");
    fixture.mode("queued");
    await expect(
      backend.updateItem?.(created.id, { ...item, secret: "new" }, session),
    ).rejects.toThrow(/queued/);
    expect((await backend.getItem(created.id, session)).secret).toBe("old");
  });

  it("fences credentials to the authenticated endpoint and invalidates disconnected or forged sessions", async () => {
    const backend = createPasswordstateBackend();
    const draft = config();
    const session = await backend.authenticate(draft);
    draft.baseUrl = "https://must-not-receive-api-key.example";
    await backend.listItems(session);
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await backend.disconnect(session);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(fixture.seen).toHaveLength(2);
    expect(fixture.seen.every((req) => req.authorization === credential)).toBe(
      true,
    );
  });

  it("returns sanitized permission and malformed-response failures", async () => {
    fixture.mode("reject");
    const backend = createPasswordstateBackend();
    await expect(backend.authenticate(config())).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(backend.authenticate(config())).rejects.not.toThrow(
      credential,
    );
    fixture.mode("malformed");
    await expect(backend.authenticate(config())).rejects.toMatchObject({
      code: "response",
    });
    fixture.mode("normal");
    await expect(
      backend.authenticate({ ...config(), passwordListId: "../other" }),
    ).rejects.toMatchObject({ code: "configuration" });
  });
});
