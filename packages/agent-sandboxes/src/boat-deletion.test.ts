import { expect, it } from "vitest";
import {
  BoatClient,
  BoatDeletionPendingError,
  BoatDeletionUnconfirmedError,
  type BoatJsonValue,
} from "./boat-client.js";
import { BoatSandboxProvider } from "./boat-provider.js";

it("resumes a previously accepted deletion with the provider's credential", async () => {
  const id = "bdop_0123456789abcdef0123456789abcdef";
  let authorization = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        ok: true,
        operation: {
          id,
          kind: "sandbox",
          targetId: "bx_23456789",
          status: "completed",
        },
      }),
      { status: 200 },
    );
  };
  const client = new BoatClient({
    origin: "https://boat.test",
    fetchImpl,
    deletionPollIntervalMs: 1,
  });
  const provider = new BoatSandboxProvider({ client, apiToken: "boat-key" });
  await provider.waitForDeletion("bx_23456789", id);
  expect(authorization).toBe("Bearer boat-key");
});

it("preserves a resumable deletion receipt when failed allocation cleanup is pending", async () => {
  const id = "bdop_0123456789abcdef0123456789abcdef";
  let completed = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    let body: BoatJsonValue;
    if (path === "/api/v1/sandboxes")
      body = {
        ok: true,
        sandbox: { id: "bx_23456789", state: "provisioning" },
      };
    else if (path.endsWith("/commands"))
      body = { ok: true, type: "command.started", success: true, processId: 1 };
    else if (path.endsWith("/host"))
      body = {
        ok: true,
        port: 8787,
        isProtected: true,
        access: "private",
        url: "https://other-8787.on.boat.dev?_token=hidden",
      };
    else if (init?.method === "DELETE" || path.includes("deletion-operations"))
      body = {
        ok: true,
        operation: {
          id,
          kind: "sandbox",
          targetId: "bx_23456789",
          status: completed ? "completed" : "pending",
        },
      };
    else
      body = {
        ok: true,
        sandbox: {
          id: "bx_23456789",
          state: "ready",
          url: "https://machine.on.boat.dev",
        },
      };
    return new Response(JSON.stringify(body), {
      status: init?.method === "DELETE" ? 202 : 200,
    });
  };
  const client = new BoatClient({
    origin: "https://boat.test",
    fetchImpl,
    deletionTimeoutMs: 100,
    deletionPollIntervalMs: 1,
  });
  const provider = new BoatSandboxProvider({
    client,
    origin: "https://boat.test",
    apiToken: "boat-key",
    agentCommand: "agent",
  });
  let observed: Error | null = null;
  try {
    await provider.allocate({ origin: "https://accounts.example.test" });
  } catch (error) {
    if (error instanceof Error) observed = error;
    else throw error;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  if (!(observed instanceof AggregateError))
    throw new Error("expected cleanup aggregate");
  const pending = observed.errors.find(
    (item) => item instanceof BoatDeletionPendingError,
  );
  expect(pending).toBeInstanceOf(BoatDeletionPendingError);
  if (!(pending instanceof BoatDeletionPendingError))
    throw new Error("missing deletion receipt");
  expect(pending.operationId).toBe(id);
  completed = true;
  await provider.waitForDeletion(pending.sandboxId, pending.operationId);
});

it.each(["reject", "malformed", "mismatch", "stall"] as const)(
  "keeps the sandbox ID when the initial DELETE is %s",
  async (mode) => {
    const fetchImpl: typeof fetch = async (_input, _init) => {
      if (mode === "reject") throw new Error("transport failure");
      if (mode === "stall") return new Promise<Response>(() => {});
      if (mode === "malformed")
        return new Response("invalid JSON", { status: 202 });
      return new Response(
        JSON.stringify({
          ok: true,
          operation: {
            id: "bdop_0123456789abcdef0123456789abcdef",
            kind: "sandbox",
            targetId: "bx_98765432",
            status: "pending",
          },
        }),
        { status: 202 },
      );
    };
    const client = new BoatClient({
      origin: "https://boat.test",
      fetchImpl,
      deletionRequestTimeoutMs: 30,
    });
    let caught: Error | null = null;
    try {
      await client.deleteSandbox("boat-key", "bx_23456789");
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }
    expect(caught).toBeInstanceOf(BoatDeletionUnconfirmedError);
    if (!(caught instanceof BoatDeletionUnconfirmedError))
      throw new Error("missing cleanup identity");
    expect(caught.sandboxId).toBe("bx_23456789");
  },
);

it("exposes the sandbox ID if allocation fails and the DELETE receipt is unavailable", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    let body: BoatJsonValue;
    if (path === "/api/v1/sandboxes")
      body = {
        ok: true,
        sandbox: { id: "bx_23456789", state: "provisioning" },
      };
    else if (path.endsWith("/commands"))
      body = { ok: true, type: "command.started", success: true, processId: 1 };
    else if (path.endsWith("/host"))
      body = {
        ok: true,
        port: 8787,
        isProtected: true,
        access: "private",
        url: "https://other-8787.on.boat.dev?_token=hidden",
      };
    else if (init?.method === "DELETE")
      throw new Error("network failure after DELETE");
    else
      body = {
        ok: true,
        sandbox: {
          id: "bx_23456789",
          state: "ready",
          url: "https://machine.on.boat.dev",
        },
      };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const client = new BoatClient({ origin: "https://boat.test", fetchImpl });
  const provider = new BoatSandboxProvider({
    client,
    origin: "https://boat.test",
    apiToken: "boat-key",
    agentCommand: "agent",
  });
  let caught: Error | null = null;
  try {
    await provider.allocate({ origin: "https://accounts.example.test" });
  } catch (error) {
    if (error instanceof Error) caught = error;
    else throw error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError))
    throw new Error("expected cleanup aggregate");
  const unconfirmed = caught.errors.find(
    (item) => item instanceof BoatDeletionUnconfirmedError,
  );
  expect(unconfirmed).toBeInstanceOf(BoatDeletionUnconfirmedError);
  if (!(unconfirmed instanceof BoatDeletionUnconfirmedError))
    throw new Error("missing sandbox identity");
  expect(unconfirmed.sandboxId).toBe("bx_23456789");
});
