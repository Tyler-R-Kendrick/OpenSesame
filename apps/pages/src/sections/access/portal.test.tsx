/** @vitest-environment jsdom */
import { isJsonObject } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identitySeams } from "../../lib/identity.js";
import { ApprovalInbox } from "./ApprovalInbox.js";
import { NewSession } from "./NewSession.js";

const pending = {
  authReqId: "request-1",
  status: "pending",
  bindingMessage: "Review deployment",
  requestDigest: "sha256:reviewed-digest",
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
beforeEach(() => {
  vi.spyOn(identitySeams, "identityBase").mockReturnValue(
    "https://identity.example",
  );
  vi.spyOn(identitySeams, "hostBase").mockReturnValue("https://host.example");
  vi.spyOn(identitySeams, "useIdentitySession").mockReturnValue({
    principalId: "principal-1",
    accessToken: "fixture",
    issuerOrigin: "https://identity.example",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["Approve request", "Deny request"])(
  "reviews an addressed request in place and submits %s",
  async (label) => {
    const decision = label.startsWith("Approve") ? "approve" : "deny";
    const fetch = vi
      .spyOn(identitySeams, "identityFetch")
      .mockImplementation(async (path) => {
        if (path.endsWith("/requirement"))
          return Response.json({
            riskClass: "low",
            policyDigest: "policy",
            requireTransactionBoundActivation: false,
            requireComparison: false,
            required: [],
            maximumApprovalAgeSeconds: 300,
          });
        if (path.endsWith(`/${decision}`))
          return Response.json({
            ...pending,
            status: decision === "approve" ? "approved" : "denied",
          });
        return Response.json({ requests: [pending] });
      });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ApprovalInbox online />
      </MemoryRouter>,
    );
    await user.click(
      await screen.findByRole("button", { name: "Review request" }),
    );
    await screen.findByText("low");
    expect(screen.getByText(pending.requestDigest)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: label }));
    await screen.findByText(decision === "approve" ? "approved" : "denied");
    expect(fetch).toHaveBeenCalledWith(
      `/v1/authorization-requests/request-1/${decision}`,
      expect.objectContaining({
        body: JSON.stringify({ requestDigest: pending.requestDigest }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Review request" })).toBeNull();
  },
);

it("creates an explicit request and exposes a one-time comparison code only on command", async () => {
  const fetch = vi
    .spyOn(identitySeams, "identityFetch")
    .mockImplementation(async (path, init) => {
      if (path.endsWith("/comparison"))
        return Response.json({
          authReqId: pending.authReqId,
          value: "123456",
          expiresAt: pending.expiresAt,
        });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (!isJsonObject(body)) throw new Error("Invalid request body");
        expect(body.approverRef).toBe("inbox-address");
        expect(body.authorizationDetails).toEqual([
          {
            type: "opensesame_access",
            actions: ["read"],
            identifier: "deploy/status",
          },
        ]);
        return Response.json(pending);
      }
      return Response.json({ requests: [] });
    });
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ApprovalInbox online />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: "Request access" }));
  await user.type(
    screen.getByLabelText("Approver inbox address"),
    "inbox-address",
  );
  await user.type(screen.getByLabelText("Resource"), "deploy/status");
  await user.type(screen.getByLabelText("Action"), "read");
  await user.type(screen.getByLabelText("Reason"), "Review deployment");
  await user.click(screen.getByRole("button", { name: "Send request" }));
  await screen.findByRole("heading", { name: "Sent request" });
  expect(fetch.mock.calls.some(([path]) => path.endsWith("/comparison"))).toBe(
    false,
  );
  await user.click(
    screen.getByRole("button", { name: "Show comparison code" }),
  );
  await screen.findByText("123456");
  expect(
    screen
      .getByRole("button", { name: "Show comparison code" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("creates a scoped session without letting the form choose its owner", async () => {
  const fetch = vi
    .spyOn(identitySeams, "hostFetch")
    .mockResolvedValueOnce(
      Response.json({
        principal_id: "verified-user",
        organization_id: "verified-org",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        task_run_id: "task-1",
        state_version: 1,
        status: "active",
      }),
    );
  const done = vi.fn();
  const user = userEvent.setup();
  render(<NewSession online onCreated={done} onCancel={vi.fn()} />);
  await user.type(screen.getByLabelText("Allowed action"), "read");
  await user.type(screen.getByLabelText("Exact resource"), "deploy/status");
  await user.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[1]?.[1]?.body).toBe(
    JSON.stringify({
      principal_id: "verified-user",
      organization_id: "verified-org",
      capabilities: [{ action: "read", resource: "deploy/status" }],
      ttl_seconds: 900,
    }),
  );
});
