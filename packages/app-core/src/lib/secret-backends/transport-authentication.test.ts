import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  it("fences every optional method and permits cleanup after owner withdrawal", async () => {
    const item = {
      id: "one",
      name: "One",
      kind: "secret" as const,
      secret: "value",
      notes: "",
    };
    const createItem = vi.fn<NonNullable<SecretBackend["createItem"]>>(
      async function (this: SecretBackend) {
        expect(this).toBe(raw);
        return item;
      },
    );
    const updateItem = vi.fn<NonNullable<SecretBackend["updateItem"]>>(
      async function (this: SecretBackend) {
        expect(this).toBe(raw);
        return item;
      },
    );
    const deleteItem = vi.fn<NonNullable<SecretBackend["deleteItem"]>>(
      async function (this: SecretBackend) {
        expect(this).toBe(raw);
      },
    );
    const importToLocal = vi.fn<NonNullable<SecretBackend["importToLocal"]>>(
      async function (this: SecretBackend) {
        expect(this).toBe(raw);
        return { imported: 1, skipped: 0, warnings: [] };
      },
    );
    const disconnect = vi.fn<SecretBackend["disconnect"]>().mockResolvedValue();
    const raw = {
      ...createInfisicalBackend(),
      createItem,
      updateItem,
      deleteItem,
      importToLocal,
      disconnect,
    };
    const owner = new AbortController();
    const backend = fenceSecretBackend(raw, {
      signal: owner.signal,
      assertCurrent() {},
    });
    await backend.createItem?.(item, session);
    await backend.updateItem?.(item.id, item, session);
    await backend.deleteItem?.(item.id, session);
    await backend.importToLocal?.(session);
    owner.abort();
    await expect(backend.createItem?.(item, session)).rejects.toMatchObject({
      code: "stale",
    });
    await expect(
      backend.updateItem?.(item.id, item, session),
    ).rejects.toMatchObject({ code: "stale" });
    await expect(backend.deleteItem?.(item.id, session)).rejects.toMatchObject({
      code: "stale",
    });
    await expect(backend.importToLocal?.(session)).rejects.toMatchObject({
      code: "stale",
    });
    for (const method of [createItem, updateItem, deleteItem, importToLocal])
      expect(method).toHaveBeenCalledOnce();
    await backend.disconnect(session);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(session);
  });

  it.each(["hung", "rejected"] as const)(
    "rejects owner cancellation before late authentication's %s disposal settles",
    async (cleanup) => {
      let finish = (_session: SecretBackendSession) => {};
      const authenticate = vi.fn(
        () =>
          new Promise<SecretBackendSession>((resolve) => {
            finish = resolve;
          }),
      );
      const disconnect = vi.fn<SecretBackend["disconnect"]>(() =>
        cleanup === "hung"
          ? new Promise(() => {})
          : Promise.reject(new Error("Cleanup failed")),
      );
      const owner = new AbortController();
      const transport = guardSecretBackendTransport(
        {
          signal: new AbortController().signal,
          assertCurrent() {},
          fetch: vi.fn(),
        },
        undefined,
        owner.signal,
      );
      const backend = fenceSecretBackend(
        { ...createInfisicalBackend(), authenticate, disconnect },
        transport,
      );
      const pending = backend.authenticate(secretBackendDraft("infisical"));
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
      owner.abort();
      await expect(pending).rejects.toMatchObject({ code: "stale" });
      finish(session);
      await vi.waitFor(() =>
        expect(disconnect).toHaveBeenCalledExactlyOnceWith(session),
      );
    },
  );

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
import { once } from "node:events";
import { createServer } from "node:http";

describe("captured native HTTP cancellation", () => {
  it.each(["feature", "owner", "request", "init"] as const)(
    "closes the actual socket on %s abort before releasing the delayed response",
    async (cause) => {
      let enter = () => {};
      let flush = () => {};
      let socketClosed = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const delayed = new Promise<void>((resolve) => {
        flush = resolve;
      });
      const closed = new Promise<void>((resolve) => {
        socketClosed = resolve;
      });
      let flushed = false;
      let body = "";
      let callerHeader: string | undefined;
      const server = createServer(async (request, response) => {
        response.once("close", socketClosed);
        callerHeader = request.headers["x-caller"]?.toString();
        for await (const part of request) body += part.toString();
        enter();
        await delayed;
        flushed = true;
        if (!response.destroyed) response.end("ready");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = z.object({ port: z.number() }).parse(server.address());
        const signals = {
          feature: new AbortController(),
          owner: new AbortController(),
          request: new AbortController(),
          init: new AbortController(),
        };
        const transport = guardSecretBackendTransport(
          {
            fetch: globalThis.fetch,
            signal: signals.feature.signal,
            assertCurrent() {},
          },
          undefined,
          signals.owner.signal,
        );
        const request = new Request(
          `http://127.0.0.1:${address.port}/delayed`,
          {
            method: "POST",
            body: "unchanged body",
            headers: { "x-caller": "unchanged header" },
            signal: signals.request.signal,
          },
        );
        const pending = transport.fetch(request, {
          signal: signals.init.signal,
          cache: "no-store",
        });
        const cancelled = expect(pending).rejects.toThrow();
        await entered;
        expect(body).toBe("unchanged body");
        expect(callerHeader).toBe("unchanged header");
        signals[cause].abort();
        await cancelled;
        await closed;
        expect(flushed).toBe(false);
        expect(transport.signal.aborted).toBe(
          cause === "feature" || cause === "owner",
        );
      } finally {
        flush();
        const shutdown = once(server, "close");
        server.closeAllConnections();
        server.close();
        await shutdown;
      }
    },
  );
});
