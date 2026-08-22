import { overlapCast } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { type ReactElement, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdkBrowserSeams } from "../sdk-browser.js";
import { SignInPage } from "./SignInPage.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

interface MockClient {
  signIn: ReturnType<typeof vi.fn>;
  continueAnonymously: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
}

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

function buttonNamed(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`button "${text}" not rendered`);
  return button;
}

beforeEach(() => {
  client = {
    signIn: vi.fn(),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  };
  sdkBrowserSeams.createOpenSesame = vi.fn(() => overlapCast(client));
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("SignInPage", () => {
  it("offers upstream sign-in, a provisional session, and sign-out", async () => {
    await render(<SignInPage />);
    expect(container.textContent).toContain("Sign in");
    expect(buttonNamed("Sign in with OpenSesame")).toBeDefined();
    expect(buttonNamed("Continue anonymously")).toBeDefined();
    expect(buttonNamed("Sign out")).toBeDefined();
    expect(sdkBrowserSeams.createOpenSesame).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "opensesame-console" }),
    );
  });

  it("returns to idle when upstream sign-in succeeds", async () => {
    client.signIn.mockResolvedValue(undefined);
    await render(<SignInPage />);
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(client.signIn).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".err")).toBeNull();
    expect(buttonNamed("Sign in with OpenSesame").disabled).toBe(false);
  });

  it("shows the error message when upstream sign-in fails", async () => {
    client.signIn.mockRejectedValue(new Error("popup blocked"));
    await render(<SignInPage />);
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(container.textContent).toContain("popup blocked");
  });

  it("falls back to a generic message for non-Error sign-in failures", async () => {
    client.signIn.mockRejectedValue("weird");
    await render(<SignInPage />);
    await click(buttonNamed("Sign in with OpenSesame"));
    expect(container.textContent).toContain(
      "Sign-in failed. Check the Identity API and try again.",
    );
  });

  it("reports an active provisional session and forgets any stashed claim", async () => {
    sessionStorage.setItem(
      "opensesame.claim",
      JSON.stringify({ token: "osc_clm_x.secret", presented: false }),
    );
    client.continueAnonymously.mockResolvedValue({ anonymous: true });
    await render(<SignInPage />);
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Provisional session active");
    expect(sessionStorage.getItem("opensesame.claim")).toBeNull();
  });

  it("names the principal when the session is not anonymous", async () => {
    client.continueAnonymously.mockResolvedValue({
      anonymous: false,
      sub: "prn_9",
    });
    await render(<SignInPage />);
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Signed in as prn_9");
  });

  it("says unknown when the session carries no principal id", async () => {
    client.continueAnonymously.mockResolvedValue({ anonymous: false });
    await render(<SignInPage />);
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Signed in as unknown");
  });

  it("shows the failure when a provisional session cannot start", async () => {
    client.continueAnonymously.mockRejectedValue(new Error("IdP down"));
    await render(<SignInPage />);
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("IdP down");
  });

  it("falls back to a generic message for non-Error provisional failures", async () => {
    client.continueAnonymously.mockRejectedValue(503);
    await render(<SignInPage />);
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain(
      "Could not start a provisional session.",
    );
  });

  it("sign-out clears the session hint, the error, and any stashed claim", async () => {
    sessionStorage.setItem(
      "opensesame.claim",
      JSON.stringify({ token: "osc_clm_x.secret", presented: false }),
    );
    client.signIn.mockRejectedValue(new Error("popup blocked"));
    client.continueAnonymously.mockResolvedValue({ anonymous: true });
    client.signOut.mockResolvedValue(undefined);
    await render(<SignInPage />);
    await click(buttonNamed("Sign in with OpenSesame"));
    await click(buttonNamed("Continue anonymously"));
    expect(container.textContent).toContain("Provisional session active");
    await click(buttonNamed("Sign out"));
    expect(client.signOut).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output.ok")).toBeNull();
    expect(container.querySelector(".err")).toBeNull();
    expect(sessionStorage.getItem("opensesame.claim")).toBeNull();
  });
});
