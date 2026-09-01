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
    accountKind: "Google",
  }),
});

import type { InstallOutcome, InstallState } from "../lib/install.js";
import { installViewSeams } from "../lib/use-install.js";
import { SetupScreen, setupScreenDependencies } from "./SetupScreen.js";
import { joinSessionDependencies } from "./setup/JoinSession.js";
import { waysInDependencies } from "./setup/WaysIn.js";

/**
 * What the browser is offering, for the ceremony's benefit. jsdom offers
 * nothing, which is also the honest default: most of these tests are about the
 * screen that browser gets.
 */
function offering(state: InstallState): void {
  installViewSeams.state = state;
}
const installNow = vi.fn<() => Promise<InstallOutcome>>(async () => "accepted");

/** The one network call the ceremony makes: the provider's discovery doc. */
const discover = vi.fn<(issuer: string) => Promise<OidcDiscovery>>();

/** What `addProvider` needs to fill one preset's form. */
type ProviderFields = {
  /** `[field label, value]` for the presets whose issuer is typed. */
  issuer?: [string, string];
  clientId: string;
};

const completeSetup =
  vi.fn<
    (outcome: {
      ways: string[];
      service: boolean;
      joined?: boolean;
    }) => Promise<void>
  >();

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
    readJoinFromLocation: () => null,
  });
  installViewSeams.state = "unavailable";
  installNow.mockClear();
  installViewSeams.install = installNow;
});

afterEach(() => {
  cleanup();
  installViewSeams.state = null;
  installViewSeams.persisted = null;
  installViewSeams.install = null;
});

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

function openSetup(onDone: () => void = vi.fn()): () => void {
  render(<SetupScreen road="setup" onDone={onDone} />);
  return onDone;
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
  const discoveries = discover.mock.calls.length;
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
  // Wait for *this* add to land, not for some earlier one to have happened:
  // `discover` is one mock for the whole test, so a provider added a moment
  // ago satisfies `toHaveBeenCalled` on the spot and this returns while the
  // add is still in flight. An add is finished only once discovery has come
  // back and the form has closed behind it — until then the screen is `busy`,
  // every preset button is disabled, and the next caller's click lands on
  // nothing.
  await waitFor(() => {
    expect(discover.mock.calls.length).toBe(discoveries + 1);
    expect(screen.queryByLabelText("Client ID")).toBeNull();
  });
}

describe("two optional ceremonies, never a fork (ADR 0090)", () => {
  it("opens the operator question when asked for", () => {
    openSetup();
    expect(heading()).toBe("How do people sign in?");
    expect(screen.queryByText("This device is empty")).toBeNull();
  });

  it("backs out to the caller without recording anything", () => {
    const onDone = openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it("opens join when asked for", () => {
    render(<SetupScreen road="join" onDone={vi.fn()} />);
    expect(heading()).toBe("Join a session");
    expect(screen.getByLabelText("Invite")).toBeTruthy();
    expect(screen.getByLabelText("Code")).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
  });

  it("defaults to the operator question with no invite in the address bar", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(heading()).toBe("How do people sign in?");
  });

  it("opens join directly when the visit is an invite", () => {
    setupScreenDependencies.readJoinFromLocation = () => ({
      host: "https://host.example",
      token: "osc_clm_id.secret",
    });
    render(<SetupScreen onDone={vi.fn()} />);
    expect(heading()).toBe("Join a session");
    expect(fieldNamed("Invite").value).toBe("osc_clm_id.secret");
    expect(fieldNamed("Host").value).toBe("https://host.example");
  });

  it("presents an invite without a session, then records the join", async () => {
    const presentInvite = vi.fn().mockResolvedValue({
      id: "off_1",
      state: "presented",
      manifestDigest: "sha256:abc",
      expiresAt: "2026-08-31T00:00:00Z",
      items: [
        {
          id: "item_1",
          connectionId: "conn_1",
          providerId: "host",
          displayName: "Grafana admin",
          actions: ["read"],
          resources: ["item:1"],
          expiresInSeconds: 0,
          executionMode: "broker",
          required: true,
          dependencies: [],
        },
      ],
    });
    const onDone = vi.fn();
    const writeJoinStash = vi.fn();
    Object.assign(joinSessionDependencies, {
      presentInvite,
      currentSession: () => null,
      hostBase: () => "",
      loadSettings: () => currentSettings(),
      saveSettings: (next: PagesSettings) => {
        written.hostApi = next.hostApi;
      },
      completeSetup,
      writeJoinStash,
      readJoinStash: () => null,
      parseInviteInput: (raw: string) =>
        raw.trim() ? { host: "https://host.example", token: raw.trim() } : null,
    });
    render(<SetupScreen road="join" onDone={onDone} />);
    type("Host", "https://host.example");
    type("Invite", "osc_clm_id.secret");
    fireEvent.click(screen.getByRole("button", { name: "Look it up" }));
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(writeJoinStash).toHaveBeenCalledWith({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "",
      acceptedItemIds: ["item_1"],
    });
    type("Code", "FKM2RD");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to accept" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(writeJoinStash).toHaveBeenCalledWith({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    expect(completeSetup).toHaveBeenCalledWith({
      ways: [],
      service: false,
      joined: true,
    });
  });
});

describe("the setup ceremony", () => {
  it("is one screen asking one question", () => {
    openSetup();
    expect(heading()).toBe("How do people sign in?");
    // No stepper, no counter, no skip. Back returns to the setup-or-join
    // fork — it is not a previous *step* of this question.
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
    openSetup();
    expect(screen.queryByLabelText("Host API")).toBeNull();
    expect(screen.queryByLabelText("Mobile MFA app")).toBeNull();
    expect(screen.queryByText(/This machine/)).toBeNull();
    expect(screen.queryByText(/not paired/)).toBeNull();
  });

  it("arrives with the compiled-in broker already a way in", () => {
    // The whole point: a deployment nobody has configured is already usable,
    // so setup can be one tap.
    openSetup();
    expect(ways()).toEqual(["Google"]);
  });

  it("finishes with nothing typed at all", async () => {
    const onDone = openSetup(vi.fn());
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
    const onDone = openSetup(vi.fn());
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe("building the list of ways in", () => {
  it("takes as many providers as the operator wants", async () => {
    // The complaint this answers: one provider is not a deployment. Most want
    // Google for everybody and an org's own IdP for staff.
    openSetup();
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    await addProvider(/^Okta/, {
      issuer: ["Okta domain", "acme.okta.com"],
      clientId: "0oa1b2c3d4EXAMPLE",
    });
    await addProvider(/Other OIDC/, {
      issuer: ["Issuer URL", "https://idp.acme.com"],
      clientId: "generic",
    });

    expect(ways()).toEqual(["Google", "Google", "Okta", "Other OIDC"]);
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
    openSetup();
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    expect(written.signIn.providers[0]?.providerId).toBe("google");
  });

  it("refuses the same issuer twice", async () => {
    openSetup();
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
    openSetup();
    await addProvider(/^Google/, { clientId: "google-client.apps" });

    const removeGoogle = () =>
      screen.getAllByRole("button", { name: "Remove Google" });
    // Builtin Google first, then the operator-added Google.
    fireEvent.click(removeGoogle()[1]);
    expect(written.signIn.providers).toEqual([]);

    fireEvent.click(removeGoogle()[0]);
    expect(written.signIn.builtin).toBe(false);
  });

  it("says plainly what removing everything means", async () => {
    const onDone = openSetup(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Remove Google" }));

    expect(ways()).toEqual([]);
    expect(screen.getByText(/Local vault only: no recovery/)).toBeDefined();

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // A deployment with no accounts is a decision, recorded as one.
    expect(completeSetup).toHaveBeenCalledWith({ ways: [], service: false });
  });

  it("shows the redirect URI the operator has to register", () => {
    openSetup();
    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    expect(fieldNamed("Redirect URI to register").value).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/",
    );
  });

  it("asks each preset for the field its issuer is built from", () => {
    openSetup();

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
    openSetup();
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
    openSetup();
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
    openSetup();
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
    const onDone = openSetup(vi.fn());
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
    openSetup();
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

describe("keeping it on this device", () => {
  it("leaves no trace at all where the browser will not install", () => {
    // ADR 0086 — the same rule that withholds Unlock while there is no sealed
    // vault. Not a heading over an empty space explaining what cannot be done.
    openSetup();
    expect(screen.queryByText("Keep it on this device")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });

  it("is a section under the one question, never a second one", () => {
    // The ceremony stays one screen with one heading (ADR 0078): no stepper,
    // no counter, and the install offer does not become a step.
    offering("prompt");
    openSetup();

    expect(heading()).toBe("How do people sign in?");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Keep it on this device")).toBeDefined();
  });

  it("sits below the allowlist, not above the question", () => {
    offering("prompt");
    openSetup();
    const body = document.querySelector(".setup__body");
    const text = body?.textContent ?? "";
    expect(text.indexOf("How do people sign in?")).toBeLessThan(
      text.indexOf("Keep it on this device"),
    );
  });

  it("offers the install inside the card, never as the screen's commit", () => {
    // `docs/design/controls.md`: the foot bar commits the ceremony; the card
    // acts on its own content. The commit still reads "Finish setup".
    offering("prompt");
    openSetup();

    const action = screen.getByRole("button", { name: "Install OpenSesame" });
    expect(action.closest(".setup__foot")).toBeNull();
    expect(action.closest(".found")).not.toBeNull();
    expect(commit().getAttribute("aria-label")).toBe("Finish setup");
  });

  it("never gates finishing setup", async () => {
    // Installing has no wrong answer, so it cannot hold the commit.
    offering("prompt");
    const onDone = openSetup(vi.fn());

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(installNow).not.toHaveBeenCalled();
    // And it leaves no mark on the record: the ceremony answers one question.
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
    });
  });

  it("gives iOS the manual road rather than a button that cannot work", () => {
    offering("manual");
    openSetup();
    expect(screen.getByText("Keep it on this device")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
    expect(
      screen.getByText("Add to Home Screen", { selector: "strong" }),
    ).toBeDefined();
  });

  it("keeps reporting the install once it has happened", () => {
    offering("installed");
    openSetup();
    expect(screen.getByText("Installed")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });
});

describe("where the keyboard lands", () => {
  it("lands setup on its commit, never on a provider's Remove", () => {
    render(<SetupScreen road="setup" onDone={vi.fn()} />);
    expect(document.activeElement).toBe(commit());
  });

  it("lands join inside its form, on the invite", () => {
    render(<SetupScreen road="join" onDone={vi.fn()} />);
    expect(screen.getByRole("main").contains(document.activeElement)).toBe(
      true,
    );
  });
});
