import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AgentRunView } from "@opensesame/api-client";
import { expect } from "vitest";
import { ORIGIN } from "./genuine-runner-permit.fixture";

function latch() {
  let resolve: () => void = () => {
    throw new Error("Uninitialized physical hold");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, release: () => resolve() };
}

function sendClaim(
  response: ServerResponse,
  run: AgentRunView,
  hold?: { start(): void; released: Promise<void> },
) {
  const bytes = JSON.stringify({
    run_id: run.id,
    seq: 0,
    request: {
      step: "fill_credential",
      reference: "current_password",
      selector: "#held-runner-field",
    },
    claim_expires_at: run.expires_at,
    secrets_returned: false,
  });
  if (!hold) response.end(bytes);
  else {
    response.writeHead(200);
    response.write(bytes.slice(0, 1));
    hold.start();
    void hold.released.then(() => response.end(bytes.slice(1)));
  }
}

function settleStep(
  request: IncomingMessage,
  response: ServerResponse,
  errors: string[],
) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    const received = JSON.parse(Buffer.concat(chunks).toString());
    if (
      JSON.stringify(received) !==
      JSON.stringify({ outcome: { outcome: "filled", filled: "Ok" } })
    )
      errors.push("Unexpected actual filled outcome");
    response.end(
      JSON.stringify({ status: "settled", redacted: false, refused: false }),
    );
  });
}
/** Physical HTTP only: production ApiClient parses actual streamed protocol bytes. */
export async function heldRunnerHttp(
  stage: "list" | "claim" | "none" = "list",
) {
  const started = latch();
  const body = latch();
  const paths: string[] = [];
  const authorization: boolean[] = [];
  const errors: string[] = [];
  let runReads = 0;
  const run: AgentRunView = {
    id: "public-runner-authority-case",
    origin: ORIGIN,
    control_state: "agent_driving",
    quiescence: "quiescent",
    driver: "agent",
    closed_at: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    next_seq: 0,
  };
  const root = `/api/v1/agent/runs/${run.id}`;
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    authorization.push(
      request.headers.authorization === "Bearer public-runner-host-session",
    );
    response.setHeader("content-type", "application/json");
    if (path === "/api/v1/agent/runs") {
      if (stage === "list") {
        response.writeHead(200);
        response.write('{"runs":[');
        started.release();
        void body.promise.then(() => response.end(`${JSON.stringify(run)}]}`));
      } else {
        if (stage === "none") started.release();
        response.end(JSON.stringify({ runs: [run] }));
      }
    } else if (path === root) {
      runReads += 1;
      response.end(
        JSON.stringify(
          runReads === 1
            ? run
            : { ...run, closed_at: new Date().toISOString() },
        ),
      );
    } else if (path === `${root}/steps/claim`) {
      sendClaim(
        response,
        run,
        stage === "claim"
          ? { start: started.release, released: body.promise }
          : undefined,
      );
    } else if (path === `${root}/steps/0/outcome`) {
      settleStep(request, response, errors);
    } else {
      errors.push(`Unexpected public protocol route: ${path}`);
      response.writeHead(404);
      response.end('{"error":"unknown_fixture_route"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected real TCP address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    paths,
    errors,
    started: started.promise,
    release: body.release,
    assertTransport() {
      expect(authorization.every(Boolean)).toBe(true);
      expect(errors).toEqual([]);
    },
    async close() {
      body.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
