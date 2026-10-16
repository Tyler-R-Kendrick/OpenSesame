import { describe, expect, it, vi } from "vitest";
import { createInfisicalBackend } from "./infisical.js";
import { secretBackendDraft } from "./presets.js";
import {
  fenceSecretBackend,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

const session: SecretBackendSession = {
  id: "opaque-authenticated-session",
  backendId: "infisical",
  authenticatedAt: "2026-10-14T00:00:00Z",
};

describe("late authentication cleanup", () => {
  it("releases a late SDK or native session after immediate lease cancellation", async () => {
    let finish = (_session: SecretBackendSession) => {};
    const authenticate = vi.fn(
      () =>
        new Promise<SecretBackendSession>((resolve) => {
          finish = resolve;
        }),
    );
    const disconnect = vi
      .fn<SecretBackend["disconnect"]>()
      .mockResolvedValue(undefined);
    const lifetime = new AbortController();
    const backend = fenceSecretBackend(
      { ...createInfisicalBackend(), authenticate, disconnect },
      {
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
        fetch: vi.fn(),
      },
    );
    const pending = backend.authenticate(secretBackendDraft("infisical"));
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    lifetime.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    finish(session);
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(session),
    );
  });

  it("releases an authenticated session that loses its vault owner before delivery", async () => {
    let unlocked = true;
    const authenticate = vi.fn(async () => {
      unlocked = false;
      return session;
    });
    const disconnect = vi
      .fn<SecretBackend["disconnect"]>()
      .mockResolvedValue(undefined);
    const lifetime = new AbortController();
    const transport = guardSecretBackendTransport(
      {
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
        fetch: vi.fn(),
      },
      () => {
        if (!unlocked) throw new SecretBackendError("locked", "Vault locked.");
      },
    );
    const backend = fenceSecretBackend(
      { ...createInfisicalBackend(), authenticate, disconnect },
      transport,
    );
    await expect(
      backend.authenticate(secretBackendDraft("infisical")),
    ).rejects.toMatchObject({ code: "locked" });
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(session);
    await backend.disconnect(session);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
