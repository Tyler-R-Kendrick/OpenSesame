import { type Server, createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  BOAT_AGENT_ENV,
  type BoatJsonValue,
  BoatSandboxProvider,
  type RunningBoatAgent,
  SandboxClaimRequiredError,
  startBoatRelayAgent,
} from "../src/index.js";

async function captureError<T>(run: () => Promise<T>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected the operation to reject");
}
import {
  PEPPER,
  expectNewPasswordAccepted,
  runtimeForDriver,
} from "./harness.js";
import { MockResetSite } from "./mock-site.js";

const CLAIM = {
  user_code: "123456",
  verification_uri: "/api/boat/agent/identity/claim?claim_attempt_token=x",
  expires_in: 600,
  interval: 5,
};

interface CreateBody {
  env?: Record<string, string>;
}

interface FakeBoat {
  origin: string;
  state: { claimed: boolean; billed: boolean };
  /** Every command string Boat was asked to run ("command history"). */
  commandHistory: string[];
  deleted: string[];
  deletion: { polls: number };
  close: () => Promise<void>;
}

function readBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += String(chunk);
    });
    request.on("end", () => resolve(data));
  });
}

function isCreateSandbox(path: string, method: string | undefined): boolean {
  return path === "/api/v1/sandboxes" && method === "POST";
}

function handleDelete(
  request: import("node:http").IncomingMessage,
  path: string,
  deleted: string[],
  send: (status: number, payload: BoatJsonValue) => void,
): void {
  if (request.headers["x-ascii-confirm-delete"] !== "bx_23456789") {
    send(409, { ok: false });
    return;
  }
  deleted.push(path);
  send(202, {
    ok: true,
    operation: {
      id: "bdop_0123456789abcdef0123456789abcdef",
      kind: "sandbox",
      targetId: "bx_23456789",
      status: "pending",
    },
  });
}

function startFakeBoat(): Promise<FakeBoat> {
  const state = { claimed: false, billed: false };
  const commandHistory: string[] = [];
  const deleted: string[] = [];
  const deletion = { polls: 0 };
  let agent: RunningBoatAgent | null = null;
  let agentEnv: Record<string, string> = {};
  let origin = "";

  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const send = (status: number, payload: BoatJsonValue) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(payload));
      };
      if (path === "/api/boat/agent/identity") {
        send(200, { claim_token: "clm_1", claim: CLAIM });
      } else if (path === "/api/boat/oauth2/token") {
        if (state.claimed)
          send(200, {
            access_token: "boat_live",
            identity_assertion: "assert-live",
          });
        else send(400, { error: "authorization_pending" });
      } else if (path === "/api/boat/billing/checkout") {
        send(200, { url: "https://checkout.stripe.com/session" });
      } else if (isCreateSandbox(path, request.method)) {
        if (!state.billed) {
          send(402, {
            ok: false,
            type: "sandbox.error",
            status: 402,
            code: "billing_required",
            message: "billing_required",
            error: { code: "billing_required" },
          });
          return;
        }
        // SAFETY: checked at the fake Boat boundary: the only sender is this test's BoatClient, which serializes CreateSandboxBody objects.
        const create = JSON.parse(body) as CreateBody;
        agentEnv = create.env ?? {};
        send(202, {
          ok: true,
          sandbox: { id: "bx_23456789", state: "provisioning" },
        });
      } else if (
        path === "/api/v1/sandboxes/bx_23456789" &&
        request.method === "GET"
      ) {
        send(200, {
          ok: true,
          sandbox: {
            id: "bx_23456789",
            state: "ready",
            url: origin,
          },
        });
      } else if (path.endsWith("/commands")) {
        // SAFETY: checked at the fake Boat boundary: the only sender is this test's BoatClient, which serializes CommandBody objects.
        const command = (JSON.parse(body) as { command: string }).command;
        commandHistory.push(command);
        // The fake sandbox really runs the agent command's payload: the
        // same boat-agent entry an operator's snapshot would run.
        agent = await startBoatRelayAgent(agentEnv);
        send(200, {
          ok: true,
          type: "command.started",
          success: true,
          processId: 7,
        });
      } else if (path.endsWith("/host")) {
        send(200, {
          ok: true,
          url: `http://127.0.0.1:${agentEnv[BOAT_AGENT_ENV.port]}`,
          port: 8787,
          isProtected: true,
          access: "private",
        });
      } else if (
        path ===
        "/api/v1/deletion-operations/bdop_0123456789abcdef0123456789abcdef"
      ) {
        deletion.polls += 1;
        send(200, {
          ok: true,
          operation: {
            id: "bdop_0123456789abcdef0123456789abcdef",
            kind: "sandbox",
            targetId: "bx_23456789",
            status: "completed",
          },
        });
      } else if (request.method === "DELETE") {
        handleDelete(request, path, deleted, send);
      } else {
        send(404, { ok: false });
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address instanceof Object && "port" in address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        state,
        commandHistory,
        deleted,
        deletion,
        close: async () => {
          await agent?.close();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

test("full reset in a Boat sandbox: claim gate, in-sandbox relay, secret-free history", async () => {
  const site = new MockResetSite();
  await site.start(true);
  const boat = await startFakeBoat();
  try {
    const provider = new BoatSandboxProvider({
      origin: boat.origin,
      claimEmail: "person@example.test",
      pollIntervalMs: 10,
    });
    // Zero pre-provisioned account: allocation first surfaces the
    // claim ceremony as a human intervention.
    const claimError = await captureError(() =>
      provider.allocate({ origin: site.origin }),
    );
    expect(claimError).toBeInstanceOf(SandboxClaimRequiredError);
    // SAFETY: checked immediately above with toBeInstanceOf on the same value.
    const claim = claimError as SandboxClaimRequiredError;
    expect(claim.verificationUri).toBe(
      `${boat.origin}${CLAIM.verification_uri}`,
    );
    expect(claim.userCode).toBe("123456");

    // The person claims the agent and finishes checkout; retrying the
    // same allocation now succeeds end to end.
    boat.state.claimed = true;
    boat.state.billed = true;
    const sandbox = await test.step("allocate and authenticate relay", () =>
      provider.allocate({ origin: site.origin }));
    expect(sandbox.provider).toBe("boat");
    expect(sandbox.session).toBe("bx_23456789");

    const runtime = runtimeForDriver(sandbox.browser, site, true);
    const parked = await test.step("start reset and park for human", () =>
      runtime.runner.start(runtime.initial));
    expect(parked.status).toBe("awaiting_human");
    const finished = await test.step("resume reset after human", () =>
      runtime.runner.resumeAfterHuman(parked));
    expect(finished.status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    await test.step("verify new password", () =>
      expectNewPasswordAccepted(runtime.custody, site));
    const journalText = JSON.stringify(await runtime.store.load("run-1"));
    expect(journalText).not.toContain(PEPPER);

    await test.step("close sandbox", () => sandbox.close());
    expect(boat.deleted).toEqual(["/api/v1/sandboxes/bx_23456789"]);
    expect(boat.deletion.polls).toBe(1);
    // Boat's retained command history contains exactly the operator's
    // agent start command — no secret ever crossed as a command.
    expect(boat.commandHistory).toHaveLength(1);
    expect(boat.commandHistory[0]).toContain("src/boat-agent-main.ts");
    expect(boat.commandHistory.join("\n")).not.toContain(PEPPER);
  } finally {
    await test.step("stop fake services", async () => {
      await boat.close();
      await site.stop();
    });
  }
});
