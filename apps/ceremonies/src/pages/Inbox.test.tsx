/** @vitest-environment jsdom */
import type { BoundaryValue } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalSeams } from "../lib/approvals.js";
import { Inbox } from "./Inbox.js";

const fetchFn = vi.hoisted(() => vi.fn());

const defaults = {
  fetchFn: approvalSeams.fetchFn,
  getAccessToken: approvalSeams.getAccessToken,
  credentialsApi: approvalSeams.credentialsApi,
};

const SIMPLE = {
  authReqId: "areq_simple",
  status: "pending",
  bindingMessage: "Read the staging changelog",
  requestDigest: "digest-simple-000000000001",
  authorizationDetails: [
    { type: "connector", actions: ["read"], locations: ["staging-docs"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
};

const CEREMONIAL = {
  authReqId: "areq_hard",
  status: "pending",
  bindingMessage: "Rotate the production signing key",
  requestDigest: "digest-hard-0000000000001",
  authorizationDetails: [
    { type: "connector", actions: ["rotate"], locations: ["prod-signer"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  requireTransactionBoundActivation: true,
  requireComparison: true,
  requiredAssurance: ["phishing_resistance", "comparison"],
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderInbox() {
  return render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchFn.mockReset();
  Object.assign(approvalSeams, {
    fetchFn,
    getAccessToken: async () => "session-bearer",
  });
});

afterEach(() => {
  cleanup();
  Object.assign(approvalSeams, defaults);
});

describe("inbox", () => {
  it("keeps the inline decision for a request that needs nothing extra", async () => {
    fetchFn.mockResolvedValueOnce(json({ requests: [SIMPLE] }));
    fetchFn.mockResolvedValueOnce(json({ decision: "approved" }));
    fetchFn.mockResolvedValueOnce(json({ requests: [] }));

    renderInbox();
    await screen.findByText("Read the staging changelog");
    expect(screen.getByText(/nothing extra/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText(/Nothing is waiting for you/i);
    // The digest echo is preserved exactly as it was shown.
    const init: RequestInit = fetchFn.mock.calls[1]?.[1] ?? {};
    expect(JSON.parse(String(init.body ?? "{}"))).toEqual({
      requestDigest: SIMPLE.requestDigest,
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain(
      "/v1/authorization-requests/areq_simple/approve",
    );
  });

  it("routes a request that needs a ceremony through the review page instead", async () => {
    fetchFn.mockResolvedValueOnce(json({ requests: [CEREMONIAL] }));
    renderInbox();

    await screen.findByText("Rotate the production signing key");
    // The summary says what will be asked for, before anything is opened.
    expect(
      screen.getByText(
        /Needs a passkey touch for this exact request and the six-digit code/i,
      ),
    ).toBeTruthy();
    const review = screen.getByRole("link", { name: "Review" });
    expect(review.getAttribute("href")).toBe("/approve/areq_hard");
    // No inline approve: this one cannot honestly be decided from a list.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("shows both kinds side by side without confusing them", async () => {
    fetchFn.mockResolvedValueOnce(json({ requests: [SIMPLE, CEREMONIAL] }));
    renderInbox();

    await screen.findByText("Read the staging changelog");
    expect(screen.getAllByRole("link", { name: "Review" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  it("says a 409 changed since it was shown rather than swallowing it", async () => {
    fetchFn.mockResolvedValueOnce(json({ requests: [SIMPLE] }));
    fetchFn.mockResolvedValueOnce(json({ error: "digest_changed" }, 409));

    renderInbox();
    await screen.findByText("Read the staging changelog");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("changed since it was shown");
    expect(alert.textContent).toContain("nothing was decided");
  });

  it("asks for a sign-in rather than showing an empty inbox", async () => {
    Object.assign(approvalSeams, { getAccessToken: async () => null });
    renderInbox();

    await screen.findByText(/this page needs you signed in/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
