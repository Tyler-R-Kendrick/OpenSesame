import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import {
  bindSecretBackendTransport,
  secretBackendTransport,
} from "./transport.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

const releases: (() => void)[] = [];
afterEach(() => {
  while (releases.length) releases.pop()?.();
  vi.restoreAllMocks();
});

function bind(fetcher: SecretBackendFetch) {
  const lifetime = new AbortController();
  const release = bindSecretBackendTransport({
    signal: lifetime.signal,
    assertCurrent() {
      if (lifetime.signal.aborted)
        throw new SecretBackendError("stale", "lease ended");
    },
    fetch: fetcher,
  });
  releases.push(release);
  return { lifetime, release };
}

const config = () => ({
  ...secretBackendDraft("infisical"),
  baseUrl: "https://secrets.example/instance",
  token: "scoped-access-token",
  projectId: "project",
  environment: "dev",
  secretPath: "/",
});

describe("secret backend capability capture", () => {
  it.each([
    "onepassword-connect",
    "bitwarden-api",
    "bitwarden-secrets",
    "infisical",
    "passwordstate",
  ] as const)(
    "refuses inactive %s before HTTP or SDK creation",
    async (mode) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      await expect(createSecretBackend(mode)).rejects.toMatchObject({
        code: "stale",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "file-import", "credential-management"] as const)(
    "constructs %s without external authority",
    async (mode) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      expect((await createSecretBackend(mode)).id).toBe(mode);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("captures one activation and never borrows a replacement's credentials or egress", async () => {
    const firstFetch = vi.fn<SecretBackendFetch>(async () =>
      Response.json({ secrets: [] }),
    );
    const first = bind(firstFetch);
    const backend = await createSecretBackend("infisical");
    const session = await backend.authenticate(config());
    first.lifetime.abort();
    const secondFetch = vi.fn<SecretBackendFetch>(async () =>
      Response.json({ secrets: [] }),
    );
    bind(secondFetch);
    first.release();
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "stale",
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
    const next = await createSecretBackend("infisical");
    await next.authenticate(config());
    expect(secondFetch).toHaveBeenCalledTimes(1);
    await backend.disconnect(session);
  });

  it("rejects late authenticated results immediately on abort even when HTTP ignores its signal", async () => {
    let finish = (_value: Response) => {};
    const fetcher = vi.fn<SecretBackendFetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const bound = bind(fetcher);
    const backend = await createSecretBackend("infisical");
    const pending = backend.authenticate(config());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    bound.lifetime.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    finish(Response.json({ secrets: [] }));
    await expect(backend.authenticate(config())).rejects.toMatchObject({
      code: "stale",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => secretBackendTransport()).toThrow(/lease ended/);
  });

  it("refuses the authenticated API leg when the vault locks during Universal Auth", async () => {
    let unlocked = true;
    const fetcher = vi.fn<SecretBackendFetch>(async () => {
      unlocked = false;
      return Response.json({ accessToken: "new-access-token" });
    });
    bind(fetcher);
    const backend = await createSecretBackend("infisical", () => {
      if (!unlocked) throw new SecretBackendError("locked", "Vault locked.");
    });
    await expect(
      backend.authenticate({
        ...config(),
        clientId: "machine-client",
        clientSecret: "machine-secret",
      }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/v1/auth/universal-auth/login",
    );
  });
});
