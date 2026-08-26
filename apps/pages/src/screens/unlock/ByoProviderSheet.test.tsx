/** @vitest-environment jsdom */
/**
 * The BYO provider sheet: discovery-checked registration, the redirect URI on
 * display, manual client fields only when the provider can't self-register,
 * and the secret never rendered back.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ByoError } from "../../lib/byo.js";
import { ByoProviderSheet, byoSheetDependencies } from "./ByoProviderSheet.js";

const REAL = { ...byoSheetDependencies };

const REGISTERED = {
  id: "byo_1",
  issuer: "https://auth.kestrel.dev",
  label: "auth.kestrel.dev",
  clientId: "dcr-abc",
  clientAuth: "client_secret_post",
  registrationSource: "dcr",
  redirectUri: "https://id.example.com/v1/federated/callback",
};

afterEach(() => {
  cleanup();
  Object.assign(byoSheetDependencies, REAL);
  vi.restoreAllMocks();
});

function typeIssuer(value: string) {
  fireEvent.change(screen.getByLabelText("Issuer URL"), {
    target: { value },
  });
}

describe("ByoProviderSheet", () => {
  it("registers an issuer and shows the redirect URI and continue button", async () => {
    const registerByoProvider = vi.fn(async () => REGISTERED);
    Object.assign(byoSheetDependencies, { registerByoProvider });
    const onContinue = vi.fn();

    render(<ByoProviderSheet onContinue={onContinue} />);
    typeIssuer("https://auth.kestrel.dev");
    fireEvent.click(screen.getByRole("button", { name: "Check provider" }));

    await waitFor(() => {
      expect(screen.getByText("auth.kestrel.dev")).toBeTruthy();
    });
    expect(registerByoProvider).toHaveBeenCalledWith({
      issuer: "https://auth.kestrel.dev",
    });
    expect(
      screen.getByText("https://id.example.com/v1/federated/callback"),
    ).toBeTruthy();
    expect(screen.getByText(/never merged with email accounts/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with auth.kestrel.dev" }),
    );
    expect(onContinue).toHaveBeenCalledWith(REGISTERED);
  });

  it("opens the manual client fields when the provider can't self-register", async () => {
    const registerByoProvider = vi
      .fn()
      .mockRejectedValueOnce(
        new ByoError(
          "registration_unsupported",
          "That issuer does not register clients automatically. Enter a client ID you created there.",
        ),
      )
      .mockResolvedValueOnce({ ...REGISTERED, registrationSource: "manual" });
    Object.assign(byoSheetDependencies, { registerByoProvider });

    render(<ByoProviderSheet onContinue={vi.fn()} />);
    typeIssuer("https://auth.kestrel.dev");
    fireEvent.click(screen.getByRole("button", { name: "Check provider" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not register clients automatically",
    );
    fireEvent.change(await screen.findByLabelText("Client ID"), {
      target: { value: "manual-client" },
    });
    fireEvent.change(screen.getByLabelText("Client secret (optional)"), {
      target: { value: "manual-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Register with this client" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/using your client/)).toBeTruthy();
    });
    expect(registerByoProvider).toHaveBeenLastCalledWith({
      issuer: "https://auth.kestrel.dev",
      clientId: "manual-client",
      clientSecret: "manual-secret",
    });
    // The typed secret never renders anywhere outside its password field.
    expect(screen.queryByText(/manual-secret/)).toBeNull();
  });

  it("surfaces discovery failures in plain words", async () => {
    Object.assign(byoSheetDependencies, {
      registerByoProvider: vi.fn(async () => {
        throw new ByoError(
          "discovery_failed",
          "That issuer did not answer with an OpenID Connect discovery document.",
        );
      }),
    });

    render(<ByoProviderSheet onContinue={vi.fn()} />);
    typeIssuer("https://not-an-idp.example");
    fireEvent.click(screen.getByRole("button", { name: "Check provider" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "discovery document",
    );
    // No manual fields for this failure — the URL itself is the problem.
    expect(screen.queryByLabelText("Client ID")).toBeNull();
  });
});
