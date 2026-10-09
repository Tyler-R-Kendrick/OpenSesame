import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryError, approveDevice } from "./directory.js";
const identityFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "./identity.js";
Object.assign(identitySeams, {
  identityFetch,
  identityBase: () => "http://127.0.0.1:8788",
});

// Device approval through the directory client: one implementation,
// `@opensesame/ceremony-kit`'s `approveDevice` (ADR 0140 D3), reached through
// `identityFetch` with this client's transport wording as the fallback.

type LastCall = { url: string; init: RequestInit };

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): LastCall {
  const call = identityFetch.mock.calls.at(-1);
  if (!call) throw new Error("identityFetch was not called");
  return { url: String(call[0]), init: call[1] ? overlapCast(call[1]) : {} };
}

/** Await a call expected to fail, returning the thrown error as an Error. */
async function failureOf(
  promise: Promise<BoundaryValue> | Promise<void>,
): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error("expected the call to fail");
}

describe("directory device approval", () => {
  beforeEach(() => {
    identityFetch.mockReset();
  });

  it("approves a device by POSTing only the user code", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ ok: true, status: 200, body: { approved: true } }),
    );
    const approval = await approveDevice("ABCD-EFGH");
    expect(lastCall().url).toBe("/v1/device/approve");
    expect(lastCall().init.method).toBe("POST");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ user_code: "ABCD-EFGH" }),
    );
    expect(approval).toEqual({ ok: true, status: 200 });
  });

  it("maps an unconfigured operator token to an operator note", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "operator_token_unconfigured",
          hint: "Set OPENSESAME_OPERATOR_TOKEN on the Identity API",
        },
        503,
      ),
    );
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    expect(error).toBeInstanceOf(DirectoryError);
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(503);
      expect(error.code).toBe("operator_token_unconfigured");
    }
    expect(error.message).toMatch(/Device approval is not enabled/);
  });

  it("maps a 404 from the Host to unknown-code wording", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "host_approval_failed" }, 404),
    );
    const error = await failureOf(approveDevice("NOPE-XXXX"));
    if (error instanceof DirectoryError) {
      expect(error.code).toBe("host_approval_failed");
    }
    expect(error.message).toMatch(/No device is waiting on that code/);
  });

  it("maps a 502 from the Host to approval-failed wording", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "host_approval_failed" }, 502),
    );
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    expect(error.message).toMatch(/could not be approved/);
  });

  it("maps an unreachable Host to unreachable wording", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "host_api_unreachable" }, 502),
    );
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(502);
      expect(error.code).toBe("host_api_unreachable");
    }
    expect(error.message).toMatch(/Approval could not be delivered/);
  });

  it("maps an invalid-request answer to invalid-request wording", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse(
        { error: "invalid_request", hint: "user_code required" },
        400,
      ),
    );
    const error = await failureOf(approveDevice("ABCD EFGH"));
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_request");
    }
    expect(error.message).toMatch(/exactly as the device shows it/);
  });

  // Before ADR 0140 D3 this client sent an empty code and let the Identity API
  // answer `invalid_request`; the one implementation refuses it locally.
  it("refuses an empty user code without calling out", async () => {
    const error = await failureOf(approveDevice("   "));
    expect(identityFetch).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(DirectoryError);
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(0);
    }
    expect(error.message).toBe("Enter the user code shown on the device.");
  });

  // The body's error code outranks the status: the control plane is a proxy,
  // so one status covers unrelated causes and only the code tells them apart.
  // A 403 here is never "sign in" — the session is fine and the organization
  // is not.
  it("maps an organization refusal to org wording, not a sign-in prompt", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "organization_access_denied" }, 403),
    );
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(403);
      expect(error.code).toBe("organization_access_denied");
    }
    expect(error.message).toBe(
      "You do not have access to the organization that device is joining.",
    );
  });

  it("falls back to the transport's wording when no code is carried", async () => {
    identityFetch.mockResolvedValue(jsonResponse({}, 401));
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    if (error instanceof DirectoryError) {
      expect(error.status).toBe(401);
      expect(error.code).toBe("unknown_error");
    }
    expect(error.message).toMatch(/needs a signed-in session/);
  });

  it("prefers the server's own message when no known code is carried", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "invalid_host_api_url", message: "Fix it." }, 500),
    );
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    if (error instanceof DirectoryError) {
      expect(error.code).toBe("invalid_host_api_url");
    }
    expect(error.message).toBe("Fix it.");
  });

  it("maps network failures to an unreachable-Identity error", async () => {
    identityFetch.mockRejectedValue(new TypeError("fetch failed"));
    const error = await failureOf(approveDevice("ABCD-EFGH"));
    expect(error).toBeInstanceOf(DirectoryError);
    if (error instanceof DirectoryError) {
      expect(error.code).toBe("unreachable");
    }
    expect(error.message).toMatch(/Sign-in service unreachable/);
  });
});
