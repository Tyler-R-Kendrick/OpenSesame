import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
// @vitest-environment jsdom
import { type ReactElement, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimRequestError, sdkBrowserSeams } from "../sdk-browser.js";
import { ClaimPage } from "./ClaimPage.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

interface MockClient {
  getSession: ReturnType<typeof vi.fn>;
  presentClaim: ReturnType<typeof vi.fn>;
  readClaim: ReturnType<typeof vi.fn>;
  completeClaim: ReturnType<typeof vi.fn>;
}

const OPEN_CLAIM = {
  id: "clm_1",
  type: "agent",
  state: "presented",
  targetManifestDigest: "sha256:abc",
  items: [{ id: "item-1" }, { id: "item-2" }],
};

let client: MockClient;
let container: HTMLDivElement;
let root: Root;

async function render(ui: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitToken(value: string): Promise<void> {
  await type(tokenField(), value);
  const form = container.querySelector("form");
  if (!form) throw new Error("token form not rendered");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function tokenField(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#claim-token");
  if (!input) throw new Error("claim token input not rendered");
  return input;
}

function consentField(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#claim-user-code");
  if (!input) throw new Error("consent code input not rendered");
  return input;
}

function buttonNamed(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`button "${text}" not rendered`);
  return button;
}

function seedStash(stash: BoundaryValue): void {
  sessionStorage.setItem("opensesame.claim", JSON.stringify(stash));
}

function stash(): JsonObject | null {
  const raw = sessionStorage.getItem("opensesame.claim");
  return raw ? overlapCast(JSON.parse(raw)) : null;
}

beforeEach(() => {
  client = {
    getSession: vi.fn().mockResolvedValue({ sub: "prn_1" }),
    presentClaim: vi.fn(),
    readClaim: vi.fn(),
    completeClaim: vi.fn(),
  };
  sdkBrowserSeams.createOpenSesame = vi.fn(() => overlapCast(client));
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("ClaimPage token phase", () => {
  it("keeps the review button disabled until a token is typed", async () => {
    await render(<ClaimPage />);
    expect(buttonNamed("Review claim").disabled).toBe(true);
    await type(tokenField(), "osc_clm_x");
    expect(buttonNamed("Review claim").disabled).toBe(false);
  });

  it("ignores a submit that is only whitespace", async () => {
    await render(<ClaimPage />);
    await submitToken("   ");
    expect(client.presentClaim).not.toHaveBeenCalled();
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("pauses for sign-in before spending an unpresented token", async () => {
    client.getSession.mockResolvedValue(null);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(client.presentClaim).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Sign in first. Reviewing spends this token",
    );
    expect(stash()).toEqual({ token: "osc_clm_x.secret", presented: false });
    expect(buttonNamed("I have signed in")).toBeDefined();
  });

  it("resumes the ceremony from the paused sign-in state", async () => {
    client.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ sub: "prn_1" });
    client.presentClaim.mockResolvedValue(OPEN_CLAIM);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    await click(buttonNamed("I have signed in"));
    expect(client.presentClaim).toHaveBeenCalledWith("osc_clm_x.secret");
    expect(container.textContent).toContain("sha256:abc");
  });
});

describe("ClaimPage presenting", () => {
  it("presents a token for a signed-in principal and shows the claim", async () => {
    client.presentClaim.mockResolvedValue(OPEN_CLAIM);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(client.presentClaim).toHaveBeenCalledWith("osc_clm_x.secret");
    expect(container.textContent).toContain("agent");
    expect(container.textContent).toContain("sha256:abc");
    expect(container.textContent).toContain("presented");
    expect(stash()).toEqual({
      token: "osc_clm_x.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
  });

  it("picks a token up from the URL hash and strips it from the address bar", async () => {
    window.location.hash = "#token=osc_clm_hash.secret";
    client.presentClaim.mockResolvedValue(OPEN_CLAIM);
    await render(<ClaimPage />);
    expect(client.presentClaim).toHaveBeenCalledWith("osc_clm_hash.secret");
    expect(window.location.hash).toBe("");
    expect(container.textContent).toContain("sha256:abc");
  });

  it("refuses a claim that was already completed", async () => {
    client.presentClaim.mockResolvedValue({
      ...OPEN_CLAIM,
      state: "completed",
    });
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "This claim was already completed.",
    );
    expect(stash()).toBeNull();
    expect(tokenField()).toBeDefined();
  });

  it("refuses a claim in any other unaccepted state", async () => {
    client.presentClaim.mockResolvedValue({ ...OPEN_CLAIM, state: "denied" });
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "This claim is denied and can no longer be accepted.",
    );
    expect(stash()).toBeNull();
  });

  it("drops a spent bearer when the server refuses it", async () => {
    client.presentClaim.mockRejectedValue(new ClaimRequestError("gone", 401));
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "This claim link is no longer valid. Ask for a fresh one.",
    );
    expect(stash()).toBeNull();
    expect(tokenField()).toBeDefined();
  });

  it("explains an expired claim", async () => {
    client.presentClaim.mockRejectedValue(
      new ClaimRequestError("expired", 410),
    );
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "This claim expired. Ask for a fresh one.",
    );
  });

  it("explains a claim that has already been decided", async () => {
    client.presentClaim.mockRejectedValue(
      new ClaimRequestError("decided", 422),
    );
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "This claim has already been decided.",
    );
  });

  it("keeps the bearer and offers a retry on a server-side failure", async () => {
    client.presentClaim
      .mockRejectedValueOnce(new ClaimRequestError("overloaded", 500))
      .mockResolvedValueOnce(OPEN_CLAIM);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain("overloaded");
    // A retryable failure keeps the bearer in the paused phase, not storage.
    await click(buttonNamed("Try again"));
    expect(client.presentClaim).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("sha256:abc");
  });

  it("shows the message of a plain network failure", async () => {
    client.presentClaim.mockRejectedValue(new Error("connection reset"));
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain("connection reset");
    expect(buttonNamed("Try again")).toBeDefined();
  });

  it("falls back to a generic message for non-Error failures", async () => {
    client.presentClaim.mockRejectedValue(undefined);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    expect(container.textContent).toContain(
      "Could not load this claim. Check the token and try again.",
    );
  });

  it("never presents the same bearer twice while a load is in flight", async () => {
    let release: (value: BoundaryValue) => void = () => {};
    client.presentClaim.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    client.getSession.mockResolvedValue(null);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    // Paused for sign-in; hammering the button must still present once.
    client.getSession.mockResolvedValue({ sub: "prn_1" });
    const button = buttonNamed("I have signed in");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    release(OPEN_CLAIM);
    await act(async () => {});
    expect(client.presentClaim).toHaveBeenCalledTimes(1);
  });
});

describe("ClaimPage resuming a presented claim", () => {
  it("reads the claim back when the stash and the session agree", async () => {
    seedStash({
      token: "osc_clm_x.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    client.readClaim.mockResolvedValue(OPEN_CLAIM);
    await render(<ClaimPage />);
    expect(client.readClaim).toHaveBeenCalledWith("clm_1", "osc_clm_x.secret");
    expect(client.presentClaim).not.toHaveBeenCalled();
    expect(container.textContent).toContain("sha256:abc");
  });

  it("pauses for sign-in when a presented claim is waiting", async () => {
    seedStash({
      token: "osc_clm_x.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    client.getSession.mockResolvedValue(null);
    await render(<ClaimPage />);
    expect(container.textContent).toContain(
      "Sign in to finish reviewing this claim. It is waiting, not lost.",
    );
    expect(client.readClaim).not.toHaveBeenCalled();
  });

  it("gives up on a presented stash that cannot say whose review it is", async () => {
    seedStash({ token: "osc_clm_x.secret", presented: true, claimId: "clm_1" });
    await render(<ClaimPage />);
    expect(container.textContent).toContain(
      "This claim was already presented and cannot be reopened here.",
    );
    expect(stash()).toBeNull();
    expect(client.readClaim).not.toHaveBeenCalled();
  });

  it("refuses to resume a claim another account opened in this tab", async () => {
    seedStash({
      token: "osc_clm_x.secret",
      presented: true,
      claimId: "clm_1",
      principalId: "prn_other",
    });
    await render(<ClaimPage />);
    expect(container.textContent).toContain(
      "This claim was opened by a different account in this tab.",
    );
    expect(stash()).toBeNull();
    expect(client.readClaim).not.toHaveBeenCalled();
  });
});

describe("ClaimPage completing", () => {
  async function renderOpen(
    presentation: JsonObject = OPEN_CLAIM,
  ): Promise<void> {
    client.presentClaim.mockResolvedValue(presentation);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    // Completion needs the code the claim's creator read out; the link on its
    // own is not meant to be enough to accept.
    if (container.querySelector("#claim-user-code")) {
      await type(consentField(), "WORD-WORD");
    }
  }

  it("completes an open claim as the same principal and clears the stash", async () => {
    client.completeClaim.mockResolvedValue({
      ...OPEN_CLAIM,
      state: "completed",
    });
    await renderOpen();
    await click(buttonNamed("Complete claim"));
    expect(client.completeClaim).toHaveBeenCalledWith("clm_1", {
      acceptedItemIds: ["item-1", "item-2"],
      userCode: "WORD-WORD",
      claimToken: "osc_clm_x.secret",
    });
    expect(container.textContent).toContain(
      "Claim completed. Ownership is attached to your principal.",
    );
    expect(stash()).toBeNull();
  });

  it("refuses to complete when the API never named what the claim covers", async () => {
    // An empty item list is a legitimate answer; no list at all is not. The
    // page stops rather than accepting an unknown set, even though presenting
    // has already spent the token by this point.
    const { items: _items, ...withoutItems } = OPEN_CLAIM;
    await renderOpen(withoutItems);
    expect(container.textContent).toContain("did not report");
    expect(client.completeClaim).not.toHaveBeenCalled();
  });

  it("refuses to complete without the consent code", async () => {
    // Holding the link is not consent. The server refuses a completion with no
    // code, and spending a single-use token to discover that is the wrong way
    // to find out.
    client.presentClaim.mockResolvedValue(OPEN_CLAIM);
    await render(<ClaimPage />);
    await submitToken("osc_clm_x.secret");
    await click(buttonNamed("Complete claim"));
    expect(client.completeClaim).not.toHaveBeenCalled();
  });

  it("abandons the completion when the signed-in account changed", async () => {
    await renderOpen();
    client.getSession.mockResolvedValue({ sub: "prn_other" });
    await click(buttonNamed("Complete claim"));
    expect(container.textContent).toContain(
      "The account signed in changed while this claim was open",
    );
    expect(client.completeClaim).not.toHaveBeenCalled();
    expect(stash()).toBeNull();
    expect(tokenField()).toBeDefined();
  });

  it("treats a spent refusal on completion as the end of the bearer", async () => {
    client.completeClaim.mockRejectedValue(
      new ClaimRequestError("decided", 409),
    );
    await renderOpen();
    await click(buttonNamed("Complete claim"));
    expect(container.textContent).toContain(
      "This claim has already been decided.",
    );
    expect(stash()).toBeNull();
    expect(tokenField()).toBeDefined();
  });

  it("keeps the claim open when completion fails retryably", async () => {
    client.completeClaim.mockRejectedValue(
      new ClaimRequestError("backend exploded", 500),
    );
    await renderOpen();
    await click(buttonNamed("Complete claim"));
    expect(container.textContent).toContain("backend exploded");
    expect(buttonNamed("Complete claim")).toBeDefined();
  });

  it("falls back to a generic message for non-Error completion failures", async () => {
    client.completeClaim.mockRejectedValue("nope");
    await renderOpen();
    await click(buttonNamed("Complete claim"));
    expect(container.textContent).toContain(
      "Claim could not be completed. Try again.",
    );
    expect(buttonNamed("Complete claim")).toBeDefined();
  });
});
