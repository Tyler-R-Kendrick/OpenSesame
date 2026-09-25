import {
  captureApprovalArrivalFromPage,
  resetApprovalArrivalForTests,
} from "@opensesame/app-core/lib/approvals-link.js";
import { APPROVAL_NOTICE } from "@opensesame/app-core/lib/approvals-route.js";
/** @vitest-environment jsdom */
/**
 * `/approve/:ref` (ADR 0140 plan step 9): the review opens with no vault,
 * reads the request and its requirement, and settles only through an
 * activation bound to the digest shown, the verb pressed and the policy shown
 * (ADR 0084 §5). The stand-in authority refuses, with the Identity API's own
 * codes, a settle whose activation names another request, another verb or
 * another policy; the screen shows the model's refusal and never an approval.
 */
import { approvalReview } from "@opensesame/app-core/lib/approvals.js";
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { ApproveScreen } from "./ApproveScreen.js";
import {
  AREQ,
  DIGEST,
  OTHER_DIGEST,
  OTHER_POLICY,
  POLICY,
  ceremonyServer,
} from "./ceremony-server.test-support.js";
import { approvalHookSeams } from "./useApprovalReview.js";

const session: { current: IdentitySession | null } = { current: null };
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
const originalReview = approvalHookSeams.review;
let server = ceremonyServer();

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

function show(address = `/approve/${AREQ}`) {
  history.replaceState(null, "", address);
  captureApprovalArrivalFromPage();
  return render(
    <MemoryRouter initialEntries={[location.pathname]}>
      <ApproveScreen />
    </MemoryRouter>,
  );
}

/** Read, confirm, type the code, press the key that runs the passkey. */
async function approve(code = "123456") {
  await screen.findByRole("heading", { name: "Deploy the billing service" });
  await userEvent.type(
    screen.getByLabelText("Six-digit code from where this started"),
    code,
  );
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: "Touch your passkey to approve" }),
  );
}

const settled = () =>
  server.calls.filter((c) => /\/(approve|deny)$/.test(c.path));

beforeEach(() => {
  server = ceremonyServer();
  session.current = overlapCast({ accessToken: "t", issuerOrigin: "x" });
  deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:8788";
  approvalHookSeams.review = (ref) =>
    approvalReview(ref, {
      transport: server.approvalTransport,
      authenticator: server.authenticator,
    });
  clearNotices();
});

afterEach(() => {
  cleanup();
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  approvalHookSeams.review = originalReview;
  resetApprovalArrivalForTests();
  history.replaceState(null, "", "/");
});

describe("the /approve/:ref route", () => {
  it("opens with no vault and shows the request, what it allows and what it takes", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Review a request" }));
    expect(
      await screen.findByRole("heading", {
        name: "Deploy the billing service",
      }),
    );
    expect(screen.getByText("deploy — prod-billing")).toBeTruthy();
    expect(screen.getByText("req_opaque_7f3 (agent)")).toBeTruthy();
    expect(screen.getByText(/You got here from Telegram/)).toBeTruthy();
    expect(server.paths().slice(0, 2)).toEqual([
      `GET /v1/authorization-requests/${AREQ}`,
      `GET /v1/authorization-requests/${AREQ}/requirement`,
    ]);
  });

  it("approves only after a confirmation, with an activation bound to the digest, the verb and the policy", async () => {
    show();
    await screen.findByRole("heading", { name: "Deploy the billing service" });
    expect(
      screen.getByRole("button", { name: "Touch your passkey to approve" }),
    ).toHaveProperty("disabled", true);
    await approve();
    expect(await screen.findByRole("heading", { name: /Approved/ }));
    const minted = server.calls.find((c) => c.path.endsWith("/activation"));
    expect(minted?.body).toEqual({
      decision: "approved",
      requestDigest: DIGEST,
    });
    expect(settled().map((c) => c.body)).toEqual([
      {
        requestDigest: DIGEST,
        activationId: "act_1",
        comparisonValue: "123456",
      },
    ]);
    expect(server.assert).toHaveBeenCalledOnce();
  });

  it("denies through an activation minted for the deny", async () => {
    show();
    await screen.findByRole("heading", { name: "Deploy the billing service" });
    await userEvent.type(
      screen.getByLabelText("Six-digit code from where this started"),
      "123456",
    );
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("heading", { name: /Denied/ }));
    const minted = server.calls.find((c) => c.path.endsWith("/activation"));
    expect(minted?.body).toEqual({ decision: "denied", requestDigest: DIGEST });
    expect(settled()[0]?.path).toBe(`/v1/authorization-requests/${AREQ}/deny`);
  });

  it("refuses a settle whose activation is bound to a request that changed", async () => {
    server.state.afterActivation = () => {
      server.state.digest = OTHER_DIGEST;
    };
    show();
    await approve();
    expect(
      await screen.findByRole("img", { name: /changed since it was shown/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Approved/ })).toBeNull();
    expect(
      listNotices().find((notice) => notice.id === APPROVAL_NOTICE),
    ).toBeTruthy();
  });

  it("refuses a settle whose activation was minted for another verb", async () => {
    server.state.forgeDecision = "denied";
    show();
    await approve();
    expect(
      await screen.findByRole("img", { name: /not accepted for this request/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Approved/ })).toBeNull();
    expect(
      listNotices().find((notice) => notice.id === APPROVAL_NOTICE),
    ).toBeTruthy();
  });

  it("refuses a settle whose activation was minted under a policy that changed", async () => {
    server.state.afterActivation = () => {
      server.state.policy = OTHER_POLICY;
    };
    show();
    await approve();
    expect(
      await screen.findByRole("img", {
        name: /rules for this request changed/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Approved/ })).toBeNull();
  });

  it("stops before the passkey when the activation comes back under another policy", async () => {
    show();
    await screen.findByRole("heading", { name: "Deploy the billing service" });
    // The requirement shown named POLICY; the authority now mints under
    // another one. The person is never asked for a passkey for it.
    server.state.policy = OTHER_POLICY;
    await approve();
    expect(
      await screen.findByRole("img", {
        name: /rules for this request changed/,
      }),
    ).toBeTruthy();
    expect(server.assert).not.toHaveBeenCalled();
    expect(settled()).toEqual([]);
    expect(POLICY).not.toBe(OTHER_POLICY);
  });

  it("shows the comparison mismatch as the security signal it is", async () => {
    show();
    await approve("000000");
    expect(
      await screen.findByRole("img", { name: /Someone else may have started/ }),
    ).toBeTruthy();
  });

  it("reports a request as not recognized", async () => {
    show();
    await screen.findByRole("heading", { name: "Deploy the billing service" });
    await userEvent.click(
      screen.getByRole("button", { name: "I don't recognize this request" }),
    );
    expect(
      await screen.findByRole("heading", { name: /Refused and reported/ }),
    );
    expect(server.calls.at(-1)?.body).toEqual({
      requestDigest: DIGEST,
      reason: "not_recognized",
    });
  });

  it("reads nothing without a session, and offers to connect", async () => {
    session.current = null;
    show();
    expect(screen.getByRole("img", { name: /Sign in to decide/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(server.calls).toEqual([]);
  });

  it("refuses a link that carried credential material, calling nothing", () => {
    show(`/approve/${AREQ}#id_token=leaked`);
    expect(location.hash).toBe("");
    expect(
      screen.getByRole("heading", { name: /no longer open/ }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: /refused as malformed/ }));
    expect(server.calls).toEqual([]);
  });
});
