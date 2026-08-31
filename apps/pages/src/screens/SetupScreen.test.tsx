import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PagesSettings, SignInMethods } from "../lib/settings.js";
import { defaultSignInMethods, settingsSeams } from "../lib/settings.js";

type Written = Pick<PagesSettings, "identityApi" | "hostApi" | "daemonApi"> & {
  signIn: SignInMethods;
};

const written: Written = {
  identityApi: "",
  hostApi: "",
  daemonApi: "",
  signIn: defaultSignInMethods(),
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
    written.signIn = next.signIn ?? defaultSignInMethods();
  },
  pageIsLoopback: () => false,
});

import type { OidcDiscovery } from "../lib/federation.js";
import { federationSeams } from "../lib/federation.js";
Object.assign(federationSeams, {
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google (via shoo.dev)",
  }),
});

import { SetupScreen, setupScreenDependencies } from "./SetupScreen.js";
import { waysInDependencies } from "./setup/WaysIn.js";

/** The one network call the ceremony makes: the provider's discovery doc. */
const discover = vi.fn<(issuer: string) => Promise<OidcDiscovery>>();

/** What `addProvider` needs to fill one preset's form. */
type ProviderFields = {
  /** `[field label, value]` for the presets whose issuer is typed. */
  issuer?: [string, string];
  clientId: string;
};

const completeSetup =
  vi.fn<(outcome: { ways: string[]; service: boolean }) => Promise<void>>();

beforeEach(() => {
  written.identityApi = "";
  written.hostApi = "";
  written.daemonApi = "";
  written.signIn = defaultSignInMethods();
  discover.mockReset();
  discover.mockResolvedValue({
    issuer: "https://acme.okta.com",
    authorization_endpoint: "https://acme.okta.com/authorize",
    token_endpoint: "https://acme.okta.com/token",
    jwks_uri: "https://acme.okta.com/keys",
  });
  completeSetup.mockReset();
  completeSetup.mockResolvedValue(undefined);
  Object.assign(waysInDependencies, {
    discover,
    redirectUri: () => "https://tyler-r-kendrick.github.io/OpenSesame/",
  });
  Object.assign(setupScreenDependencies, {
    completeSetup,
    loadSettings: () => currentSettings(),
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

function heading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

/** The screen's terminal commit — an ink square, never a text button. */
function commit(): HTMLElement {
  const foot = document.querySelector(".setup__foot");
  const go = foot?.querySelector(".go");
  if (!(go instanceof HTMLElement)) throw new Error("no commit control");
  return go;
}

/** The ways-in list, as it reads on screen. */
function ways(): string[] {
  return [...document.querySelectorAll(".ways__name")].map(
    (node) => node.textContent ?? "",
  );
}

async function addProvider(
  preset: RegExp,
  fields: ProviderFields,
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: preset }));
  if (fields.issuer) {
    fireEvent.change(fieldNamed(fields.issuer[0]), {
      target: { value: fields.issuer[1] },
    });
  }
  fireEvent.change(fieldNamed("Client ID"), {
    target: { value: fields.clientId },
  });
  const add = screen.getByRole("button", { name: /^Add / });
  fireEvent.click(add);
  await waitFor(() => expect(discover).toHaveBeenCalled());
}

describe("the setup ceremony", () => {
  it("is one screen asking one question", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(heading()).toBe("How do people sign in?");
    // No stepper, no counter, no skip, no back: there is nowhere else to go.
    expect(screen.queryByRole("button", { name: "Previous step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(document.querySelector(".setup__rail")).toBeNull();
    expect(document.querySelector(".setup__count")).toBeNull();
  });

  it("never asks for a Host API or for pairing this machine", () => {
    // Both were setup questions in earlier shapes of this screen, and neither
    // is one a first-time visitor has. A Host is optional infrastructure that
    // gates nothing the vault does on its own; the daemon pairing is for a
    // machine you already run OpenSesame on. Settings → Endpoints owns them.
    render(<SetupScreen onDone={vi.fn()} />);
    expect(screen.queryByLabelText("Host API")).toBeNull();
    expect(screen.queryByLabelText("Mobile MFA app")).toBeNull();
    expect(screen.queryByText(/This machine/)).toBeNull();
    expect(screen.queryByText(/not paired/)).toBeNull();
  });

  it("arrives with the compiled-in broker already a way in", () => {
    // The whole point: a deployment nobody has configured is already usable,
    // so setup can be one tap.
    render(<SetupScreen onDone={vi.fn()} />);
    expect(ways()).toEqual(["Google (via shoo.dev)"]);
  });

  it("finishes with nothing typed at all", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
    });
    expect(written.identityApi).toBe("");
  });

  it("hands back even when the record cannot be persisted", async () => {
    completeSetup.mockRejectedValue(new Error("OPFS unavailable"));
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe("building the list of ways in", () => {
  it("takes as many providers as the operator wants", async () => {
    // The complaint this answers: one provider is not a deployment. Most want
    // Google for everybody and an org's own IdP for staff.
    render(<SetupScreen onDone={vi.fn()} />);
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    await addProvider(/^Okta/, {
      issuer: ["Okta domain", "acme.okta.com"],
      clientId: "0oa1b2c3d4EXAMPLE",
    });
    await addProvider(/Other OIDC/, {
      issuer: ["Issuer URL", "https://idp.acme.com"],
      clientId: "generic",
    });

    expect(ways()).toEqual([
      "Google (via shoo.dev)",
      "Google",
      "Okta",
      "Other OIDC",
    ]);
    expect(written.signIn.providers.map((idp) => idp.issuer)).toEqual([
      "https://accounts.google.com",
      "https://acme.okta.com",
      "https://idp.acme.com",
    ]);
    // Nothing went to an OpenSesame identity service, because there is none
    // and none is needed: the browser runs each of these itself.
    expect(written.identityApi).toBe("");
  });

  it("brands each provider with the mark it will wear at sign-in", async () => {
    render(<SetupScreen onDone={vi.fn()} />);
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    expect(written.signIn.providers[0]?.providerId).toBe("google");
  });

  it("refuses the same issuer twice", async () => {
    render(<SetupScreen onDone={vi.fn()} />);
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    discover.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Google/ }));
    fireEvent.change(fieldNamed("Client ID"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Google" }));

    await screen.findByText(/already a way in/);
    expect(discover).not.toHaveBeenCalled();
    expect(written.signIn.providers).toHaveLength(1);
  });

  it("takes a way back out again", async () => {
    render(<SetupScreen onDone={vi.fn()} />);
    await addProvider(/^Google/, { clientId: "google-client.apps" });

    fireEvent.click(screen.getByRole("button", { name: "Remove Google" }));
    expect(written.signIn.providers).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Google (via shoo.dev)" }),
    );
    expect(written.signIn.builtin).toBe(false);
  });

  it("says plainly what removing everything means", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Google (via shoo.dev)" }),
    );

    expect(ways()).toEqual([]);
    expect(screen.getByText(/local vault only/)).toBeDefined();

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // A deployment with no accounts is a decision, recorded as one.
    expect(completeSetup).toHaveBeenCalledWith({ ways: [], service: false });
  });

  it("shows the redirect URI the operator has to register", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    expect(fieldNamed("Redirect URI to register").value).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/",
    );
  });

  it("asks each preset for the field its issuer is built from", () => {
    render(<SetupScreen onDone={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    expect(fieldNamed("Okta domain").placeholder).toBe("dev-123456.okta.com");

    fireEvent.click(screen.getByRole("button", { name: /Other OIDC/ }));
    expect(fieldNamed("Issuer URL").placeholder).toBe("https://idp.acme.com");

    // Google and WorkOS each publish one issuer for everybody.
    fireEvent.click(screen.getByRole("button", { name: /^Google/ }));
    expect(screen.queryByLabelText("Issuer URL")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add Google" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(fieldNamed("Client ID"), { target: { value: "abc" } });
    expect(
      screen
        .getByRole("button", { name: "Add Google" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("refuses a malformed domain before it reaches the network", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    fireEvent.change(fieldNamed("Okta domain"), {
      target: { value: "not-an-okta-domain" },
    });
    fireEvent.change(fieldNamed("Client ID"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Okta" }));

    expect(discover).not.toHaveBeenCalled();
    expect(
      screen.getByText("Use your Okta domain, like dev-123456.okta.com."),
    ).toBeDefined();
  });

  it("holds a bare issuer to https off loopback", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other OIDC/ }));
    fireEvent.change(fieldNamed("Issuer URL"), {
      target: { value: "http://idp.acme.com" },
    });
    fireEvent.change(fieldNamed("Client ID"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Other OIDC" }));

    expect(discover).not.toHaveBeenCalled();
    expect(
      screen.getByText("https is required, except on localhost for local dev."),
    ).toBeDefined();
  });

  it("keeps nothing when the issuer does not answer", async () => {
    // Saving an unreachable provider would re-create the bug this whole screen
    // exists to remove: a deployment that reads as configured and dead-ends at
    // the first sign-in.
    discover.mockRejectedValue(
      new Error("Could not reach https://acme.okta.com."),
    );
    render(<SetupScreen onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    fireEvent.change(fieldNamed("Okta domain"), {
      target: { value: "acme.okta.com" },
    });
    fireEvent.change(fieldNamed("Client ID"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Okta" }));

    await screen.findByText("Could not reach https://acme.okta.com.");
    expect(written.signIn.providers).toEqual([]);
  });
});

describe("an OpenSesame identity service", () => {
  it("is a peer way in, and joins the list when it is named", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    type("Identity service", "https://id.acme.com/");

    expect(written.identityApi).toBe("https://id.acme.com");
    expect(ways()).toContain("OpenSesame identity service");

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: true,
    });
  });

  it("is never a prerequisite for bringing a provider", async () => {
    render(<SetupScreen onDone={vi.fn()} />);
    // Every preset is live with no identity service typed at all.
    for (const name of [/^Google/, /^Okta/, /^Auth0/, /^WorkOS/, /Entra/]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(false);
    }
    await addProvider(/^Okta/, {
      issuer: ["Okta domain", "acme.okta.com"],
      clientId: "abc",
    });
    expect(written.identityApi).toBe("");
  });
});
