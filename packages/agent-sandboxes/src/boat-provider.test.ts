import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOAT_AGENT_ENV } from "./boat-agent.js";
import type { BoatJsonValue } from "./boat-client.js";

async function captureError<T>(run: () => Promise<T>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected the operation to reject");
}
import { BoatSandboxProvider } from "./boat-provider.js";
import { type RunningRelayServer, startRelayServer } from "./relay-server.js";
import { SandboxClaimRequiredError } from "./types.js";

const CLAIM = {
  user_code: "123456",
  verification_uri:
    "http://127.0.0.1:12345/api/boat/agent/identity/claim?claim_attempt_token=x",
  expires_in: 600,
  interval: 5,
};

interface RecordedRequest {
  path: string;
  method: string;
  authorization: string;
  body: string;
}

class StubDriver implements BrowserDriver {
  readonly secrets: string[] = [];

  async open(): Promise<void> {}

  async snapshot(): Promise<Observation> {
    return {
      id: "obs-1",
      origin: "https://accounts.example.test",
      fields: [{ ref: "e1", kind: "password", label: "New password" }],
    };
  }

  async click(): Promise<void> {}

  async fill(): Promise<void> {}

  async fillSecret(_ref: string, value: string): Promise<void> {
    this.secrets.push(value);
  }

  async pageUrl(): Promise<string> {
    return "https://accounts.example.test/reset";
  }

  async close(): Promise<void> {}
}

interface CreateBody {
  env?: Record<string, string>;
}

function errorEnvelope(status: number, code: string) {
  return {
    ok: false,
    type: "sandbox.error",
    status,
    code,
    message: code,
    error: { code, message: code },
  };
}

function fakeBoat(wrongRelayToken = false) {
  const state = { claimed: false, billed: false };
  const requests: RecordedRequest[] = [];
  const driver = new StubDriver();
  let relay: RunningRelayServer | null = null;
  let relayToken = "";

  const respond = (body: BoatJsonValue, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const authRoute = (path: string): Response | null => {
    if (path === "/api/boat/agent/identity")
      return respond({ claim_token: "clm_1", claim: CLAIM });
    if (path === "/api/boat/oauth2/token")
      return state.claimed
        ? respond({ access_token: "boat_live" })
        : respond({ error: "authorization_pending" }, 400);
    if (path === "/api/boat/billing/checkout")
      return respond({ url: "https://checkout.stripe.com/session" });
    return null;
  };

  const createRoute = (body: string): Response => {
    if (!state.billed)
      return respond(errorEnvelope(402, "billing_required"), 402);
    // SAFETY: checked at the fake Boat boundary: the only sender is this test's BoatClient, which serializes CreateSandboxBody objects.
    const create = JSON.parse(body) as CreateBody;
    relayToken = create.env?.[BOAT_AGENT_ENV.token] ?? "";
    return respond(
      {
        ok: true,
        sandbox: { id: "bx_23456789", state: "provisioning" },
      },
      202,
    );
  };

  const sandboxRoute = async (
    path: string,
    method: string,
    body: string,
  ): Promise<Response | null> => {
    if (path === "/api/v1/sandboxes" && method === "POST")
      return createRoute(body);
    if (path === "/api/v1/sandboxes/bx_23456789" && method === "GET")
      return respond({
        ok: true,
        sandbox: {
          id: "bx_23456789",
          state: "ready",
          url: "http://127.0.0.1:12345",
        },
      });
    if (path.endsWith("/commands")) {
      relay = await startRelayServer({
        port: 8787,
        token: wrongRelayToken ? "wrong-token" : relayToken,
        driver,
      });
      return respond({
        ok: true,
        type: "command.started",
        success: true,
        processId: 7,
      });
    }
    if (path.endsWith("/host"))
      return respond({
        ok: true,
        url: `http://127.0.0.1:${relay?.port ?? 0}`,
        port: 8787,
        isProtected: true,
        access: "private",
      });
    if (method === "DELETE")
      return respond({
        ok: true,
        operation: {
          id: "bdop_0123456789abcdef0123456789abcdef",
          kind: "sandbox",
          targetId: "bx_23456789",
          status: "completed",
        },
      });
    return null;
  };

  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    requests.push({
      path,
      method,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body,
    });
    const response =
      authRoute(path) ?? (await sandboxRoute(path, method, body));
    if (response) return response;
    throw new Error(`unexpected boat request: ${method} ${path}`);
  };

  return {
    state,
    requests,
    driver,
    // SAFETY: checked at the fake-fetch boundary: the mock implements exactly the (url, init) call shapes the Boat clients send.
    provider: new BoatSandboxProvider({
      origin: "http://127.0.0.1:12345",
      fetchImpl: fetchImpl as typeof fetch,
      claimEmail: "person@example.test",
      agentCommand: "opensesame-boat-agent",
      pollIntervalMs: 1,
    }),
    closeRelay: async () => {
      await relay?.close();
    },
  };
}

describe("BoatSandboxProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to allocate without an agent start command", async () => {
    vi.stubEnv("BOAT_RELAY_AGENT_COMMAND", "");
    const provider = new BoatSandboxProvider({ apiToken: "boat_key" });
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("agent start command");
  });

  it("refuses an unrelated hosted port and cleans up before any relay connection", async () => {
    const { createServer } = await import("node:http");
    let sinkConnections = 0;
    const sink = createServer((_request, response) => {
      sinkConnections += 1;
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    try {
      const address = sink.address();
      if (!(address instanceof Object)) throw new Error("missing sink address");
      let deleted = false;
      const fakeFetch: typeof fetch = async (input, init) => {
        const path = new URL(
          input instanceof Request ? input.url : input.toString(),
        ).pathname;
        let body: BoatJsonValue;
        if (path === "/api/v1/sandboxes" && init?.method === "POST")
          body = {
            ok: true,
            sandbox: { id: "bx_23456789", state: "provisioning" },
          };
        else if (path.endsWith("/commands"))
          body = {
            ok: true,
            type: "command.started",
            success: true,
            processId: 7,
          };
        else if (path.endsWith("/host"))
          body = {
            ok: true,
            port: 8787,
            isProtected: true,
            access: "private",
            url: `http://127.0.0.1:${address.port}`,
          };
        else if (init?.method === "DELETE") {
          deleted = true;
          expect(new Headers(init.headers).get("x-ascii-confirm-delete")).toBe(
            "bx_23456789",
          );
          body = {
            ok: true,
            operation: {
              id: "bdop_0123456789abcdef0123456789abcdef",
              kind: "sandbox",
              targetId: "bx_23456789",
              status: "completed",
            },
          };
        } else
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
      const provider = new BoatSandboxProvider({
        origin: "https://boat.test",
        apiToken: "boat-key",
        agentCommand: "agent",
        fetchImpl: fakeFetch,
      });
      await expect(
        provider.allocate({ origin: "https://accounts.example.test" }),
      ).rejects.toThrow("invalid hosted relay destination");
      expect(sinkConnections).toBe(0);
      expect(deleted).toBe(true);
    } finally {
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });

  it("rejects relay authentication failure before allocation and deletes the sandbox", async () => {
    const boat = fakeBoat(true);
    try {
      await expect(
        boat.provider.allocate({ origin: "https://accounts.example.test" }),
      ).rejects.toBeInstanceOf(SandboxClaimRequiredError);
      boat.state.claimed = true;
      boat.state.billed = true;
      await expect(
        boat.provider.allocate({ origin: "https://accounts.example.test" }),
      ).rejects.toThrow("relay authentication failed");
      expect(
        boat.requests.some(
          (entry) =>
            entry.method === "DELETE" &&
            entry.path === "/api/v1/sandboxes/bx_23456789",
        ),
      ).toBe(true);
    } finally {
      await boat.closeRelay();
    }
  });

  it("walks claim, then billing, then drives the relay with no secrets in commands", async () => {
    const boat = fakeBoat();
    const request = { origin: "https://accounts.example.test" };
    try {
      // 1. No account at all: the claim ceremony surfaces as a human
      // intervention carrying only the link and code.
      const claimError = await captureError(() =>
        boat.provider.allocate(request),
      );
      expect(claimError).toBeInstanceOf(SandboxClaimRequiredError);
      // SAFETY: checked immediately above with toBeInstanceOf on the same value.
      const claim = claimError as SandboxClaimRequiredError;
      expect(claim.verificationUri).toBe(CLAIM.verification_uri);
      expect(claim.userCode).toBe("123456");

      // 2. Claimed, but no card on file: the checkout URL surfaces the
      // same way.
      boat.state.claimed = true;
      const billingError = await captureError(() =>
        boat.provider.allocate(request),
      );
      expect(billingError).toBeInstanceOf(SandboxClaimRequiredError);
      // SAFETY: checked immediately above with toBeInstanceOf on the same value.
      const billing = billingError as SandboxClaimRequiredError;
      expect(billing.verificationUri).toBe(
        "https://checkout.stripe.com/session",
      );

      // 3. Billed: allocation completes and the browser is the relay.
      boat.state.billed = true;
      const sandbox = await boat.provider.allocate(request);
      expect(sandbox.provider).toBe("boat");
      expect(sandbox.session).toBe("bx_23456789");
      expect(sandbox.takeoverUrl).toBeUndefined();
      const snapshot = await sandbox.browser.snapshot();
      expect(snapshot.fields).toHaveLength(1);
      await sandbox.browser.fillSecret("e1", "provider-secret-value");
      expect(boat.driver.secrets).toEqual(["provider-secret-value"]);
      await sandbox.close();

      // Every Boat API body ever sent is secret-free; the only command
      // is the operator's agent start command.
      const allBodies = boat.requests.map((entry) => entry.body).join("\n");
      expect(allBodies).not.toContain("provider-secret-value");
      const commands = boat.requests.filter((entry) =>
        entry.path.endsWith("/commands"),
      );
      expect(commands).toHaveLength(1);
      expect(JSON.parse(commands[0]?.body ?? "{}")).toEqual({
        command: "opensesame-boat-agent",
        detached: true,
      });
      expect(
        boat.requests.some(
          (entry) =>
            entry.method === "DELETE" &&
            entry.path === "/api/v1/sandboxes/bx_23456789",
        ),
      ).toBe(true);
    } finally {
      await boat.closeRelay();
    }
  });
});
