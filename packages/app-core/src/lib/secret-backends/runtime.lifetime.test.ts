import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceConnection } from "../device-connectors.js";
import { vaultStore } from "../vault/store.js";
import {
  connectSecretBackend,
  probeSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import {
  deferred,
  remoteDraft,
  runtimeFixture,
} from "./runtime.test-support.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
it("a saved edit invalidates the admitted handle and an older authentication cannot reactivate it", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const first = await connectSecretBackend(saved.connectionId);
  await expect(
    first.backend.listItems({ ...first.session }),
  ).rejects.toMatchObject({ code: "authentication" });
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return Response.json({ id: "vault" });
  });
  const pending = connectSecretBackend(saved.connectionId);
  const stale = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  await saveSecretBackendConnection(
    { ...remoteDraft(), name: "Changed while signing in" },
    saved.connectionId,
  );
  resume.resolve();
  await stale;
  await expect(first.backend.listItems(first.session)).rejects.toMatchObject({
    code: "stale",
  });
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});
it("vault lock revokes a live opaque session and refuses all further provider I/O", async () => {
  const original = secretBackendRuntimeSeams.createBackend;
  const disconnect = vi.fn();
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
    async (mode, check) => {
      const backend = await original(mode, check);
      const close = backend.disconnect.bind(backend);
      vi.spyOn(backend, "disconnect").mockImplementation(async (session) => {
        disconnect();
        await close(session);
      });
      return backend;
    },
  );
  const saved = await saveSecretBackendConnection(remoteDraft());
  const open = await connectSecretBackend(saved.connectionId);
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  vaultStore.lock();
  await Promise.resolve();
  fixture.fetcher.mockClear();
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "locked",
  });
});
it("a probe whose target changes while awaiting HTTP fails without promoting a connection", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return Response.json({ id: "vault" });
  });
  const pending = probeSecretBackend(remoteDraft(), saved.connectionId);
  const failure = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  await saveSecretBackendConnection(
    { ...remoteDraft(), name: "Changed" },
    saved.connectionId,
  );
  resume.resolve();
  await failure;
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});
it("session delivery after a lock is rejected and no second request is issued", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return Response.json({ id: "vault" });
  });
  const pending = connectSecretBackend(saved.connectionId);
  const failure = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  vaultStore.lock();
  resume.resolve();
  await failure;
  expect(fixture.fetcher).toHaveBeenCalledTimes(1);
});
it("an older authentication cannot close or replace the later successfully admitted connection", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.fetcher.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return Response.json({ id: "vault" });
  });
  const older = connectSecretBackend(saved.connectionId);
  const failure = expect(older).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  const newer = await connectSecretBackend(saved.connectionId);
  resume.resolve();
  await failure;
  expect(await newer.backend.listItems(newer.session)).toEqual([]);
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
});
it("saving a live connection closes its SDK session without marking the new configuration authenticated", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const open = await connectSecretBackend(saved.connectionId);
  await saveSecretBackendConnection(
    { ...remoteDraft(), name: "Edited live target" },
    saved.connectionId,
  );
  fixture.fetcher.mockClear();
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});
