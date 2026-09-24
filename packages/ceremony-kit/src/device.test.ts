import { describe, expect, it, vi } from "vitest";
import {
  CeremonyRequestError,
  approveDevice,
  deviceApprovalWords,
} from "./device.js";

// The one device approval (ADR 0140 D3). The wording keyed on the body's
// error code came from Pages' directory client; the status-keyed wording is
// what the ceremonies app, the console and mobile MFA assert verbatim.

function answer(status: number, body?: object): typeof fetch {
  return async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

async function failure(
  fetchImpl: typeof fetch,
  fallbackWords?: (status: number, detail: string | null) => string,
): Promise<CeremonyRequestError> {
  try {
    await approveDevice({
      baseUrl: "http://id.example",
      userCode: "ABCD-EFGH",
      fetchImpl,
      ...(fallbackWords ? { fallbackWords } : {}),
    });
  } catch (error) {
    if (error instanceof CeremonyRequestError) return error;
    throw error;
  }
  throw new Error("expected the approval to fail");
}

describe("approveDevice", () => {
  it("reads the proxy's {ok, status} answer", async () => {
    await expect(
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "ABCD",
        fetchImpl: answer(200, { ok: true, status: 201 }),
      }),
    ).resolves.toEqual({ ok: true, status: 201 });
    await expect(
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "ABCD",
        fetchImpl: answer(200, { ok: true }),
      }),
    ).resolves.toEqual({ ok: true, status: 200 });
  });

  it("treats a body-less success as a plain yes", async () => {
    await expect(
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "ABCD",
        fetchImpl: answer(204),
      }),
    ).resolves.toEqual({ ok: true, status: 204 });
  });

  it("posts to a path when the fetch resolves the origin itself", async () => {
    const fetchImpl = vi.fn(answer(200, { ok: true, status: 200 }));
    await approveDevice({ baseUrl: "", userCode: "ABCD", fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/v1/device/approve");
  });

  it.each([
    [503, "operator_token_unconfigured", /Device approval is not enabled/],
    [502, "host_api_unreachable", /Approval could not be delivered/],
    [404, "host_approval_failed", /No device is waiting on that code/],
    [502, "host_approval_failed", /could not be approved/],
    [400, "invalid_request", /exactly as the device shows it/],
    [400, "organization_id_required", /several organizations/],
    [403, "organization_access_denied", /organization that device is joining/],
  ])("words a %i carrying %s by its code", async (status, code, words) => {
    const error = await failure(answer(status, { error: code, hint: "x" }));
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(words);
  });

  it("never answers an organization refusal with a sign-in prompt", async () => {
    const error = await failure(
      answer(403, { error: "organization_access_denied" }),
    );
    expect(error.message).not.toMatch(/Sign in first/);
  });

  it("words a failure with no known code by its status", async () => {
    const unknown = await failure(answer(401, { error: "who_knows" }));
    expect(unknown.code).toBe("who_knows");
    expect(unknown.message).toMatch(/Sign in first/);
    expect((await failure(answer(500))).message).toBe(
      "Approval failed (500). Try again shortly.",
    );
    expect((await failure(answer(500))).code).toBe("");
  });

  it("hands a code-less failure to the surface's own wording", async () => {
    const fallback = vi.fn(
      (status: number, detail: string | null) => `${status}:${detail}`,
    );
    const error = await failure(
      answer(500, { message: "Plain words." }),
      fallback,
    );
    expect(error.message).toBe("500:Plain words.");
    // A known code still outranks the surface's fallback.
    const known = await failure(
      answer(502, { error: "host_api_unreachable" }),
      fallback,
    );
    expect(known.message).toMatch(/Approval could not be delivered/);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("lets a transport failure propagate as thrown", async () => {
    await expect(
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "ABCD",
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("knows no words for a code it was not taught", () => {
    expect(deviceApprovalWords("", 500)).toBeNull();
    expect(deviceApprovalWords("unknown_error", 401)).toBeNull();
  });
});
