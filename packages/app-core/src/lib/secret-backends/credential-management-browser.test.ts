import { afterEach, expect, it, vi } from "vitest";
import { createCredentialManagementBackend } from "./credential-management.js";
import { secretBackendDraft } from "./presets.js";

class BrowserCredential implements Credential {
  readonly type = "password";
  readonly id: string;
  readonly name: string;
  readonly password: string;
  constructor(value: { id: string; name: string; password: string }) {
    this.id = value.id;
    this.name = value.name;
    this.password = value.password;
  }
}
afterEach(() => vi.unstubAllGlobals());
it("the default browser boundary requests explicit password mediation and stores a real PasswordCredential value", async () => {
  const selected = new BrowserCredential({
    id: "current-user",
    name: "Current user",
    password: "current-fixture",
  });
  const get = vi.fn(async () => selected);
  const store = vi.fn(async (value: Credential) => value);
  const preventSilentAccess = vi.fn(async () => {});
  vi.stubGlobal("PasswordCredential", BrowserCredential);
  vi.stubGlobal("navigator", {
    credentials: { get, store, preventSilentAccess },
  });
  vi.stubGlobal("location", { origin: "https://app.example.com" });
  vi.stubGlobal("isSecureContext", true);
  const backend = createCredentialManagementBackend();
  const session = await backend.authenticate({
    ...secretBackendDraft("byo-secret-backend"),
    mode: "credential-management",
  });
  expect(get).toHaveBeenCalledWith({ password: true, mediation: "required" });
  expect((await backend.getItem("current-user", session)).secret).toBe(
    "current-fixture",
  );
  await backend.updateItem?.(
    "current-user",
    {
      name: "Current user",
      username: "current-user",
      secret: "rotated-fixture",
      notes: "",
    },
    session,
  );
  expect(store).toHaveBeenCalledWith(expect.any(BrowserCredential));
  expect(store.mock.calls[0]?.[0]).toMatchObject({
    id: "current-user",
    type: "password",
    password: "rotated-fixture",
  });
  await backend.disconnect(session);
  expect(preventSilentAccess).toHaveBeenCalledOnce();
});
it("a browser lacking PasswordCredential refuses the adapter without touching WebAuthn credentials", async () => {
  const get = vi.fn();
  vi.stubGlobal("PasswordCredential", undefined);
  vi.stubGlobal("navigator", { credentials: { get, store: vi.fn() } });
  vi.stubGlobal("location", { origin: "https://app.example.com" });
  vi.stubGlobal("isSecureContext", true);
  const backend = createCredentialManagementBackend();
  await expect(
    backend.authenticate({
      ...secretBackendDraft("byo-secret-backend"),
      mode: "credential-management",
    }),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(get).not.toHaveBeenCalled();
});
