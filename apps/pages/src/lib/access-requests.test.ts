// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type AccessRequest,
  accessApprovalSeams,
  createAccessRequest,
  decideAccessRequest,
  getRequestComparison,
  listAccessRequests,
} from "./access-requests.js";
import { identitySeams } from "./identity.js";

const request: AccessRequest = {
  authReqId: "request-1",
  status: "pending",
  bindingMessage: "Read deployment status",
  requestDigest: "sha256:reviewed-request-digest",
  authorizationDetails: [
    {
      type: "opensesame_access",
      actions: ["read"],
      identifier: "deploy/status",
    },
  ],
  expiresAt: "2099-01-01T00:00:00Z",
  intervalSeconds: 5,
};
const requirement = {
  riskClass: "low",
  policyDigest: "policy-current",
  requireTransactionBoundActivation: false,
  requireComparison: false,
  required: [],
  maximumApprovalAgeSeconds: 300,
};
beforeEach(() => {
  vi.spyOn(identitySeams, "identityBase").mockReturnValue(
    "https://identity.example",
  );
});
afterEach(() => vi.restoreAllMocks());

it.each(["approve", "deny"] as const)(
  "%s binds the reviewed digest after resolving current requirements",
  async (decision) => {
    const fetch = vi
      .spyOn(identitySeams, "identityFetch")
      .mockResolvedValueOnce(Response.json(requirement))
      .mockResolvedValueOnce(
        Response.json({
          ...request,
          status: decision === "approve" ? "approved" : "denied",
        }),
      );
    await decideAccessRequest(request, decision, "");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/authorization-requests/request-1/requirement",
    );
    expect(fetch.mock.calls[1]).toEqual([
      `/v1/authorization-requests/request-1/${decision}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requestDigest: request.requestDigest }),
      }),
    ]);
  },
);

it("refuses missing comparison evidence without posting a decision", async () => {
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockResolvedValue(
      Response.json({ ...requirement, requireComparison: true }),
    );
  await expect(decideAccessRequest(request, "approve", "12")).rejects.toThrow(
    "six-digit",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("a newly elevated policy refuses direct settlement and requests another review", async () => {
  const fetch = vi.spyOn(identitySeams, "identityFetch").mockResolvedValue(
    Response.json({
      ...requirement,
      requireTransactionBoundActivation: true,
    }),
  );
  await expect(decideAccessRequest(request, "approve", "")).rejects.toThrow(
    "Identity passkey",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("opens the Identity origin before awaiting, then trusts only the authenticated server decision", async () => {
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const open = vi.spyOn(accessApprovalSeams, "open").mockReturnValue(window);
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockImplementation(async () => {
      expect(open).toHaveBeenCalledOnce();
      return Response.json({ ...request, status: "approved" });
    });
  const result = await decideAccessRequest(
    request,
    "approve",
    "123456",
    undefined,
    true,
  );
  expect(result.status).toBe("approved");
  const url = new URL(open.mock.calls[0]?.[0] ?? "");
  expect(url.origin).toBe("https://identity.example");
  expect(url.pathname).toBe("/v1/approval/ceremony");
  expect([...url.searchParams.keys()].sort()).toEqual([
    "decision",
    "digest",
    "request",
  ]);
  expect(url.href).not.toContain("123456");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it("a blocked popup cannot settle a request", async () => {
  vi.spyOn(accessApprovalSeams, "open").mockReturnValue(null);
  const fetch = vi.spyOn(identitySeams, "identityFetch");
  await expect(
    decideAccessRequest(request, "deny", "", undefined, true),
  ).rejects.toThrow("Allow");
  expect(fetch).not.toHaveBeenCalled();
});

it("a changed digest returned while the Identity window is open is refused", async () => {
  vi.spyOn(accessApprovalSeams, "open").mockReturnValue(window);
  vi.spyOn(window, "close").mockImplementation(() => {});
  vi.spyOn(identitySeams, "identityFetch").mockResolvedValue(
    Response.json({
      ...request,
      requestDigest: "different",
      status: "approved",
    }),
  );
  await expect(
    decideAccessRequest(request, "approve", "", undefined, true),
  ).rejects.toThrow("changed");
});

it("aborting a hosted review closes its window without posting a decision", async () => {
  const controller = new AbortController();
  vi.spyOn(accessApprovalSeams, "open").mockReturnValue(window);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockImplementation(async () => {
      controller.abort();
      return Response.json(request);
    });
  await expect(
    decideAccessRequest(request, "approve", "", controller.signal, true),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
});

it("closing a review during policy lookup prevents subsequent mutation", async () => {
  const controller = new AbortController();
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockImplementation(async () => {
      controller.abort();
      return Response.json(requirement);
    });
  await expect(
    decideAccessRequest(request, "deny", "", controller.signal),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("validates inbox, request creation and one-time comparison responses", async () => {
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockResolvedValueOnce(Response.json({ requests: [request] }))
    .mockResolvedValueOnce(Response.json(request))
    .mockResolvedValueOnce(
      Response.json({
        authReqId: request.authReqId,
        value: "123456",
        expiresAt: request.expiresAt,
      }),
    );
  expect(await listAccessRequests()).toEqual([request]);
  await createAccessRequest({
    approverRef: "inbox-explicit",
    bindingMessage: request.bindingMessage,
    authorizationDetails: request.authorizationDetails,
  });
  expect(await getRequestComparison(request.authReqId)).toMatchObject({
    value: "123456",
  });
  expect(fetch.mock.calls[2]?.[0]).toBe(
    "/v1/authorization-requests/request-1/comparison",
  );
  fetch.mockResolvedValueOnce(
    Response.json({ requests: [{ status: "invented" }] }),
  );
  await expect(listAccessRequests()).rejects.toThrow();
});
