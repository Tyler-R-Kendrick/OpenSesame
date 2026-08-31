/** @vitest-environment jsdom */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalSeams } from "../lib/approvals.js";
import { ApprovalReview } from "./ApprovalReview.js";

const fetchFn = vi.hoisted(() => vi.fn());
const credentialsApi = vi.hoisted(() => vi.fn());

const defaults = {
  fetchFn: approvalSeams.fetchFn,
  getAccessToken: approvalSeams.getAccessToken,
  credentialsApi: approvalSeams.credentialsApi,
};

/** The comparison value a hostile screen would echo. It must appear nowhere. */
const SECRET_CODE = "424242";

const REQUEST = {
  authReqId: "areq_1",
  status: "pending",
  bindingMessage: "Deploy the billing service",
  requestDigest: "digest-of-what-was-shown-0001",
  authorizationDetails: [
    { type: "connector", actions: ["deploy"], locations: ["prod-billing"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  requesterRef: "req_opaque_7f3",
  requesterKind: "agent",
};

const REQUIREMENT = {
  riskClass: "critical",
  policyDigest: "policy-digest",
  requireTransactionBoundActivation: true,
  requireComparison: true,
  required: [
    "subject_kind:human",
    "phishing_resistance",
    "transaction_bound_activation",
    "comparison",
  ],
  maximumApprovalAgeSeconds: 120,
  arrivedVia: "telegram",
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GET request + GET requirement, in the order the page issues them. */
function seedLoad(requirement: BoundaryValue = REQUIREMENT) {
  fetchFn.mockResolvedValueOnce(json(REQUEST));
  fetchFn.mockResolvedValueOnce(json(requirement));
}

function urls(): string[] {
  return fetchFn.mock.calls.map((call) => String(call[0]));
}

function bodyOf(index: number): BoundaryValue {
  const init: RequestInit = overlapCast(fetchFn.mock.calls[index]?.[1] ?? {});
  return JSON.parse(String(init.body ?? "null"));
}

function renderReview() {
  return render(
    <MemoryRouter initialEntries={["/approve/areq_1"]}>
      <Routes>
        <Route path="/approve/:ref" element={<ApprovalReview />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A credential store that answers, so the ceremony can actually run. */
function workingAuthenticator() {
  const get = vi.fn(async () => ({
    id: "cred_1",
    type: "public-key",
    rawId: new ArrayBuffer(4),
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new ArrayBuffer(8),
      authenticatorData: new ArrayBuffer(8),
      signature: new ArrayBuffer(8),
    },
  }));
  credentialsApi.mockReturnValue({ get });
  return get;
}

beforeEach(() => {
  fetchFn.mockReset();
  credentialsApi.mockReset();
  credentialsApi.mockReturnValue(null);
  Object.assign(approvalSeams, {
    fetchFn,
    getAccessToken: async () => "session-bearer",
    credentialsApi,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(approvalSeams, defaults);
});

describe("approval review — what it says before anything is decided", () => {
  it("renders the requirement reasons as sentences and names the channel", async () => {
    seedLoad();
    renderReview();

    await screen.findByText("Deploy the billing service");
    // Reason codes are never printed raw.
    const page = document.body.textContent ?? "";
    expect(page).not.toContain("phishing_resistance");
    expect(page).not.toContain("transaction_bound_activation");
    expect(page).not.toContain("subject_kind:human");
    expect(
      screen.getByText(/needs a passkey bound to this site/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/touch your authenticator for this exact request/i),
    ).toBeTruthy();
    expect(screen.getByText(/type the six-digit code/i)).toBeTruthy();
    // …and the risk class is a sentence, not a scalar badge.
    expect(page).not.toMatch(/\bcritical\b/);
    expect(screen.getByText(/most sensitive kind of request/i)).toBeTruthy();
    // Which channel brought me here.
    expect(screen.getByText(/You got here from Telegram/)).toBeTruthy();
    // What would actually happen, and how long it is good for.
    expect(screen.getByText("deploy — prod-billing")).toBeTruthy();
    expect(screen.getByText(/req_opaque_7f3/)).toBeTruthy();
  });

  it("offers a report action that leaves the request undecided", async () => {
    seedLoad();
    fetchFn.mockResolvedValueOnce(json({ reported: true }));
    renderReview();

    await screen.findByText("Deploy the billing service");
    fireEvent.click(
      screen.getByRole("button", { name: /don't recognize this request/i }),
    );

    await screen.findByText(/Refused and reported/i);
    expect(urls().at(-1)).toContain("/v1/authorization-requests/areq_1/report");
    // A report is not a denial: nothing was settled.
    expect(urls().some((url) => url.endsWith("/deny"))).toBe(false);
  });
});

describe("approval review — the ceremony", () => {
  it("runs activation, then complete, then settle, and settles with the activation id", async () => {
    seedLoad();
    const get = workingAuthenticator();
    fetchFn.mockResolvedValueOnce(
      json({
        activationId: "act_9",
        transactionDigest: "tx",
        policyDigest: "policy-digest",
        expiresAt: "2030-01-01T00:00:00.000Z",
        options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
      }),
    );
    fetchFn.mockResolvedValueOnce(json({ ok: true }));
    fetchFn.mockResolvedValueOnce(json({ decision: "approved" }));

    renderReview();
    await screen.findByText("Deploy the billing service");

    fireEvent.change(screen.getByLabelText(/six-digit code/i), {
      target: { value: SECRET_CODE },
    });
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Touch your passkey to approve/i }),
    );

    await screen.findByText(/Approved\./);

    // The order is the security property: mint, prove, then settle.
    const path = urls().slice(2);
    expect(path[0]).toContain("/v1/authorization-requests/areq_1/activation");
    expect(path[1]).toContain(
      "/v1/authorization-requests/areq_1/activation/complete",
    );
    expect(path[2]).toContain("/v1/authorization-requests/areq_1/approve");
    expect(get).toHaveBeenCalledTimes(1);

    // The activation is minted against the digest that was displayed…
    expect(bodyOf(2)).toEqual({
      decision: "approved",
      requestDigest: REQUEST.requestDigest,
    });
    // …proved once…
    const complete: { activationId?: string; signature?: string } = overlapCast(
      bodyOf(3),
    );
    expect(complete.activationId).toBe("act_9");
    expect(complete.signature).toBeTruthy();
    // …and named, not re-proved, at settle.
    expect(bodyOf(4)).toEqual({
      requestDigest: REQUEST.requestDigest,
      activationId: "act_9",
      comparisonValue: SECRET_CODE,
    });
  });

  it("never settles when the authenticator is unreachable", async () => {
    seedLoad();
    // credentialsApi already returns null: no navigator.credentials here.
    renderReview();
    await screen.findByText("Deploy the billing service");

    fireEvent.change(screen.getByLabelText(/six-digit code/i), {
      target: { value: SECRET_CODE },
    });
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Touch your passkey to approve/i }),
    );

    await screen.findByText(/credential API is missing/i);
    expect(screen.getByText(/Nothing has been approved/i)).toBeTruthy();
    // The activation was never even begun, let alone skipped past.
    expect(urls()).toHaveLength(2);
  });

  it("requires the explicit confirmation before the passkey step", async () => {
    seedLoad();
    workingAuthenticator();
    renderReview();
    await screen.findByText("Deploy the billing service");

    const approve = screen.getByRole("button", {
      name: /Touch your passkey to approve/i,
    });
    expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    expect(approve.hasAttribute("disabled")).toBe(false);
  });
});

describe("approval review — refusals in words", () => {
  it("treats a comparison mismatch as a security signal, not a form error", async () => {
    seedLoad();
    workingAuthenticator();
    fetchFn.mockResolvedValueOnce(
      json({
        activationId: "act_9",
        transactionDigest: "tx",
        policyDigest: "p",
        expiresAt: "2030-01-01T00:00:00.000Z",
        options: { challenge: "Y2hhbGxlbmdl" },
      }),
    );
    fetchFn.mockResolvedValueOnce(json({ ok: true }));
    fetchFn.mockResolvedValueOnce(json({ error: "comparison_mismatch" }, 422));

    renderReview();
    await screen.findByText("Deploy the billing service");
    fireEvent.change(screen.getByLabelText(/six-digit code/i), {
      target: { value: "111111" },
    });
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Touch your passkey to approve/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That code doesn't match");
    expect(alert.textContent).toContain(
      "Someone else may have started this request",
    );
    // Not the generic 422 wording.
    expect(alert.textContent).not.toContain("already decided");
    expect(alert.textContent).not.toMatch(/did not go through/);
  });

  it("says a 409 changed since it was shown, and stops", async () => {
    fetchFn.mockResolvedValueOnce(json({ error: "digest_changed" }, 409));
    renderReview();

    await screen.findByText(/changed since it was shown/i);
    expect(screen.getByText(/nothing was decided/i)).toBeTruthy();
    // Terminal: the decision controls are gone.
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
  });

  it("says a 410 expired, and stops", async () => {
    fetchFn.mockResolvedValueOnce(json({ error: "expired" }, 410));
    renderReview();

    await screen.findByText(/expired before it was decided/i);
    expect(screen.queryByRole("button", { name: /Deny/i })).toBeNull();
  });

  it("says an activation that timed out did not decide anything", async () => {
    seedLoad();
    workingAuthenticator();
    fetchFn.mockResolvedValueOnce(
      json({
        activationId: "act_9",
        transactionDigest: "tx",
        policyDigest: "p",
        expiresAt: "2030-01-01T00:00:00.000Z",
        options: { challenge: "Y2hhbGxlbmdl" },
      }),
    );
    fetchFn.mockResolvedValueOnce(json({ error: "activation_expired" }, 400));

    renderReview();
    await screen.findByText("Deploy the billing service");
    fireEvent.change(screen.getByLabelText(/six-digit code/i), {
      target: { value: SECRET_CODE },
    });
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Touch your passkey to approve/i }),
    );

    await screen.findByText(/authenticator touch took too long/i);
    // Nothing was settled.
    expect(urls().some((url) => url.endsWith("/approve"))).toBe(false);
  });

  it("says a revoked binding can no longer decide, and stops", async () => {
    fetchFn.mockResolvedValueOnce(json({ error: "binding_revoked" }, 403));
    renderReview();

    await screen.findByText(/has been revoked/i);
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
  });

  it("says an already-decided request changed nothing", async () => {
    fetchFn.mockResolvedValueOnce(json({ error: "request_not_pending" }, 422));
    renderReview();

    await screen.findByText(/already decided/i);
  });
});

describe("approval review — what never reaches the page", () => {
  it("never renders the comparison value back", async () => {
    seedLoad();
    workingAuthenticator();
    fetchFn.mockResolvedValueOnce(
      json({
        activationId: "act_9",
        transactionDigest: "tx",
        policyDigest: "p",
        expiresAt: "2030-01-01T00:00:00.000Z",
        options: { challenge: "Y2hhbGxlbmdl" },
        // A server that leaked the value back must not get it onto the screen.
        comparisonValue: SECRET_CODE,
      }),
    );
    fetchFn.mockResolvedValueOnce(json({ ok: true }));
    fetchFn.mockResolvedValueOnce(json({ decision: "approved" }));

    renderReview();
    await screen.findByText("Deploy the billing service");
    fireEvent.change(screen.getByLabelText(/six-digit code/i), {
      target: { value: SECRET_CODE },
    });
    fireEvent.click(screen.getByLabelText(/I have read what this would do/i));
    fireEvent.click(
      screen.getByRole("button", { name: /Touch your passkey to approve/i }),
    );
    await screen.findByText(/Approved\./);

    expect(document.body.textContent ?? "").not.toContain(SECRET_CODE);
  });

  it("never renders a bearer or a provider subject that came back with the request", async () => {
    fetchFn.mockResolvedValueOnce(
      json({
        ...REQUEST,
        providerSubjectId: "U0FAKESUBJECT",
        accessToken: "osc_at_leaked",
      }),
    );
    fetchFn.mockResolvedValueOnce(json(REQUIREMENT));
    renderReview();

    await screen.findByText("Deploy the billing service");
    const page = document.body.textContent ?? "";
    expect(page).not.toContain("U0FAKESUBJECT");
    expect(page).not.toContain("osc_at_leaked");
    expect(page).not.toContain("session-bearer");
  });
});
