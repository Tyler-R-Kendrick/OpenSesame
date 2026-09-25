/** @vitest-environment jsdom */
/**
 * `/i/:ref` (ADR 0140 plan step 9): the approval opens with no vault, reads
 * what it asks, and settles only with an activation bound to this request —
 * its digest, the verb and the policy the authority minted it under
 * (ADR 0084 §5, ADR 0086 §4). The stand-in authority refuses exactly as the
 * Identity API does when any of the three moves; the screen must then show
 * the model's refusal and never an approval.
 */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import {
  captureInteractionArrivalFromPage,
  resetInteractionArrivalForTests,
} from "@opensesame/app-core/lib/interactions-link.js";
import { INTERACTION_NOTICE } from "@opensesame/app-core/lib/interactions-route.js";
import { interactionApproval } from "@opensesame/app-core/lib/interactions.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { InteractionScreen } from "./InteractionScreen.js";
import {
  DIGEST,
  OTHER_DIGEST,
  OTHER_POLICY,
  REF,
  ceremonyServer,
} from "./ceremony-server.test-support.js";
import { interactionHookSeams } from "./useInteraction.js";

const session: { current: IdentitySession | null } = { current: null };
const originalRemote = deviceIdentitySeams.remoteIdentityApi;
const originalApproval = interactionHookSeams.approval;
let server = ceremonyServer();

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => session.current,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

function show(address = `/i/${REF}`) {
  history.replaceState(null, "", address);
  captureInteractionArrivalFromPage();
  return render(
    <MemoryRouter initialEntries={[location.pathname]}>
      <InteractionScreen />
    </MemoryRouter>,
  );
}

const approveKey = () =>
  screen.findByRole("button", { name: "Approve with passkey" });

beforeEach(() => {
  server = ceremonyServer();
  session.current = overlapCast({ accessToken: "t", issuerOrigin: "x" });
  deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:8788";
  interactionHookSeams.approval = (ref) =>
    interactionApproval(ref, {
      transport: server.interactionTransport,
      authenticator: server.authenticator,
    });
  clearNotices();
});

afterEach(() => {
  cleanup();
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  interactionHookSeams.approval = originalApproval;
  resetInteractionArrivalForTests();
  history.replaceState(null, "", "/");
});

describe("the /i/:ref route", () => {
  it("opens with no vault, shows the match, and approves with an activation bound to it", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Approve a request" }));
    expect(await screen.findByText("Match 42")).toBeTruthy();
    await userEvent.click(await approveKey());
    expect(await screen.findByRole("heading", { name: /Approved/ }));
    const activation = server.calls.find((c) => c.path.endsWith("/activation"));
    const approve = server.calls.find((c) => c.path.endsWith("/approve"));
    // The activation names the digest shown and the verb; the approve names
    // the activation the authority verified and echoes the same digest.
    expect(activation?.body).toEqual({
      requestDigest: DIGEST,
      decision: "approved",
    });
    expect(approve?.body).toEqual({
      requestDigest: DIGEST,
      activationId: "act_1",
    });
    expect(server.assert).toHaveBeenCalledOnce();
    // The link was resolved with no session; nothing asked for a vault.
    expect(server.paths()[0]).toBe(`GET /i/${REF}`);
  });

  it("denies echoing the digest, with no passkey and no activation", async () => {
    show();
    await screen.findByText("Match 42");
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("heading", { name: /Denied/ }));
    expect(server.assert).not.toHaveBeenCalled();
    expect(server.paths()).not.toContain(
      `POST /v1/interactions/${REF}/activation`,
    );
    expect(server.calls.at(-1)?.body).toEqual({ requestDigest: DIGEST });
  });

  it("refuses an approval whose activation is bound to a request that changed", async () => {
    server.state.afterActivation = () => {
      server.state.digest = OTHER_DIGEST;
    };
    show();
    await userEvent.click(await approveKey());
    expect(
      await screen.findByRole("img", { name: /changed since it was shown/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Approved/ })).toBeNull();
    expect(
      listNotices().find((notice) => notice.id === INTERACTION_NOTICE),
    ).toBeTruthy();
  });

  it("refuses an activation minted for another verb", async () => {
    server.state.forgeDecision = "denied";
    show();
    await userEvent.click(await approveKey());
    expect(
      await screen.findByRole("img", { name: /passkey was not confirmed/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Approved/ })).toBeNull();
  });

  it("refuses an activation minted under a policy that has since changed", async () => {
    server.state.afterActivation = () => {
      server.state.policy = OTHER_POLICY;
    };
    show();
    await userEvent.click(await approveKey());
    expect(
      await screen.findByRole("img", { name: /passkey was not confirmed/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Approved/ })).toBeNull();
  });

  it("refuses before any passkey when the request changed while put down", async () => {
    show();
    await screen.findByText("Match 42");
    server.state.digest = OTHER_DIGEST;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(
      await screen.findByRole("img", { name: /changed since it was shown/ }),
    ).toBeTruthy();
    await userEvent.click(await approveKey());
    expect(server.assert).not.toHaveBeenCalled();
    expect(server.paths()).not.toContain(
      `POST /v1/interactions/${REF}/activation`,
    );
  });

  it("asks for a sign-in, and reads nothing, without a session", async () => {
    session.current = null;
    server.state.signedIn = false;
    show();
    expect(
      await screen.findByRole("heading", { name: /Read the request/ }),
    ).toBeTruthy();
    expect(server.paths()).toEqual([`GET /i/${REF}`]);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("refuses a link that carried credential material, calling nothing", async () => {
    show(`/i/${REF}#token=leaked`);
    expect(location.hash).toBe("");
    expect(await screen.findByRole("heading", { name: /Refused/ }));
    expect(screen.getByRole("img", { name: /credential material/ }));
    await waitFor(() => expect(server.calls).toEqual([]));
  });

  it("says a reference of the wrong shape was not found, calling nothing", async () => {
    show("/i/not-a-ref");
    expect(await screen.findByRole("heading", { name: /Not found/ }));
    expect(server.calls).toEqual([]);
  });
});
