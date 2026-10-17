import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import {
  bindSecretBackendTransport,
  guardSecretBackendTransport,
  secretBackendTransport,
} from "./transport.js";
import {
  SecretBackendError,
  type SecretBackendFetch,
  type SecretBackendMode,
} from "./types.js";

const modes: SecretBackendMode[] = [
  "local",
  "file-import",
  "credential-management",
  "onepassword-connect",
  "bitwarden-api",
  "bitwarden-secrets",
  "infisical",
  "passwordstate",
];

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
  it.each(modes)(
    "refuses an already-ended %s owner before construction",
    async (mode) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      const guard = vi.fn();
      await expect(
        createSecretBackend(mode, guard, AbortSignal.abort()),
      ).rejects.toMatchObject({ code: "stale" });
      expect(guard).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(modes)(
    "checks the %s guard before importing its factory",
    async (mode) => {
      const denied = new SecretBackendError("locked", "Vault locked.");
      const guard = vi.fn(() => {
        throw denied;
      });
      await expect(createSecretBackend(mode, guard)).rejects.toBe(denied);
      expect(guard).toHaveBeenCalledOnce();
    },
  );

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

  it.each(["local", "file-import", "credential-management"] as const)(
    "fences the %s owner without requesting external authority",
    async (mode) => {
      const owner = new AbortController();
      const guard = vi.fn();
      const fetcher = vi.spyOn(globalThis, "fetch");
      const backend = await createSecretBackend(mode, guard, owner.signal);
      expect(backend.id).toBe(mode);
      owner.abort();
      await expect(
        backend.authenticate(secretBackendDraft("1password")),
      ).rejects.toMatchObject({ code: "stale" });
      expect(guard).toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("checks owner authority again after a dynamic module resolves", async () => {
    const module = await import("./local.js");
    const construct = vi.spyOn(module, "createLocalVaultBackend");
    const owner = new AbortController();
    const pending = createSecretBackend("local", undefined, owner.signal);
    owner.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(construct).not.toHaveBeenCalled();
  });

  it("checks HTTP authority before constructing the dynamically loaded adapter", async () => {
    const module = await import("./infisical.js");
    const construct = vi.spyOn(module, "createInfisicalBackend");
    const owner = new AbortController();
    bind(vi.fn());
    const pending = createSecretBackend("infisical", undefined, owner.signal);
    owner.abort();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(construct).not.toHaveBeenCalled();
  });

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

describe("request and owner cancellation", () => {
  it.each(["feature", "owner", "request", "init"] as const)(
    "forwards %s cancellation without replacing the request or captured fetch",
    async (cause) => {
      const signals = {
        feature: new AbortController(),
        owner: new AbortController(),
        request: new AbortController(),
        init: new AbortController(),
      };
      const globalFetch = vi.spyOn(globalThis, "fetch");
      let forwarded: AbortSignal | undefined;
      const captured = vi.fn<SecretBackendFetch>((_input, options) => {
        forwarded = options?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          forwarded?.addEventListener(
            "abort",
            () => reject(new Error("Cancelled")),
            { once: true },
          );
        });
      });
      const original = {
        fetch: captured,
        signal: signals.feature.signal,
        assertCurrent() {},
      };
      const transport = guardSecretBackendTransport(
        original,
        undefined,
        signals.owner.signal,
      );
      const replacement = vi.fn<SecretBackendFetch>();
      original.fetch = replacement;
      const request = new Request("https://secrets.example/operation", {
        method: "POST",
        body: "caller payload",
        headers: { "x-caller": "kept" },
        signal: signals.request.signal,
      });
      const options: RequestInit = {
        signal: signals.init.signal,
        headers: { "x-override": "kept" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      };
      const pending = transport.fetch(request, options);
      const cancelled = expect(pending).rejects.toThrow("Cancelled");
      signals[cause].abort();
      await cancelled;
      expect(forwarded?.aborted).toBe(true);
      expect(captured).toHaveBeenCalledExactlyOnceWith(request, {
        ...options,
        signal: forwarded,
      });
      expect(await request.text()).toBe("caller payload");
      expect(request.headers.get("x-caller")).toBe("kept");
      expect(replacement).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
      expect(transport.signal.aborted).toBe(
        cause === "feature" || cause === "owner",
      );
      if (cause === "request" || cause === "init")
        expect(() => transport.assertCurrent()).not.toThrow();
    },
  );

  it("preserves an operation deadline without revoking the owner", async () => {
    const owner = new AbortController();
    const deadline = new AbortController();
    const fetcher = vi
      .fn<SecretBackendFetch>()
      .mockImplementationOnce(
        (_input, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("Deadline")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const transport = guardSecretBackendTransport(
      {
        signal: new AbortController().signal,
        assertCurrent() {},
        fetch: fetcher,
      },
      undefined,
      owner.signal,
    );
    const pending = transport.fetch("https://secrets.example/first", {
      signal: deadline.signal,
    });
    const cancelled = expect(pending).rejects.toThrow("Deadline");
    deadline.abort();
    await cancelled;
    expect((await transport.fetch("https://secrets.example/second")).ok).toBe(
      true,
    );
    expect(owner.signal.aborted).toBe(false);
  });
});
