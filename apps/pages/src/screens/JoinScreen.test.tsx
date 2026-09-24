/** @vitest-environment jsdom */
/**
 * The join ceremony's invite road (ADR 0136): what each rung asks, what it
 * sends, and what it never does — spend an invite twice or where it cannot
 * be finished, send an offer's bearer to an endpoint it was not looked up
 * at, accept an optional item nobody chose, or keep authority after closing.
 */
import { JoinError } from "@opensesame/app-core/lib/join/client.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinScreen, joinScreenDependencies } from "./JoinScreen.js";
import {
  ENDPOINT,
  OFFER,
  OPTIONAL_ONLY,
  OTHER,
  TOKEN,
  approveAndVerify,
  fakes,
  go,
  installFakes,
  lookUp,
  renderInvite,
  restoreFakes,
  store,
  typeCode,
} from "./join/join-harness.js";
import { joinCeremonyDependencies } from "./join/useJoinCeremony.js";

beforeEach(installFakes);
afterEach(restoreFakes);

describe("the invite road", () => {
  it("walks approval, verify, look-up and choice, and ends its authority", async () => {
    const onDone = vi.fn();
    renderInvite(onDone);
    expect(
      screen.getByRole("heading", { name: "Join a session" }),
    ).toBeTruthy();
    // The bearer is masked, like any secret.
    expect(screen.getByLabelText<HTMLInputElement>("Invite").type).toBe(
      "password",
    );
    // The code is asked before approval's clock starts.
    expect(go().disabled).toBe(true);
    typeCode("bcdf ghjk");
    await approveAndVerify();
    // Nothing was spent before this browser was approved and verified.
    expect(fakes.presentInvite).not.toHaveBeenCalled();
    await lookUp();
    expect(fakes.presentInvite).toHaveBeenCalledWith(ENDPOINT, TOKEN);
    expect(store.marked.has(TOKEN)).toBe(true);
    const required = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /GitHub/,
    });
    const optional = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /Slack/,
    });
    expect(required.checked).toBe(true);
    expect(required.disabled).toBe(true);
    // Least privilege: what the owner offered optionally starts off.
    expect(optional.checked).toBe(false);
    // Nothing offered is shortened without saying so.
    expect(screen.getByText(/read \+3 more/)).toBeTruthy();
    expect(screen.getByText(/for 60 min/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("heading", { name: "Joined" });
    expect(fakes.claimInvite).toHaveBeenCalledWith(ENDPOINT, {
      token: TOKEN,
      code: "bcdf ghjk",
      acceptedItemIds: ["req"],
    });
    expect(fakes.completeSetup).toHaveBeenCalledWith(
      expect.objectContaining({ joined: true }),
    );
    expect(store.stash).toBeNull();
    expect(fakes.endJoinAuthority).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("names the account the operator is approving", async () => {
    joinScreenDependencies.currentSession = () => ({
      principalId: "prn_abc123",
      accessToken: "t",
      issuerOrigin: "https://id.example.org",
    });
    renderInvite();
    typeCode();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fakes.pollApproval.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    await screen.findByText("WXYZ-1234");
    expect(screen.getByText("prn_abc123")).toBeTruthy();
  });

  it("keeps the keyboard somewhere useful while the operator decides", async () => {
    // Approval never arrives: the commit waits, disabled, and the rung has
    // nothing to fill in — the keyboard must not fall to <body>.
    fakes.pollApproval.mockImplementation(() => new Promise(() => {}));
    renderInvite();
    typeCode();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    await screen.findByText("WXYZ-1234");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Start over" }),
      ),
    );
    expect(go().disabled).toBe(true);
  });

  it("resumes a looked-up offer instead of presenting it again", async () => {
    store.stash = { endpoint: ENDPOINT, token: TOKEN, offer: OFFER };
    renderInvite();
    typeCode();
    await approveAndVerify();
    expect(screen.getByRole("checkbox", { name: /GitHub/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
    expect(fakes.presentInvite).not.toHaveBeenCalled();
  });

  it("never sends a held offer's bearer to an endpoint it was not looked up at", async () => {
    store.stash = { endpoint: ENDPOINT, token: TOKEN, offer: OFFER };
    renderInvite();
    typeCode();
    fireEvent.change(screen.getByLabelText("Endpoint"), {
      target: { value: "https://elsewhere.example" },
    });
    await approveAndVerify("https://elsewhere.example");
    // The offer is let go of in memory: nothing to join yet.
    expect(screen.queryByRole("checkbox", { name: /GitHub/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("img", {
      name: /already looked up at another endpoint/,
    });
    expect(fakes.presentInvite).not.toHaveBeenCalled();
    expect(fakes.claimInvite).not.toHaveBeenCalled();
  });

  it("does not claim a held offer for a different invite", async () => {
    store.stash = { endpoint: ENDPOINT, token: TOKEN, offer: OFFER };
    renderInvite();
    typeCode();
    fireEvent.change(screen.getByLabelText("Invite"), {
      target: { value: OTHER },
    });
    await approveAndVerify();
    await lookUp();
    // The new invite is the one looked up, and the one that would be claimed.
    expect(fakes.presentInvite).toHaveBeenCalledWith(ENDPOINT, OTHER);
  });

  it("refuses to present an invite this device already sent to be looked up", async () => {
    store.marked.add(TOKEN);
    renderInvite();
    typeCode();
    await approveAndVerify();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("img", { name: /already opened on this device/ });
    expect(fakes.presentInvite).not.toHaveBeenCalled();
  });

  it("keeps the marker when a lookup's answer was lost, and drops it when refused", async () => {
    renderInvite();
    typeCode();
    await approveAndVerify();
    fakes.presentInvite.mockRejectedValueOnce(new JoinError("unreachable"));
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("img", { name: "The endpoint did not answer." });
    expect(store.marked.has(TOKEN)).toBe(true);
    store.marked.clear();
    fakes.presentInvite.mockRejectedValueOnce(new JoinError("verify_failed"));
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("img", {
      name: "Verification was refused or expired.",
    });
    expect(store.marked.has(TOKEN)).toBe(false);
  });

  it("will not join with nothing chosen", async () => {
    fakes.presentInvite.mockImplementation(async () => OPTIONAL_ONLY);
    renderInvite();
    typeCode();
    await approveAndVerify();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    const slack = await screen.findByRole("checkbox", { name: /Slack/ });
    expect(go().disabled).toBe(true);
    fireEvent.click(slack);
    expect(go().disabled).toBe(false);
  });

  it("hands the keyboard to the code when it did not match", async () => {
    fakes.claimInvite.mockRejectedValueOnce(new JoinError("code_mismatch"));
    renderInvite();
    typeCode();
    await approveAndVerify();
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("img", { name: /did not match/ });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Code")),
    );
  });

  it("forgets a dead offer so it does not come back", async () => {
    fakes.claimInvite.mockRejectedValueOnce(new JoinError("invite_spent"));
    renderInvite();
    typeCode();
    await approveAndVerify();
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("img", { name: /can no longer be used/ });
    expect(store.stash).toBeNull();
  });

  it("flags an endpoint that is not this deployment's own", () => {
    render(
      <JoinScreen
        captured={{
          kind: "invite",
          invite: { token: TOKEN, endpoint: "https://elsewhere.example" },
        }}
        configured={ENDPOINT}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Not this deployment's own endpoint" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Endpoint").value).toBe(
      "https://elsewhere.example",
    );
  });

  it("refuses a leaked link and spends nothing", () => {
    render(
      <JoinScreen
        captured={{ kind: "leaked" }}
        configured={ENDPOINT}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Ask the sender for a fresh invite/ }),
    ).toBeTruthy();
    expect(go().disabled).toBe(true);
  });

  it("spends nothing where a join cannot be finished", () => {
    joinCeremonyDependencies.joinAvailable = () => false;
    renderInvite();
    typeCode();
    expect(
      screen.getByRole("img", { name: /This address cannot finish a join/ }),
    ).toBeTruthy();
    expect(go().disabled).toBe(true);
    expect(fakes.presentInvite).not.toHaveBeenCalled();
  });

  it("closing ends the authority but keeps the looked-up offer", async () => {
    const onDone = vi.fn();
    renderInvite(onDone);
    typeCode();
    await approveAndVerify();
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDone).toHaveBeenCalled();
    expect(fakes.endJoinAuthority).toHaveBeenCalled();
    expect(store.stash?.token).toBe(TOKEN);
  });

  it("cannot be closed while a lookup is in flight", async () => {
    fakes.presentInvite.mockImplementation(() => new Promise(() => {}));
    renderInvite();
    typeCode();
    await approveAndVerify();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Close" })
          .disabled,
      ).toBe(true),
    );
  });
});
