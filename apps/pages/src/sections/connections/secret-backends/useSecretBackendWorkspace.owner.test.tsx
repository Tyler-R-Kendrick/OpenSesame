/** @vitest-environment jsdom */
import { secretHttpFixture } from "@opensesame/app-core/lib/secret-backends/onepassword-http.test-support.js";
import { createOnePasswordConnectBackend } from "@opensesame/app-core/lib/secret-backends/onepassword.js";
import type {
  SecretBackendConfiguration,
  SecretBackendItemInput,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSecretBackendWorkspace } from "./useSecretBackendWorkspace.js";

function latch<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Latch not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: (value: T) => finish(value) };
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const close of closers.splice(0)) await close();
});
function configuration(baseUrl: string): SecretBackendConfiguration {
  return {
    providerId: "onepassword",
    name: "Owned Connect",
    mode: "onepassword-connect",
    baseUrl,
    token: "owned-test-token",
    vaultId: "owned-vault",
    projectId: "",
    organizationId: "",
    identityUrl: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}
const input: SecretBackendItemInput = {
  name: "Actual provider note",
  kind: "note",
  notes: "Actual HTTP value",
  secret: "",
};
async function fixture(method: "POST" | "GET") {
  const entered = latch<void>();
  const release = latch<void>();
  const completed = latch<void>();
  const provider = new AbortController();
  const listCalls: string[] = [];
  const root = "/v1/vaults/owned-vault/items";
  let held = false;
  const items = [
    {
      id: "existing",
      title: "Existing note",
      category: "SECURE_NOTE",
      fields: [{ id: "notesPlain", value: "Existing actual notes" }],
      version: 1,
    },
  ];
  const server = await secretHttpFixture(async (request) => {
    if (request.headers.authorization !== "Bearer owned-test-token")
      return { status: 401 };
    if (request.path === "/v1/vaults/owned-vault")
      return { body: '{"id":"owned-vault"}' };
    if (!request.path.startsWith(root)) return { status: 404 };
    if (request.method === method && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    if (request.method === "GET" && request.path === root)
      return { body: JSON.stringify(items) };
    if (request.method === "GET" && request.path === `${root}/existing`)
      return { body: JSON.stringify(items[0]) };
    if (request.method === "POST" && request.path === root) {
      const body = JSON.parse(request.body);
      const item = { ...body, id: "created", version: 1 };
      items.push(item);
      return { status: 201, body: JSON.stringify(item) };
    }
    return { status: 405 };
  });
  closers.push(server.close);
  const backend = createOnePasswordConnectBackend();
  Object.defineProperty(backend, "signal", { value: provider.signal });
  const session = await backend.authenticate(configuration(server.url));
  const create = backend.createItem?.bind(backend);
  if (!create) throw new Error("Actual Connect adapter has no create method");
  async function observed<T>(operation: Promise<T>) {
    try {
      return await operation;
    } finally {
      completed.resolve();
    }
  }
  backend.createItem = (draft, presented) => observed(create(draft, presented));
  const list = backend.listItems.bind(backend);
  const read = backend.getItem.bind(backend);
  const notes = backend.getNotes.bind(backend);
  backend.listItems = (presented) => {
    listCalls.push(presented.id);
    return observed(list(presented));
  };
  backend.getItem = (id, presented) => observed(read(id, presented));
  backend.getNotes = (id, presented) => observed(notes(id, presented));
  return {
    backend,
    session,
    provider,
    entered,
    release,
    completed,
    server,
    root,
    listCalls,
  };
}

it("retains an in-flight operation across unchanged signal renders and refreshes the actual provider result", async () => {
  const value = await fixture("POST");
  const onFlash = vi.fn();
  const view = renderHook(() => useSecretBackendWorkspace(value, onFlash));
  act(() => view.result.current.save(input));
  await value.entered.promise;
  expect(view.result.current.busy).toBe(true);
  view.rerender();
  expect(view.result.current.busy).toBe(true);
  await act(async () => {
    value.release.resolve();
    await value.completed.promise;
  });
  await waitFor(() =>
    expect(view.result.current.result).toBe("Backend item saved"),
  );
  expect(view.result.current.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "created", name: input.name }),
    ]),
  );
  expect(value.server.requests.map((row) => row.method)).toEqual([
    "GET",
    "POST",
    "GET",
  ]);
  expect(onFlash).not.toHaveBeenCalled();
});

it.each(["clear", "backend", "session", "replacement", "unmount"] as const)(
  "does not issue a late authenticated refresh or publish success after %s withdraws a held real create",
  async (withdrawal) => {
    const value = await fixture("POST");
    const onFlash = vi.fn();
    const view = renderHook(
      ({ handle }) => useSecretBackendWorkspace(handle, onFlash),
      {
        initialProps: {
          handle: { backend: value.backend, session: value.session },
        },
      },
    );
    act(() => view.result.current.save(input));
    await value.entered.promise;
    expect(view.result.current.busy).toBe(true);
    if (withdrawal === "unmount") view.unmount();
    else if (withdrawal === "clear") act(() => view.result.current.clear());
    else if (withdrawal === "backend") act(() => value.provider.abort());
    else if (withdrawal === "session")
      await act(() => value.backend.disconnect(value.session));
    else {
      const next = await value.backend.authenticate(
        configuration(value.server.url),
      );
      view.rerender({ handle: { backend: value.backend, session: next } });
    }
    await act(async () => {
      value.release.resolve();
      await value.completed.promise;
    });
    // The real port-start witness precedes any asynchronous socket send.
    expect(value.listCalls).toEqual([]);
    // The remote write may finish; the UI must not start another authenticated operation.
    expect(
      value.server.requests
        .filter((row) => row.path === value.root)
        .map((row) => row.method),
    ).toEqual(["POST"]);
    if (withdrawal !== "unmount") {
      expect(view.result.current.items).toEqual([]);
      expect(view.result.current.selected).toBeNull();
      expect(view.result.current.result).toBe("");
      expect(view.result.current.failure).toBe("");
      expect(view.result.current.busy).toBe(false);
    }
    expect(onFlash).not.toHaveBeenCalled();
  },
);

it.each(["list", "read", "notes"] as const)(
  "does not commit stale %s state after clear during actual HTTP",
  async (operation) => {
    const value = await fixture("GET");
    const onFlash = vi.fn();
    const view = renderHook(() => useSecretBackendWorkspace(value, onFlash));
    act(() => {
      if (operation === "list") view.result.current.list();
      else if (operation === "read") view.result.current.read("existing");
      else view.result.current.readNotes("existing");
    });
    await value.entered.promise;
    act(() => view.result.current.clear());
    // Await the actual adapter's complete return boundary, not merely server receipt.
    await act(async () => {
      value.release.resolve();
      await value.completed.promise;
    });
    expect(view.result.current.items).toEqual([]);
    expect(view.result.current.selected).toBeNull();
    expect(view.result.current.notes).toBeNull();
    expect(view.result.current.result).toBe("");
    expect(onFlash).not.toHaveBeenCalled();
  },
);
