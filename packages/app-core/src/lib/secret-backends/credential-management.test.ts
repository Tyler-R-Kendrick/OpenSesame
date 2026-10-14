import { expect, it, vi } from "vitest";
import {
  type CredentialManagementPort,
  createCredentialManagementBackend,
} from "./credential-management.js";
import { secretBackendDraft } from "./presets.js";

function fixture() {
  const getPassword = vi.fn(async () => ({
    id: "user",
    name: "Browser user",
    password: "browser-fixture",
  }));
  const storePassword = vi.fn(async () => {});
  const preventSilentAccess = vi.fn(async () => {});
  let origin = "https://app.example.com";
  const port: CredentialManagementPort = {
    origin: () => origin,
    secureContext: () => true,
    supported: () => true,
    getPassword,
    storePassword,
    preventSilentAccess,
  };
  return {
    port,
    getPassword,
    storePassword,
    preventSilentAccess,
    changeOrigin: () => {
      origin = "https://other.example.com";
    },
  };
}
const config = () => ({
  ...secretBackendDraft("byo-secret-backend"),
  mode: "credential-management" as const,
});
it("offers an origin-scoped selected password and explicitly refuses enumeration/deletion", async () => {
  const f = fixture();
  const backend = createCredentialManagementBackend(f.port);
  const session = await backend.authenticate(config());
  expect(f.getPassword).toHaveBeenCalledOnce();
  expect(backend.capabilities).toMatchObject({ list: false, delete: false });
  await expect(backend.listItems(session)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(backend.deleteItem).toBeUndefined();
  expect(await backend.getItem("user", session)).toMatchObject({
    username: "user",
    secret: "browser-fixture",
  });
  await expect(backend.getItem("someone-else", session)).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(backend.getNotes("someone-else", session)).rejects.toMatchObject(
    { code: "not-found" },
  );
  await backend.disconnect(session);
  expect(f.preventSilentAccess).toHaveBeenCalledOnce();
  await expect(backend.getItem("user", session)).rejects.toMatchObject({
    code: "authentication",
  });
});
it("an empty origin session permits explicit create while get remains absent until a password is stored", async () => {
  const f = fixture();
  const port: CredentialManagementPort = {
    ...f.port,
    getPassword: async () => null,
  };
  const backend = createCredentialManagementBackend(port);
  const session = await backend.authenticate(config());
  await expect(backend.getItem("user", session)).rejects.toMatchObject({
    code: "not-found",
  });
  expect(
    await backend.createItem?.(
      {
        name: "New user",
        username: "new-user",
        secret: "new-password",
        notes: "",
      },
      session,
    ),
  ).toMatchObject({ id: "new-user", kind: "login" });
  expect(f.storePassword).toHaveBeenCalledWith({
    id: "new-user",
    name: "New user",
    password: "new-password",
  });
  expect((await backend.getItem("new-user", session)).secret).toBe(
    "new-password",
  );
  await expect(
    backend.updateItem?.(
      "new-user",
      { name: "Other", username: "other-user", secret: "changed", notes: "" },
      session,
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(f.storePassword).toHaveBeenCalledTimes(1);
});
it("refuses origin changes, unavailable APIs, and API permission failures", async () => {
  const f = fixture();
  const backend = createCredentialManagementBackend(f.port);
  const session = await backend.authenticate(config());
  f.changeOrigin();
  await expect(backend.getItem("user", session)).rejects.toMatchObject({
    code: "stale",
  });
  const missing = createCredentialManagementBackend({
    ...f.port,
    supported: () => false,
  });
  await expect(missing.authenticate(config())).rejects.toMatchObject({
    code: "unsupported",
  });
  const denied = createCredentialManagementBackend({
    ...f.port,
    getPassword: async () => {
      throw new DOMException("Denied", "NotAllowedError");
    },
  });
  await expect(denied.authenticate(config())).rejects.toThrow("Denied");
});
it("a late browser response cannot cross origins or revive a disconnected handle", async () => {
  const f = fixture();
  const backend = createCredentialManagementBackend(f.port);
  const session = await backend.authenticate(config());
  let finish: () => void = () => {};
  f.storePassword.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const write = backend.updateItem?.(
    "user",
    { name: "Browser user", username: "user", secret: "late", notes: "" },
    session,
  );
  await backend.disconnect(session);
  finish();
  await expect(write).rejects.toMatchObject({ code: "authentication" });
  const g = fixture();
  const raced = createCredentialManagementBackend({
    ...g.port,
    getPassword: async () => {
      g.changeOrigin();
      return { id: "user", name: "User", password: "value" };
    },
  });
  await expect(raced.authenticate(config())).rejects.toMatchObject({
    code: "stale",
  });
});
it("a late update cannot replace the newer selected credential after another create completes", async () => {
  const f = fixture();
  const backend = createCredentialManagementBackend(f.port);
  const session = await backend.authenticate(config());
  let finish: () => void = () => {};
  f.storePassword.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const earlier = backend.updateItem?.(
    "user",
    { name: "Browser user", username: "user", secret: "earlier", notes: "" },
    session,
  );
  await backend.createItem?.(
    { name: "Other user", username: "other-user", secret: "newer", notes: "" },
    session,
  );
  finish();
  await expect(earlier).rejects.toMatchObject({ code: "stale" });
  expect((await backend.getItem("other-user", session)).secret).toBe("newer");
  await expect(backend.getItem("user", session)).rejects.toMatchObject({
    code: "not-found",
  });
});
