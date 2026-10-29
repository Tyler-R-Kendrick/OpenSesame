import { describe, expect, it } from "vitest";
import {
  BoatApiError,
  BoatClient,
  type BoatClientOptions,
  BoatDeletionPendingError,
  type BoatJsonValue,
} from "./boat-client.js";

async function captureError<T>(run: () => Promise<T>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected the operation to reject");
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Handler = (request: RecordedRequest) => {
  status?: number;
  body: BoatJsonValue;
};

function fakeClient(
  handler: Handler,
  options: Partial<BoatClientOptions> = {},
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    };
    requests.push(request);
    const { status = 200, body } = handler(request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    // SAFETY: checked at the fake-fetch boundary: the mock implements exactly the (url, init) call shapes the client sends.
    client: new BoatClient({
      ...options,
      origin: "https://boat.test",
      fetchImpl: fetchImpl as typeof fetch,
    }),
    requests,
  };
}

describe("BoatClient", () => {
  it("creates a confined one-run sandbox with an idempotency key", async () => {
    const { client, requests } = fakeClient(() => ({
      status: 202,
      body: {
        ok: true,
        type: "sandbox.created",
        sandbox: { id: "bx_23456789", state: "provisioning" },
      },
    }));
    const sandbox = await client.createSandbox("boat_key", {
      labels: { opensesame: "password-reset" },
      env: { OPENSESAME_RELAY_TOKEN: "relay-token" },
    });
    expect(sandbox).toEqual({ id: "bx_23456789", state: "provisioning" });
    const request = requests[0];
    expect(request?.url).toBe("https://boat.test/api/v1/sandboxes");
    expect(request?.headers.get("authorization")).toBe(
      ["Bearer", "boat_key"].join(" "),
    );
    expect(request?.headers.get("idempotency-key")).toBeTruthy();
    // One-run confinement: none of the account's secrets, no retained
    // command output, no snapshot that could resurrect session cookies.
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      ttlSeconds: 3600,
      type: "small",
      noEnv: true,
      monitoring: false,
      snapshots: false,
      labels: { opensesame: "password-reset" },
      env: { OPENSESAME_RELAY_TOKEN: "relay-token" },
    });
  });

  it("extracts stable error codes from the envelope", async () => {
    const { client } = fakeClient(() => ({
      status: 403,
      body: {
        ok: false,
        type: "sandbox.error",
        status: 403,
        code: "claim_required",
        message: "Claim this agent first",
        error: { code: "claim_required", message: "Claim this agent first" },
      },
    }));
    const error = await captureError(() => client.createSandbox("boat_pre"));
    expect(error).toBeInstanceOf(BoatApiError);
    // SAFETY: checked immediately above with toBeInstanceOf on the same value.
    const apiError = error as BoatApiError;
    expect(apiError.code).toBe("claim_required");
    expect(apiError.status).toBe(403);
  });

  it("runs detached commands, hosts ports, and deletes sandboxes", async () => {
    const { client, requests } = fakeClient((request) => {
      if (request.url.endsWith("/commands"))
        return {
          body: {
            ok: true,
            type: "command.started",
            success: true,
            processId: 42,
          },
        };
      if (request.url.endsWith("/host"))
        return {
          body: {
            ok: true,
            url: "https://bx-8787.on.boat.dev?_token=hidden",
            port: 8787,
            isProtected: true,
            access: "private",
          },
        };
      return {
        body: {
          ok: true,
          operation: {
            id: "bdop_0123456789abcdef0123456789abcdef",
            kind: "sandbox",
            targetId: "bx_23456789",
            status: "completed",
          },
        },
      };
    });
    await expect(
      client.startDetachedCommand("boat_key", "bx_23456789", "run-agent"),
    ).resolves.toEqual({ processId: 42 });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      command: "run-agent",
      detached: true,
    });
    await expect(
      client.hostPort("boat_key", "bx_23456789", 8787),
    ).resolves.toBe("https://bx-8787.on.boat.dev?_token=hidden");
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      port: 8787,
      localhost: true,
    });
    await client.deleteSandbox("boat_key", "bx_23456789");
    expect(requests[2]?.method).toBe("DELETE");
    expect(requests[2]?.headers.get("x-ascii-confirm-delete")).toBe(
      "bx_23456789",
    );
  });

  it("refuses a mismatched sandbox identity and an unprotected or wrong port", async () => {
    const { client: mismatch } = fakeClient(() => ({
      body: { ok: true, sandbox: { id: "bx_98765432", state: "ready" } },
    }));
    await expect(
      mismatch.getSandbox("boat_key", "bx_23456789"),
    ).rejects.toThrow("identity mismatch");
    for (const hosted of [
      {
        ok: true,
        url: "https://a-8787.on.boat.dev",
        port: 8787,
        isProtected: false,
        access: "public",
      },
      {
        ok: true,
        url: "https://a-1234.on.boat.dev?_token=t",
        port: 1234,
        isProtected: true,
        access: "private",
      },
    ]) {
      const { client } = fakeClient(() => ({ body: hosted }));
      await expect(
        client.hostPort("boat_key", "bx_23456789", 8787),
      ).rejects.toThrow();
    }
  });

  it("waits for the exact accepted deletion operation to finish", async () => {
    const id = "bdop_0123456789abcdef0123456789abcdef";
    let polls = 0;
    const { client, requests } = fakeClient(
      (request) => ({
        status: request.method === "DELETE" ? 202 : 200,
        body: {
          ok: true,
          operation: {
            id,
            kind: "sandbox",
            targetId: "bx_23456789",
            status:
              request.method === "DELETE" || ++polls === 1
                ? "pending"
                : "completed",
          },
        },
      }),
      { deletionTimeoutMs: 1_000, deletionPollIntervalMs: 1 },
    );
    await client.deleteSandbox("boat_key", "bx_23456789");
    expect(polls).toBe(2);
    expect(requests[0]?.headers.get("x-ascii-confirm-delete")).toBe(
      "bx_23456789",
    );
    expect(requests[1]?.url).toBe(
      `https://boat.test/api/v1/deletion-operations/${id}`,
    );
  });

  it("reports a resumable pending deletion when blocked, wrong, or unavailable", async () => {
    const id = "bdop_0123456789abcdef0123456789abcdef";
    for (const mode of ["blocked", "wrong", "unavailable"] as const) {
      const { client } = fakeClient(
        (request) => {
          if (request.method !== "DELETE" && mode === "unavailable")
            throw new Error("network unavailable");
          return {
            status: request.method === "DELETE" ? 202 : 200,
            body: {
              ok: true,
              operation: {
                id,
                kind: "sandbox",
                targetId:
                  request.method !== "DELETE" && mode === "wrong"
                    ? "bx_98765432"
                    : "bx_23456789",
                status: request.method === "DELETE" ? "pending" : "blocked",
              },
            },
          };
        },
        { deletionTimeoutMs: 10, deletionPollIntervalMs: 1 },
      );
      const error = await captureError(() =>
        client.deleteSandbox("boat_key", "bx_23456789"),
      );
      expect(error).toBeInstanceOf(BoatDeletionPendingError);
      // SAFETY: this branch has just established the exact error class.
      const pending = error as BoatDeletionPendingError;
      expect(pending.operationId).toBe(id);
      expect(pending.sandboxId).toBe("bx_23456789");
    }
  });

  it("bounds a stalled deletion poll and returns its resumable operation ID", async () => {
    const id = "bdop_0123456789abcdef0123456789abcdef";
    const request: typeof fetch = async (_input, init) => {
      if (init?.method === "DELETE")
        return new Response(
          JSON.stringify({
            ok: true,
            operation: {
              id,
              kind: "sandbox",
              targetId: "bx_23456789",
              status: "pending",
            },
          }),
          { status: 202 },
        );
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    };
    const client = new BoatClient({
      origin: "https://boat.test",
      deletionTimeoutMs: 20,
      deletionPollIntervalMs: 1,
      fetchImpl: request,
    });
    const error = await captureError(() =>
      client.deleteSandbox("boat_key", "bx_23456789"),
    );
    expect(error).toBeInstanceOf(BoatDeletionPendingError);
    // SAFETY: the error class was checked immediately above.
    expect((error as BoatDeletionPendingError).operationId).toBe(id);
  });

  it("starts billing checkout outside /api/v1", async () => {
    const { client, requests } = fakeClient(() => ({
      body: { url: "https://checkout.stripe.com/session" },
    }));
    await expect(client.createCheckout("boat_key")).resolves.toBe(
      "https://checkout.stripe.com/session",
    );
    expect(requests[0]?.url).toBe(
      "https://boat.test/api/boat/billing/checkout",
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      kind: "subscription",
    });
  });
});
