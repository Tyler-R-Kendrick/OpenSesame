import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PagesSettings } from "../lib/settings.js";
import { settingsSeams } from "../lib/settings.js";

type Written = Pick<
  PagesSettings,
  "identityApi" | "hostApi" | "daemonApi" | "mfaAppUrl"
>;

const written: Written = {
  identityApi: "",
  hostApi: "",
  daemonApi: "",
  mfaAppUrl: "",
};

const originalSettingsSeams = { ...settingsSeams };

function currentSettings(): PagesSettings {
  return { ...originalSettingsSeams.loadSettings(), ...written };
}

Object.assign(settingsSeams, {
  loadSettings: () => currentSettings(),
  saveSettings: (next: PagesSettings) => {
    written.identityApi = next.identityApi;
    written.hostApi = next.hostApi;
    written.daemonApi = next.daemonApi;
    written.mfaAppUrl = next.mfaAppUrl;
  },
  pageIsLoopback: () => false,
});

import { planeNoteSeams } from "../components/PlaneNote.js";
Object.assign(planeNoteSeams, {
  // The real pairing ceremony probes a tailnet; the setup step's contract with
  // it is only "mounts it, and moves on when it reports paired".
  ConnectThisMachine: ({ onPaired }: { onPaired?: () => void }) => (
    <button type="button" onClick={() => onPaired?.()}>
      Pretend pairing succeeded
    </button>
  ),
});

import { byoSeams } from "../lib/byo.js";
const registerByoProvider = vi.fn();
Object.assign(byoSeams, { registerByoProvider });

import { SetupScreen, setupScreenDependencies } from "./SetupScreen.js";

const completeSetup =
  vi.fn<
    (outcome: {
      identity: string;
      provider: string;
      host: boolean;
      machine: boolean;
    }) => Promise<void>
  >();

beforeEach(() => {
  written.identityApi = "";
  written.hostApi = "";
  written.daemonApi = "";
  written.mfaAppUrl = "";
  registerByoProvider.mockReset();
  completeSetup.mockReset();
  completeSetup.mockResolvedValue(undefined);
  Object.assign(setupScreenDependencies, {
    loadSettings: () => currentSettings(),
    completeSetup,
    initialStep: () => "identity" as const,
  });
});

afterEach(cleanup);

function fieldNamed(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`${String(label)} is not an input`);
  }
  return element;
}

function type(label: string | RegExp, value: string): void {
  const input = fieldNamed(label);
  fireEvent.change(input, { target: { value } });
  // Setup fields commit on blur, exactly as the Settings panel's do.
  fireEvent.blur(input);
}

function stepHeading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

describe("the setup ceremony", () => {
  it("walks the four steps from a bare deployment", () => {
    render(<SetupScreen onDone={vi.fn()} />);

    expect(stepHeading()).toBe("Where does identity live?");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(stepHeading()).toBe("Is there a Host?");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(stepHeading()).toBe("Pair this machine");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(stepHeading()).toBe("Ready");
    // The last step commits rather than continuing.
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeDefined();
  });

  it("opens on the step the deployment has not answered", () => {
    setupScreenDependencies.initialStep = () => "review";
    render(<SetupScreen onDone={vi.fn()} />);
    expect(stepHeading()).toBe("Ready");
  });

  it("keeps the commitment in one place on every step", () => {
    // The whole of the mobile fix: the primary action never moves, so it is
    // never something to hunt for after a field expands.
    render(<SetupScreen onDone={vi.fn()} />);
    for (const _ of [0, 1, 2]) {
      const foot = document.querySelector(".setup__foot");
      expect(foot?.querySelector(".btn--primary")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    const foot = document.querySelector(".setup__foot");
    expect(foot?.querySelector(".btn--primary")?.textContent).toBe(
      "Finish setup",
    );
  });

  it("lets the rail jump straight to a step", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(stepHeading()).toBe("Ready");
    fireEvent.click(screen.getByRole("button", { name: "Identity" }));
    expect(stepHeading()).toBe("Where does identity live?");
  });

  it("cannot go back from the first step", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    const back = screen.getByRole("button", { name: "Previous step" });
    expect(back.hasAttribute("disabled")).toBe(true);
  });

  it("skipping a step is moving on, not abandoning setup", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip identity" }));
    expect(stepHeading()).toBe("Is there a Host?");
    fireEvent.click(screen.getByRole("button", { name: "No Host" }));
    expect(stepHeading()).toBe("Pair this machine");
  });

  it("writes the endpoints the operator typed", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com/");
    expect(written.identityApi).toBe("https://id.acme.com");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    type("Host API", "https://host.acme.com/");
    expect(written.hostApi).toBe("https://host.acme.com");
  });

  it("records what was answered and hands back", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      identity: "connected",
      provider: "",
      host: false,
      machine: false,
    });
  });

  it("records a deliberate local-only deployment as such", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup.mock.calls[0]?.[0]?.identity).toBe("local-only");
  });

  it("hands back even when the record cannot be persisted", async () => {
    // A browser with no durable storage must not strand the operator on the
    // last step; it will simply ask again next time.
    completeSetup.mockRejectedValue(new Error("OPFS unavailable"));
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("moves on by itself once a daemon pairs", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Machine" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pretend pairing succeeded" }),
    );
    expect(stepHeading()).toBe("Ready");
  });

  it("hands the Host step over to pairing rather than duplicating it", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Host" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Let a paired daemon front it" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to pairing" }));
    expect(stepHeading()).toBe("Pair this machine");
  });
});

describe("the identity step", () => {
  it("will not offer a provider before there is somewhere to register it", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    // Presets register *through* the Identity API by OIDC discovery, so an
    // issuer typed before the address has nowhere to go.
    expect(
      screen.getByRole("button", { name: /WorkOS/ }).hasAttribute("disabled"),
    ).toBe(true);

    type("Identity API", "https://id.acme.com");
    expect(
      screen.getByRole("button", { name: /WorkOS/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("asks each preset for the field its issuer is built from", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");

    fireEvent.click(screen.getByRole("button", { name: /Okta/ }));
    expect(fieldNamed("Okta domain").placeholder).toBe("dev-123456.okta.com");

    fireEvent.click(screen.getByRole("button", { name: /Better Auth/ }));
    expect(fieldNamed("Deployment URL").placeholder).toBe(
      "https://auth.acme.com",
    );
  });

  it("asks WorkOS for nothing — its issuer is fixed", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /WorkOS/ }));

    expect(screen.queryByLabelText("Deployment URL")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Register WorkOS" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("registers through the Identity API and records the preset", async () => {
    registerByoProvider.mockResolvedValue({
      id: "byo-1",
      issuer: "https://acme.okta.com",
      label: "Okta",
      clientId: "client",
      clientAuth: "none",
      registrationSource: "dcr",
      redirectUri: "https://id.acme.com/cb",
    });
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Okta/ }));
    fireEvent.change(fieldNamed("Okta domain"), {
      target: { value: "acme.okta.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register Okta" }));

    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenCalledWith({
        issuer: "https://acme.okta.com",
      }),
    );
    await screen.findByText(/Okta registered/);
  });

  it("offers a bare issuer URL for a provider with no preset", async () => {
    // Keycloak, Authentik, Zitadel, a deployment's own server: not an edge
    // case on first run, and the sign-in screen's globe is on a screen the
    // operator has not reached yet.
    registerByoProvider.mockResolvedValue({
      id: "byo-2",
      issuer: "https://idp.acme.com",
      label: "idp.acme.com",
      clientId: "client",
      clientAuth: "none",
      registrationSource: "dcr",
      redirectUri: "https://id.acme.com/cb",
    });
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Other OIDC/ }));
    fireEvent.change(fieldNamed("Issuer URL"), {
      target: { value: "https://idp.acme.com/" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Register Other OIDC" }),
    );

    await waitFor(() =>
      expect(registerByoProvider).toHaveBeenCalledWith({
        issuer: "https://idp.acme.com",
      }),
    );
  });

  it("holds a bare issuer to https off loopback", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Other OIDC/ }));
    fireEvent.change(fieldNamed("Issuer URL"), {
      target: { value: "http://idp.acme.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Register Other OIDC" }),
    );

    expect(registerByoProvider).not.toHaveBeenCalled();
    expect(
      screen.getByText("https is required, except on localhost for local dev."),
    ).toBeDefined();
  });

  it("refuses a malformed domain before it reaches the network", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Okta/ }));
    fireEvent.change(fieldNamed("Okta domain"), {
      target: { value: "not-an-okta-domain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register Okta" }));

    expect(registerByoProvider).not.toHaveBeenCalled();
    expect(
      screen.getByText("Use your Okta domain, like dev-123456.okta.com."),
    ).toBeDefined();
  });

  it("says so when registration fails rather than claiming success", async () => {
    registerByoProvider.mockRejectedValue(
      new Error("The identity service couldn't be reached."),
    );
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Auth0/ }));
    fireEvent.change(fieldNamed("Tenant domain"), {
      target: { value: "acme.auth0.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register Auth0" }));

    await screen.findByText("The identity service couldn't be reached.");
  });
});

describe("the review step", () => {
  it("states every answer, including the ones left unset", () => {
    written.identityApi = "https://id.acme.com";
    written.daemonApi = "https://kestrel.tail9c2f.ts.net";
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("https://id.acme.com")).toBeDefined();
    expect(screen.getByText("https://kestrel.tail9c2f.ts.net")).toBeDefined();
    // An operator who chose to run without a Host should see the choice
    // recorded, not an absence they have to infer.
    expect(screen.getAllByText("not set").length).toBeGreaterThan(0);
  });

  it("re-reads settings written by an earlier step", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    type("Identity API", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("https://id.acme.com")).toBeDefined();
  });

  it("keeps the rarer endpoint behind a disclosure", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.queryByLabelText("Mobile MFA app")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More endpoints" }));
    type("Mobile MFA app", "https://mfa.acme.com/");
    expect(written.mfaAppUrl).toBe("https://mfa.acme.com");
  });
});
