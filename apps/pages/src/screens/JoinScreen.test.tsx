/** @vitest-environment jsdom */
import { JoinError } from "@opensesame/app-core/lib/join/client.js";
import type { JoinOffer } from "@opensesame/app-core/lib/join/wire.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinScreen } from "./JoinScreen.js";
import { joinCeremonyDependencies } from "./join/useJoinCeremony.js";

/**
 * The join ceremony (ADR 0136): what each rung asks, what it sends, and what
 * it never does — spend an invite where it cannot be finished, accept an
 * optional item nobody chose, or keep authority after it closes.
 */

const TOKEN = `osc_dlg_dlgo_${"a".repeat(32)}.${"B".repeat(43)}`;
const ENDPOINT = "https://vault.example.org";
const original = { ...joinCeremonyDependencies };

const OFFER: JoinOffer = {
  id: "dlgo_1",
  manifestDigest: "sha256:ab",
  expiresAt: Date.now() + 10 * 60_000,
  items: [
    {
      id: "req",
      displayName: "GitHub · acme",
      providerId: "github",
      actions: ["read"],
      resources: ["repo:acme/app"],
      required: true,
      dependencies: [],
    },
    {
      id: "opt",
      displayName: "Slack · #ops",
      providerId: "slack",
      actions: ["post"],
      resources: [],
      required: false,
      dependencies: [],
    },
  ],
};

let stash: ReturnType<typeof original.readPendingJoin> = null;
const fakes = {
  presentInvite: vi.fn(async () => OFFER),
  beginApproval: vi.fn(async () => ({
    pairingId: "p1",
    userCode: "WXYZ-1234",
    verificationUri: `${ENDPOINT}/pair`,
    expiresAt: Date.now() + 60_000,
    interval: 0,
  })),
  pollApproval: vi.fn(async () => true),
  verifyAt: vi.fn<typeof original.verifyAt>(async () => undefined),
  claimInvite: vi.fn(async () => 1),
  listOpenSessions: vi.fn(async () => [
    { id: "session:1", displayName: "Design review" },
  ]),
  askToJoin: vi.fn(async () => ({ id: "r1", decision: "pending" as const })),
  endJoinAuthority: vi.fn(),
  completeSetup: vi.fn(async () => undefined),
};

beforeEach(() => {
  stash = null;
  for (const fake of Object.values(fakes)) fake.mockClear();
  Object.assign(joinCeremonyDependencies, fakes, {
    joinAvailable: () => true,
    configuredEndpoint: () => ENDPOINT,
    readPendingJoin: () => stash,
    writePendingJoin: (next: typeof stash) => {
      stash = next;
    },
    clearPendingJoin: () => {
      stash = null;
    },
    loadSetup: () => null,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(joinCeremonyDependencies, original);
});

/** Where → approval (the operator approves at once) → verify → the offer. */
async function approveAndVerify() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Ask for approval" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Verify with a passkey" }),
  );
  await screen.findByRole("heading", { name: "What you would get" });
  expect(fakes.verifyAt.mock.calls[0]?.[0]).toBe(ENDPOINT);
}

function go(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(".go");
  if (!found) throw new Error("the ceremony has no commit");
  return found;
}

describe("the invite road", () => {
  it("walks approval, verify, look-up, choice and code, and ends its authority", async () => {
    const onDone = vi.fn();
    render(
      <JoinScreen
        captured={{ kind: "invite", invite: { token: TOKEN, endpoint: null } }}
        configured={ENDPOINT}
        onDone={onDone}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Join a session" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(go());
    await approveAndVerify();
    // Nothing was spent before this browser was approved and verified.
    expect(fakes.presentInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("checkbox", { name: /GitHub/ });
    expect(fakes.presentInvite).toHaveBeenCalledWith(ENDPOINT, TOKEN);
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

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with these" }),
    );
    fireEvent.change(await screen.findByLabelText("Code"), {
      target: { value: "bcdf ghjk" },
    });
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
    expect(stash).toBeNull();
    expect(fakes.endJoinAuthority).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("resumes a looked-up offer instead of presenting it again", async () => {
    stash = { endpoint: ENDPOINT, token: TOKEN, offer: OFFER };
    render(
      <JoinScreen
        captured={{ kind: "invite", invite: { token: TOKEN, endpoint: null } }}
        configured={ENDPOINT}
        onDone={() => {}}
      />,
    );
    await approveAndVerify();
    expect(screen.getByRole("checkbox", { name: /GitHub/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with these" }),
    ).toBeTruthy();
    expect(fakes.presentInvite).not.toHaveBeenCalled();
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
    render(
      <JoinScreen
        captured={{ kind: "invite", invite: { token: TOKEN, endpoint: null } }}
        configured={ENDPOINT}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: /This address cannot finish a join/ }),
    ).toBeTruthy();
    expect(go().disabled).toBe(true);
    expect(fakes.presentInvite).not.toHaveBeenCalled();
  });

  it("closing ends the authority but keeps the looked-up offer", async () => {
    const onDone = vi.fn();
    render(
      <JoinScreen
        captured={{ kind: "invite", invite: { token: TOKEN, endpoint: null } }}
        configured={ENDPOINT}
        onDone={onDone}
      />,
    );
    await approveAndVerify();
    fireEvent.click(screen.getByRole("button", { name: "Look up the invite" }));
    await screen.findByRole("checkbox", { name: /GitHub/ });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDone).toHaveBeenCalled();
    expect(fakes.endJoinAuthority).toHaveBeenCalled();
    expect(stash?.token).toBe(TOKEN);
  });
});

describe("the open road", () => {
  it("asks into a listed session with a note, and says it is waiting", async () => {
    render(
      <JoinScreen captured={null} configured={ENDPOINT} onDone={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(screen.queryByLabelText("Invite")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify with a passkey" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Design review/ }),
    );
    fireEvent.change(screen.getByLabelText("Note for the operator"), {
      target: { value: "from design" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    await screen.findByRole("heading", { name: "Asked" });
    expect(fakes.askToJoin).toHaveBeenCalledWith(
      ENDPOINT,
      "session:1",
      "from design",
    );
    expect(screen.getByText("waiting on the operator")).toBeTruthy();
  });

  it("marks a failure beside the field it belongs to", async () => {
    fakes.askToJoin.mockRejectedValueOnce(new JoinError("already_asked"));
    render(
      <JoinScreen captured={null} configured={ENDPOINT} onDone={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify with a passkey" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Design review/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Your request is already waiting." }),
      ).toBeTruthy(),
    );
  });
});
