/**
 * What a client is told when a request goes wrong. A body that is not JSON
 * is the client's mistake: a 400 that names it and raises no alarm. Anything
 * else that throws is the server's: a 500 with a correlation id to quote,
 * the details logged and never sent (`app.ts` onError, `json-body.ts`).
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

describe("error responses", () => {
  it("answers a body that is not JSON with a 400, not a logged 500", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const logged = vi.spyOn(ctx.log, "error").mockImplementation(() => {});
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const { accessToken } = overlapCast(await created.json());

    for (const body of ["{not json", ""]) {
      const res = await app.request("/v1/claims", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-correlation-id": "corr-400",
        },
        body,
      });
      expect(res.status).toBe(400);
      const answer = overlapCast(await res.json());
      expect(answer.error).toBe("invalid_json");
      expect(answer.correlationId).toBe("corr-400");
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("turns an unhandled throw into a correlated 500, not a stack trace", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const logged = vi.spyOn(ctx.log, "error").mockImplementation(() => {});
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const { accessToken } = overlapCast(await created.json());
    // A store that fails mid-request: the message must reach the log, never
    // the client.
    vi.spyOn(ctx.repos.principals, "getById").mockRejectedValue(
      new Error("database at 10.0.0.7 refused the connection"),
    );

    const res = await app.request("/v1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-correlation-id": "corr-500",
      },
      body: JSON.stringify({ type: "principal", targetManifest: {} }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("10.0.0.7");
    const body = overlapCast(JSON.parse(text));
    expect(body.error).toBe("internal_error");
    expect(body.correlationId).toBe("corr-500");
    expect(logged).toHaveBeenCalledOnce();
  });
});
