import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupScreen } from "./SetupScreen.js";
import {
  type ProviderFields,
  addProvider as addProviderWith,
  clearInstallOffer,
  commit,
  fieldNamed,
  installNow,
  offering,
  openSetup,
  openWaysIn,
  resetSetupScreen,
  type as typeInto,
  ways,
} from "./setup/test-harness.js";
import { createSetupSeams } from "./setup/test-seams.js";

vi.mock("../lib/configuration/capabilities-ports.js", async () => {
  const { fakePortsModule } = await import(
    "./capabilities/composition-ports-double.js"
  );
  const { double } = await import("./capabilities/test-support.js");
  return fakePortsModule(double);
});

const seams = createSetupSeams();
const { written, discover, completeSetup } = seams;

const addProvider = (preset: RegExp, fields: ProviderFields) =>
  addProviderWith(seams, preset, fields);

beforeEach(() => resetSetupScreen(seams));

afterEach(() => {
  cleanup();
  clearInstallOffer();
});

describe("two optional ceremonies, never a fork (ADR 0090)", () => {
  it("opens the operator ceremony on its capabilities tab when asked for", () => {
    openSetup();
    expect(
      screen.getByRole("tab", { selected: true }).textContent?.trim(),
    ).toBe("capabilities");
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByTestId("capability-setup")).toBeTruthy();
    expect(screen.queryByText("This device is empty")).toBeNull();
  });

  it("closes to the caller without recording anything", () => {
    const onDone = openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it("defaults to the operator ceremony with no invite in the address bar", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(
      screen.getByRole("tab", { selected: true }).textContent?.trim(),
    ).toBe("capabilities");
  });
});

describe("the setup ceremony", () => {
  it("is capabilities, then a tab per registered panel, each skippable, with a skip-all (ADR 0114)", () => {
    openSetup();
    // Four concerns: connectors, ai, identity, mfa (ADR 0128 took the others).
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "capabilities",
      "connectors",
      "identity",
      "mfa",
    ]);
    expect(document.querySelectorAll(".steps__seg")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Skip this step" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip all" })).toBeTruthy();
  });

  it("never asks for a Host API or a mobile MFA app", () => {
    // Both were setup questions in earlier shapes of this screen; neither is
    // one a first-time visitor has. Settings → Endpoints owns them. The
    // daemon address on the backups tab is a suggestion, not a pairing.
    openSetup();
    expect(screen.queryByLabelText("Host API")).toBeNull();
    expect(screen.queryByLabelText("Mobile MFA app")).toBeNull();
  });

  it("arrives with the compiled-in broker already a way in", () => {
    // The whole point: a deployment nobody has configured is already usable,
    // so setup can be one tap.
    openWaysIn();
    expect(ways()).toEqual(["Google"]);
  });

  it("finishes with nothing typed at all", async () => {
    const onDone = openSetup(vi.fn());
    fireEvent.click(commit());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: [],
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
    openWaysIn();
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
    openWaysIn();
    await addProvider(/^Google/, { clientId: "google-client.apps" });
    expect(written.signIn.providers[0]?.providerId).toBe("google");
  });

  it("refuses the same issuer twice", async () => {
    openWaysIn();
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
    openWaysIn();
    await addProvider(/^Google/, { clientId: "google-client.apps" });

    const removeGoogle = () =>
      screen.getAllByRole("button", { name: "Remove Google" });
    // Builtin Google first, then the operator-added Google.
    fireEvent.click(removeGoogle()[1]);
    expect(written.signIn.providers).toEqual([]);

    fireEvent.click(removeGoogle()[0]);
    expect(written.signIn.builtin).toBe(false);
  });

  it("lets a deployment finish with no ways in", async () => {
    const onDone = openWaysIn(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Remove Google" }));

    expect(ways()).toEqual([]);

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // A deployment with no accounts is a decision, recorded as one.
    expect(completeSetup).toHaveBeenCalledWith({
      ways: [],
      service: false,
      skipped: [],
    });
  });

  it("shows the redirect URI the operator has to register", () => {
    openWaysIn();
    fireEvent.click(screen.getByRole("button", { name: /^Okta/ }));
    expect(fieldNamed("Redirect URI to register").value).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/",
    );
  });

  it("asks each preset for the field its issuer is built from", () => {
    openWaysIn();

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
    openWaysIn();
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
    openWaysIn();
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
    openWaysIn();
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
    const onDone = openWaysIn(vi.fn());
    typeInto("Identity service", "https://id.acme.com/");

    expect(written.identityApi).toBe("https://id.acme.com");
    expect(ways()).toContain("OpenSesame identity service");

    fireEvent.click(commit());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: true,
      skipped: [],
    });
  });

  it("is never a prerequisite for bringing a provider", async () => {
    openWaysIn();
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

  it("rides beneath the active step, never a tab of its own", () => {
    // A tab per concern (ADR 0114); installing is not one of them.
    offering("prompt");
    openSetup();

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByText("Keep it on this device")).toBeDefined();
    expect(
      document
        .querySelector(".setup__body")
        ?.contains(screen.getByText("Keep it on this device")),
    ).toBe(true);
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
    // And it leaves no mark on the record: installing is not a concern tab.
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: [],
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
    render(<SetupScreen onDone={vi.fn()} />);
    expect(document.activeElement).toBe(commit());
  });
});
