import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import type { OnePasswordSdkClient } from "./onepassword-sdk-loader.js";
import {
  deferred,
  itemId,
  nativeItem,
  nativeOverview,
  sdkFixture,
  vaultId,
} from "./onepassword-sdk.test-support.js";
import { OnePasswordCommandSchema } from "./onepassword-worker-protocol.js";
import type { SecretBackendItemInput } from "./types.js";

const edit: SecretBackendItemInput = {
  name: "Edited login",
  notes: "edited notes",
  secret: "edited-secret",
  kind: "login",
  username: "edited-user",
  url: "https://edited.invalid",
};
Object.freeze(edit);
async function open() {
  const f = sdkFixture();
  const session = await f.backend.authenticate(f.config);
  const create = f.backend.createItem?.bind(f.backend);
  const update = f.backend.updateItem?.bind(f.backend);
  const remove = f.backend.deleteItem?.bind(f.backend);
  if (!create || !update || !remove)
    throw new Error("Native mutation methods missing");
  f.invoke.mockClear();
  return {
    ...f,
    session,
    create: (input: SecretBackendItemInput) => create(input, session),
    update: (id: string, input: SecretBackendItemInput) =>
      update(id, input, session),
    remove: (id: string) => remove(id, session),
  };
}
type Open = Awaited<ReturnType<typeof open>>;
type Mutation = "create" | "update" | "delete";
function mutate(f: Open, method: Mutation) {
  if (method === "create") return f.create(edit);
  if (method === "update") return f.update(itemId, edit);
  return f.remove(itemId);
}
function replies(f: Open, write: OnePasswordSdkClient["invoke"]) {
  f.invoke.mockImplementation(async (command) => {
    if (command.name === "ItemsList") return [nativeOverview()];
    if (command.name === "ItemsGet") return nativeItem();
    return write(command);
  });
}
function deepFreeze(value: JsonValue): void {
  if (value !== null && Object(value) === value) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

// Injected SDK replies prove command composition and lifetimes, not hosted writes or encryption.
it.each([
  ["note", "SecureNote"],
  ["login", "Login"],
  ["secret", "ApiCredentials"],
] as const)(
  "creates native %s and returns the provider's actual stored values",
  async (kind, category) => {
    const f = await open();
    const input = {
      name: "Submitted",
      notes: "submitted",
      secret: kind === "note" ? "" : "submitted-secret",
      kind,
      id: "untrusted-client-id",
    };
    deepFreeze(input);
    f.invoke.mockResolvedValueOnce(
      nativeItem({
        id: "provider-id",
        category,
        title: "Provider title",
        notes: "stored notes",
        fields:
          kind === "note"
            ? []
            : [
                {
                  id: kind === "login" ? "password" : "native-key",
                  title: "Key",
                  fieldType: "Concealed",
                  value: "stored-secret",
                },
              ],
      }),
    );
    expect(await f.create(input)).toMatchObject({
      id: "provider-id",
      name: "Provider title",
      notes: "stored notes",
      secret: kind === "note" ? "" : "stored-secret",
      kind,
    });
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith({
      name: "ItemsCreate",
      params: expect.objectContaining({
        vaultId,
        category,
        title: "Submitted",
        notes: "submitted",
      }),
    });
    expect(
      OnePasswordCommandSchema.safeParse(f.invoke.mock.calls[0]?.[0]).success,
    ).toBe(true);
    await f.backend.disconnect(f.session);
  },
);
it("fetches a fresh full item and preserves frozen raw metadata/version in native Put", async () => {
  const f = await open();
  const fields: JsonObject[] = [
    {
      id: "username",
      title: "User",
      fieldType: "Text",
      value: "old-user",
      details: { untouched: true },
    },
    {
      id: "password",
      title: "Password",
      fieldType: "Concealed",
      value: "old-secret",
    },
    {
      id: "otp",
      title: "OTP",
      fieldType: "Totp",
      value: "otp-wire",
      sectionId: "extra",
      details: { future: [1, 2] },
    },
  ];
  const websites = [
    {
      url: "https://first.invalid",
      label: "Keep label",
      autofillBehavior: "ExactDomain",
      future: true,
    },
    {
      url: "https://second.invalid",
      label: "Keep second",
      autofillBehavior: "Never",
    },
  ];
  const raw = nativeItem({
    version: 37,
    fields,
    websites,
    tags: ["retain"],
    sections: [{ id: "extra", title: "Renamed", opaque: true }],
    files: [
      {
        attributes: { id: "file", name: "keep.bin", size: 42 },
        fieldId: "attachment",
        sectionId: "extra",
        opaque: true,
      },
    ],
    future: { nested: ["retain", { opaque: true }] },
  });
  const snapshot = JSON.stringify(raw);
  deepFreeze(raw);
  const stored = nativeItem({
    title: "Provider title",
    notes: "provider notes",
    version: 38,
  });
  f.invoke
    .mockResolvedValueOnce([nativeOverview()])
    .mockResolvedValueOnce(raw)
    .mockResolvedValueOnce(stored);
  expect(await f.update(itemId, edit)).toMatchObject({
    name: "Provider title",
    notes: "provider notes",
    secret: "private-native-marker",
  });
  expect(f.invoke.mock.calls.map(([command]) => command.name)).toEqual([
    "ItemsList",
    "ItemsGet",
    "ItemsPut",
  ]);
  expect(f.invoke.mock.calls[1]?.[0]).toEqual({ name: "ItemsGet", itemId });
  expect(f.invoke.mock.calls[2]?.[0]).toEqual({
    name: "ItemsPut",
    item: {
      ...raw,
      title: edit.name,
      notes: edit.notes,
      fields: [
        { ...fields[0], value: edit.username },
        { ...fields[1], value: edit.secret },
        fields[2],
      ],
      websites: [{ ...websites[0], url: edit.url }, websites[1]],
    },
  });
  expect(JSON.stringify(raw)).toBe(snapshot);
  await f.backend.disconnect(f.session);
});
it("deletes only after fresh active-ID selection and a complete scoped native Get", async () => {
  const f = await open();
  replies(f, async () => null);
  await expect(f.remove(itemId)).resolves.toBeUndefined();
  expect(f.invoke.mock.calls.map(([command]) => command)).toEqual([
    { name: "ItemsList" },
    { name: "ItemsGet", itemId },
    { name: "ItemsDelete", itemId },
  ]);
  await f.backend.disconnect(f.session);
});
it.each(["create", "update"] as const)(
  "rejects wrong native %s result scope/category instead of echoing submission",
  async (method) => {
    for (const changes of [
      { vaultId: "foreign" },
      ...(method === "update" ? [{ id: "foreign" }] : [{ id: "" }]),
      { category: "SecureNote" },
      { fields: null },
    ]) {
      const f = await open();
      replies(f, async () => nativeItem(changes));
      await expect(mutate(f, method)).rejects.toMatchObject({
        code: "response",
      });
      expect(
        f.invoke.mock.calls.filter(
          ([command]) =>
            command.name === "ItemsCreate" || command.name === "ItemsPut",
        ),
      ).toHaveLength(1);
      await f.backend.disconnect(f.session);
    }
  },
);
it.each(["update", "delete"] as const)(
  "refuses stale-ID title fallback, archived and unsupported %s targets before Get",
  async (method) => {
    const selections = [
      [nativeOverview({ id: "other", title: itemId })],
      [
        nativeOverview({ state: "archived" }),
        nativeOverview({ id: "other", title: itemId }),
      ],
      [
        nativeOverview({ category: "Document" }),
        nativeOverview({ id: "other", title: itemId }),
      ],
    ];
    for (const rows of selections) {
      const f = await open();
      f.invoke.mockResolvedValueOnce(rows);
      await expect(mutate(f, method)).rejects.toMatchObject({
        code: rows[0]?.category === "Document" ? "unsupported" : "not-found",
      });
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ name: "ItemsList" });
      await f.backend.disconnect(f.session);
    }
  },
);
it.each(["update", "delete"] as const)(
  "validates full Get scope before native %s",
  async (method) => {
    for (const changes of [
      { vaultId: "foreign" },
      { id: "foreign" },
      { category: "Document" },
    ]) {
      const f = await open();
      f.invoke
        .mockResolvedValueOnce([nativeOverview()])
        .mockResolvedValueOnce(nativeItem(changes));
      await expect(mutate(f, method)).rejects.toBeInstanceOf(Error);
      expect(f.invoke.mock.calls.map(([command]) => command.name)).toEqual([
        "ItemsList",
        "ItemsGet",
      ]);
      await f.backend.disconnect(f.session);
    }
  },
);
it.each([{}, { success: true }, "deleted"])(
  "rejects a non-null native Delete reply %#",
  async (result) => {
    const f = await open();
    replies(f, async () => result);
    await expect(f.remove(itemId)).rejects.toMatchObject({ code: "response" });
    expect(f.invoke).toHaveBeenCalledTimes(3);
    await f.backend.disconnect(f.session);
  },
);
it.each(["create", "update", "delete"] as const)(
  "does not retry an ordinary %s conflict or retire the live session",
  async (method) => {
    const f = await open();
    replies(f, async () => {
      throw new Error("Private native revision conflict 409");
    });
    await expect(mutate(f, method)).rejects.toThrow(
      "1Password could not complete the native vault operation.",
    );
    expect(f.invoke).toHaveBeenCalledTimes(method === "create" ? 1 : 3);
    expect(f.session.signal?.aborted).toBe(false);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(await f.backend.listItems(f.session)).toHaveLength(1);
    await f.backend.disconnect(f.session);
  },
);
it.each([
  ["create", "owner"],
  ["update", "native"],
  ["delete", "native"],
] as const)(
  "discards a late %s success after %s loss",
  async (method, cause) => {
    const f = await open();
    const entered = deferred<void>();
    const reply = deferred<void>();
    replies(f, async () => {
      entered.resolve();
      await reply.promise;
      return method === "delete" ? null : nativeItem();
    });
    const pending = mutate(f, method);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await entered.promise;
    f[cause].abort();
    await cancelled;
    reply.resolve();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    expect(f.session.signal?.aborted).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(method === "create" ? 1 : 3);
  },
);
it.each(["\u0000".repeat(128 * 1024), `${"秘密🙂".repeat(13_107)}ab`])(
  "frames a near-boundary escaped/multibyte note backup %#",
  async (notes) => {
    const f = await open();
    expect(new TextEncoder().encode(notes).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
    const stored = nativeItem({
      id: "backup-id",
      category: "SecureNote",
      notes,
      fields: [],
    });
    f.invoke.mockResolvedValueOnce(stored);
    expect(
      (
        await f.create({
          name: "Vault backup",
          kind: "note",
          notes,
          secret: "",
        })
      ).notes,
    ).toBe(notes);
    const command = f.invoke.mock.calls[0]?.[0];
    expect(OnePasswordCommandSchema.safeParse(command).success).toBe(true);
    expect(
      new TextEncoder().encode(
        JSON.stringify({ type: "invoke", id: 1, command }),
      ).byteLength,
    ).toBeLessThan(1024 * 1024);
    await f.backend.disconnect(f.session);
  },
);
it("rejects oversized retained raw metadata before Put without dropping it or incrementing version", async () => {
  const f = await open();
  const raw = nativeItem({ future: { retained: "x".repeat(1024 * 1024) } });
  const snapshot = JSON.stringify(raw);
  deepFreeze(raw);
  f.invoke.mockResolvedValueOnce([nativeOverview()]).mockResolvedValueOnce(raw);
  await expect(f.update(itemId, edit)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(f.invoke.mock.calls.map(([command]) => command.name)).toEqual([
    "ItemsList",
    "ItemsGet",
  ]);
  expect(JSON.stringify(raw)).toBe(snapshot);
  expect(raw.version).toBe(17);
  await f.backend.disconnect(f.session);
});
