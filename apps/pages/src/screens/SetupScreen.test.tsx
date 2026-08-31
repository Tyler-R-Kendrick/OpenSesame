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
  // The real pairing ceremony probes a tailnet; this step's contract with it
  // is only "mounts it, and re-reads settings when it reports paired".
  ConnectThisMachine: ({ onPaired }: { onPaired?: () => void }) => (
    <button
      type="button"
      onClick={() => {
        written.daemonApi = "https://kestrel.tail9c2f.ts.net";
        onPaired?.();
      }}
    >
      Pretend pairing succeeded
    </button>
  ),
});

import { federationSeams } from "../lib/federation.js";
Object.assign(federationSeams, {
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google (via shoo.dev)",
  }),
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

/** The screen's terminal commit — an ink square, never a text button. */
function commit(): HTMLElement {
  const foot = document.querySelector(".setup__foot");
  const go = foot?.querySelector(".go");
  if (!(go instanceof HTMLElement)) throw new Error("no commit control");
  return go;
}

describe("the setup ceremony", () => {
  it("asks sign-in first, and nothing that is not required", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(stepHeading()).toBe("How do people sign in?");
    // No URL field on arrival: the road that needs one is not the default.
    expect(screen.queryByLabelText("Identity service")).toBeNull();
    expect(screen.queryByLabelText("Host API")).toBeNull();
  });

  it("is two steps, not four", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(screen.getByText("1 / 2")).toBeDefined();
    fireEvent.click(commit());
    expect(stepHeading()).toBe("Anything else?");
    expect(screen.getByText("2 / 2")).toBeDefined();
  });

  it("finishes with nothing typed at all", async () => {
    // The whole point of leading with the brokered road: a deployment nobody
    // has configured is already usable, so setup can be two taps.
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(commit());
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      identity: "brokered",
      provider: "",
      host: false,
      machine: false,
    });
    expect(written.identityApi).toBe("");
  });

  it("selects the zero-config road on arrival", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    const brokered = screen.getByRole("radio", {
      name: /Google \(via shoo\.dev\)/,
    });
    // A narrowing guard rather than a cast: the road picker is real radio
    // inputs, and if that ever changes this should fail loudly here.
    if (!(brokered instanceof HTMLInputElement)) {
      throw new Error("the brokered road is not a radio input");
    }
    expect(brokered.checked).toBe(true);
  });

  it("names the road by what the sign-in screen will actually say", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(
      screen.getByRole("radio", { name: /Google \(via shoo\.dev\)/ }),
    ).toBeDefined();
  });

  it("records a deliberate no-accounts deployment", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("radio", { name: /No accounts/ }));
    fireEvent.click(commit());
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup.mock.calls[0]?.[0]?.identity).toBe("none");
  });

  it("hands back even when the record cannot be persisted", async () => {
    completeSetup.mockRejectedValue(new Error("OPFS unavailable"));
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(commit());
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("cannot go back from the first step", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(
      screen
        .getByRole("button", { name: "Previous step" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("lets the rail jump between steps", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Everything else" }));
    expect(stepHeading()).toBe("Anything else?");
    fireEvent.click(screen.getByRole("button", { name: "Sign-in" }));
    expect(stepHeading()).toBe("How do people sign in?");
  });
});

describe("bringing your own provider", () => {
  function chooseByo(): void {
    fireEvent.click(screen.getByRole("radio", { name: /Your own provider/ }));
  }

  it("asks for an identity service only on the road that needs one", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(screen.queryByLabelText("Identity service")).toBeNull();
    chooseByo();
    expect(fieldNamed("Identity service")).toBeDefined();
  });

  it("will not offer a provider before there is somewhere to register it", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    expect(
      screen.getByRole("button", { name: /WorkOS/ }).hasAttribute("disabled"),
    ).toBe(true);

    type("Identity service", "https://id.acme.com");
    expect(
      screen.getByRole("button", { name: /WorkOS/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("asks each preset for the field its issuer is built from", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");

    fireEvent.click(screen.getByRole("button", { name: /Okta/ }));
    expect(fieldNamed("Okta domain").placeholder).toBe("dev-123456.okta.com");

    fireEvent.click(screen.getByRole("button", { name: /Other OIDC/ }));
    expect(fieldNamed("Issuer URL").placeholder).toBe("https://idp.acme.com");
  });

  it("asks WorkOS for nothing — its issuer is fixed", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /WorkOS/ }));

    expect(screen.queryByLabelText("Deployment URL")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Register WorkOS" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("registers through the identity service and records the preset", async () => {
    registerByoProvider.mockResolvedValue({
      id: "byo-1",
      issuer: "https://acme.okta.com",
      label: "Okta",
      clientId: "client",
      clientAuth: "none",
      registrationSource: "dcr",
      redirectUri: "https://id.acme.com/cb",
    });
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");
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

    fireEvent.click(commit());
    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup.mock.calls[0]?.[0]).toMatchObject({
      identity: "byo",
      provider: "okta",
    });
  });

  it("refuses a malformed domain before it reaches the network", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");
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

  it("holds a bare issuer to https off loopback", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");
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

  it("says so when registration fails rather than claiming success", async () => {
    registerByoProvider.mockRejectedValue(
      new Error("The identity service couldn't be reached."),
    );
    render(<SetupScreen onDone={vi.fn()} />);
    chooseByo();
    type("Identity service", "https://id.acme.com");
    fireEvent.click(screen.getByRole("button", { name: /Auth0/ }));
    fireEvent.change(fieldNamed("Tenant domain"), {
      target: { value: "acme.auth0.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register Auth0" }));

    await screen.findByText("The identity service couldn't be reached.");
  });
});

describe("everything else", () => {
  function goToMore(): void {
    fireEvent.click(screen.getByRole("button", { name: "Everything else" }));
  }

  it("keeps every optional thing closed, and says what each already holds", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    goToMore();
    // Closed: the fields are not in the document until a row is opened.
    expect(screen.queryByLabelText("Host API")).toBeNull();
    expect(screen.queryByLabelText("Mobile MFA app")).toBeNull();
    // Readable without opening anything.
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
    expect(screen.getByText("not paired")).toBeDefined();
  });

  it("writes the Host only when an operator opens the row and types one", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    goToMore();
    fireEvent.click(screen.getByRole("button", { name: /^Host/ }));
    type("Host API", "https://host.acme.com/");
    expect(written.hostApi).toBe("https://host.acme.com");
  });

  it("re-reads the write-out after pairing writes settings behind it", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    goToMore();
    fireEvent.click(screen.getByRole("button", { name: /^This machine/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pretend pairing succeeded" }),
    );
    expect(screen.getByText("https://kestrel.tail9c2f.ts.net")).toBeDefined();
  });

  it("states every answer, including the ones left unset", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    goToMore();
    expect(screen.getByText("brokered")).toBeDefined();
    expect(screen.getAllByText("not set").length).toBeGreaterThan(0);
  });
});
