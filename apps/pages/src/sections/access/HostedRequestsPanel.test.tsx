/** @vitest-environment jsdom */
/**
 * Access › Requests' hosted rows (ADR 0140 plan step 9): each request the
 * Identity session was asked opens its review at `/approve/<ref>`, and
 * nothing on the list approves or denies — not even a row whose policy asks
 * for no more than a decision.
 */
import { listHostedRequests } from "@opensesame/app-core/lib/approvals.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import {
  AREQ,
  ceremonyServer,
} from "../../modules/identity.ceremonies/ceremony-server.test-support.js";
import {
  HostedRequestsPanel,
  hostedRequestsSeams,
} from "./HostedRequestsPanel.js";

const session: { current: IdentitySession | null } = { current: null };
const connect = vi.fn();
const originalList = hostedRequestsSeams.list;
let server = ceremonyServer();

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect, connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

function show() {
  return render(
    <MemoryRouter initialEntries={["/access/requests"]}>
      <Routes>
        <Route path="/access/:tab" element={<HostedRequestsPanel />} />
        <Route path="/approve/:ref" element={<p>review route</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  server = ceremonyServer();
  session.current = overlapCast({ accessToken: "t", issuerOrigin: "x" });
  hostedRequestsSeams.list = () => listHostedRequests(server.approvalTransport);
});

afterEach(() => {
  cleanup();
  hostedRequestsSeams.list = originalList;
  connect.mockReset();
});

describe("Access › Requests' hosted rows", () => {
  it("links each row to its review, and decides nothing on the list", async () => {
    show();
    expect(await screen.findByText("Deploy the billing service")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Review request" });
    expect(open.getAttribute("href")).toBe(`/approve/${AREQ}`);
    for (const name of [/approve/i, /deny/i, /recognize/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    await userEvent.click(open);
    expect(await screen.findByText("review route")).toBeTruthy();
    expect(server.paths()).toEqual([
      "GET /v1/authorization-requests?status=pending",
    ]);
  });

  it("links a row that asks for no ceremony to its review too", async () => {
    server.state.requireActivation = false;
    server.state.requireComparison = false;
    show();
    await screen.findByText("Deploy the billing service");
    expect(
      screen.getByRole("link", { name: "Review request" }).getAttribute("href"),
    ).toBe(`/approve/${AREQ}`);
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("fetches nothing without a session, and offers to connect", async () => {
    session.current = null;
    server.state.signedIn = false;
    show();
    expect(
      await screen.findByRole("img", { name: /needs you signed in/ }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(server.calls).toEqual([]);
  });
});
