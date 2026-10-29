import { describe, expect, it } from "vitest";
import { BoatApiError, BoatClient, type BoatJsonValue } from "./boat-client.js";

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

function fakeClient(handler: Handler) {
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
          },
        };
      return { body: { ok: true } };
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
  });

  it("starts billing checkout outside /api/v1", async () => {
    const { client, requests } = fakeClient(() => ({
      body: { url: "https://checkout.test/session" },
    }));
    await expect(client.createCheckout("boat_key")).resolves.toBe(
      "https://checkout.test/session",
    );
    expect(requests[0]?.url).toBe(
      "https://boat.test/api/boat/billing/checkout",
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      kind: "subscription",
    });
  });
});
