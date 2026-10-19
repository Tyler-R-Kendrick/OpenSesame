import { afterEach, expect, it } from "vitest";
import { createBitwardenNativeBrowserBackend } from "./bitwarden-native-browser.js";
import {
  type BitwardenNativeConfiguration,
  bitwardenNativeCapabilities,
} from "./bitwarden-native-contract.js";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import type {
  BitwardenNativeClient,
  NativeWorkerCommand,
} from "./bitwarden-native-worker-client.js";
import type {
  NativeWorkerRequest,
  NativeWorkerSettings,
  NativeWorkerValue,
} from "./bitwarden-native-worker-protocol.js";
import { createBitwardenNativeWorkerRuntime } from "./bitwarden-native-worker-runtime.js";
import { disposeSecretBackendProbe } from "./runtime-admission.js";
import { secretBackendSessionClosure } from "./sessions.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import { SecretBackendError } from "./types.js";

const closures: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closures.splice(0).reverse()) await close();
});
/** Real encrypted engine on the runtime seam; worker isolation is proved separately by the compiled-entry tests. */
async function runtimeClient(
  settings: NativeWorkerSettings,
  transport: SecretBackendTransport,
): Promise<BitwardenNativeClient> {
  const owner = new AbortController();
  const waiting = new Map<
    number,
    { resolve(value: NativeWorkerValue): void; reject(error: Error): void }
  >();
  let sequence = 1;
  const runtime = createBitwardenNativeWorkerRuntime(
    {
      send(reply) {
        const operation = waiting.get(reply.id);
        waiting.delete(reply.id);
        if (reply.ok) operation?.resolve(reply.value);
        else
          operation?.reject(new SecretBackendError(reply.code, reply.message));
      },
      close() {
        owner.abort();
        for (const operation of waiting.values())
          operation.reject(
            new SecretBackendError("stale", "The owned runtime ended."),
          );
        waiting.clear();
      },
    },
    guardSecretBackendTransport(transport, undefined, owner.signal),
    NATIVE_LIMITS,
  );
  const send = (request: NativeWorkerRequest) =>
    new Promise<NativeWorkerValue>((resolve, reject) => {
      waiting.set(request.id, { resolve, reject });
      runtime.receive(request);
    });
  const dispose = () => {
    transport.signal.removeEventListener("abort", dispose);
    owner.abort();
    void runtime.dispose();
  };
  transport.signal.addEventListener("abort", dispose, { once: true });
  closures.push(async () => {
    dispose();
    await runtime.dispose();
  });
  try {
    await send({ id: sequence, type: "initialize", settings });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    closed: owner.signal,
    dispose,
    invoke: (command: NativeWorkerCommand) =>
      send({ ...command, id: ++sequence }),
  };
}
type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
function configuration(fixture: Fixture): BitwardenNativeConfiguration {
  return {
    providerId: fixture.modern ? "bitwarden" : "vaultwarden",
    name: "Owned native common port",
    mode: "bitwarden-api",
    ...fixture.credentials,
    accountEmail: fixture.credentials.email,
    masterPassword: NATIVE_PASSWORD,
    token: "",
    vaultId: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    passwordListId: "",
    fileFormat: "",
  };
}
it.each([false, true])(
  "uses the common normalized port for real encrypted personal HTTP CRUD modern=%s",
  async (modern) => {
    const fixture = await nativeHttpFixture(modern);
    closures.push(fixture.close);
    const backend = createBitwardenNativeBrowserBackend(
      fixture.transport,
      runtimeClient,
    );
    const input = configuration(fixture);
    const session = await backend.authenticate(input);
    closures.push(() => backend.disconnect(session));
    expect(backend.capabilities).toBe(bitwardenNativeCapabilities);
    expect(JSON.stringify(session)).not.toContain(NATIVE_PASSWORD);
    expect(Object.isFrozen(session)).toBe(true);
    expect(input.masterPassword).toBe(NATIVE_PASSWORD);
    for (const kind of ["note", "login", "secret"] as const) {
      const item = {
        kind,
        name: `Native proxy ${kind} 🔐`,
        notes: "Normalized confidential note",
        secret: "Normalized private value",
        username: "owned",
        url: "https://owned.example/",
      };
      const created = await backend.createItem?.(item, session);
      if (!created) throw new Error("Required create missing.");
      expect(created).toMatchObject({
        name: item.name,
        notes: item.notes,
        secret: item.secret,
        kind,
      });
      expect(fixture.decoded.get(created.id)?.get("name")).toBe(item.name);
      expect(await backend.getItem(created.name, session)).toEqual(created);
      expect(await backend.getNotes(created.id, session)).toBe(item.notes);
      expect(
        await backend.updateItem?.(
          created.id,
          { ...item, notes: "Updated common worker port" },
          session,
        ),
      ).toMatchObject({ id: created.id, notes: "Updated common worker port" });
      await backend.deleteItem?.(created.id, session);
    }
    expect(await backend.listItems(session)).toEqual([]);
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await backend.disconnect(session);
    expect(session.signal?.aborted).toBe(true);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
  },
);
it("requires transient unlock fields and a personal target before touching the provider", async () => {
  const fixture = await nativeHttpFixture(false);
  closures.push(fixture.close);
  const backend = createBitwardenNativeBrowserBackend(
    fixture.transport,
    runtimeClient,
  );
  const input = configuration(fixture);
  const missingUnlock = { ...input, masterPassword: "" };
  await expect(backend.authenticate(missingUnlock)).rejects.toMatchObject({
    code: "configuration",
  });
  await expect(
    backend.authenticate({
      ...input,
      organizationId: "organization-not-personal",
    }),
  ).rejects.toMatchObject({ code: "configuration" });
  await expect(
    backend.authenticate({ ...input, vaultId: "wrong-folder" }),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fixture.requests).toEqual([]);
});
it("retires the common handle when its captured capability ends without borrowing another connection", async () => {
  const fixture = await nativeHttpFixture(true);
  closures.push(fixture.close);
  const backend = createBitwardenNativeBrowserBackend(
    fixture.transport,
    runtimeClient,
  );
  const session = await backend.authenticate(configuration(fixture));
  closures.push(() => backend.disconnect(session));
  const count = fixture.requests.length;
  fixture.controller.abort();
  expect(session.signal?.aborted).toBe(true);
  await expect(backend.listItems(session)).rejects.toThrow();
  expect(fixture.requests).toHaveLength(count);
});
it("closes the exact client when a valid IPC value has the wrong operation shape", async () => {
  const fixture = await nativeHttpFixture(false);
  closures.push(fixture.close);
  const owner = new AbortController();
  const backend = createBitwardenNativeBrowserBackend(
    fixture.transport,
    async () => ({
      closed: owner.signal,
      invoke: async () => "not an item list",
      dispose: () => owner.abort(),
    }),
  );
  const session = await backend.authenticate(configuration(fixture));
  await expect(backend.listItems(session)).rejects.toMatchObject({
    code: "response",
  });
  expect(owner.signal.aborted).toBe(true);
  expect(session.signal?.aborted).toBe(true);
});

it.each([false, true])(
  "completes intentional native probe disposal without reporting provider loss modern=%s",
  async (modern) => {
    const fixture = await nativeHttpFixture(modern);
    closures.push(fixture.close);
    const backend = createBitwardenNativeBrowserBackend(
      fixture.transport,
      runtimeClient,
    );
    const session = await backend.authenticate(configuration(fixture));
    closures.push(() => backend.disconnect(session));
    const lease = new AbortController();
    await disposeSecretBackendProbe(
      { backend, session },
      {
        signal: lease.signal,
        current: () => !lease.signal.aborted,
        check: () => lease.signal.throwIfAborted(),
        close: () => lease.abort(),
      },
    );
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(session.signal?.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
  },
);

it("keeps actual native provider loss distinct from intentional probe cleanup", async () => {
  const fixture = await nativeHttpFixture(true);
  closures.push(fixture.close);
  const backend = createBitwardenNativeBrowserBackend(
    fixture.transport,
    runtimeClient,
  );
  const session = await backend.authenticate(configuration(fixture));
  closures.push(() => backend.disconnect(session));
  fixture.controller.abort();
  expect(secretBackendSessionClosure(session)).toBe("provider-ended");
  const lease = new AbortController();
  await expect(
    disposeSecretBackendProbe(
      { backend, session },
      {
        signal: lease.signal,
        current: () => !lease.signal.aborted,
        check: () => lease.signal.throwIfAborted(),
        close: () => lease.abort(),
      },
    ),
  ).rejects.toMatchObject({ code: "stale" });
  expect(secretBackendSessionClosure(session)).toBe("provider-ended");
});
