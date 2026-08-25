/** @vitest-environment jsdom */
/**
 * The one "Email or organization" field: a slug resolves the org, a work
 * email resolves it by domain, an unrecognized domain falls back to the
 * magic link with the typed address, and junk stays local with an inline
 * explanation.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgTenant } from "../../lib/orgs.js";
import {
  IdentifierField,
  identifierFieldDependencies,
} from "./IdentifierField.js";

const REAL = { ...identifierFieldDependencies };

const ACME: OrgTenant = {
  slug: "acme-corp",
  displayName: "Acme Corp",
  state: "active",
  authMethods: [
    { kind: "sso", label: "SSO", issuer: "https://sso.acme.com" },
    { kind: "saml", label: "SAML", issuer: "https://saml.acme.com" },
  ],
};

afterEach(() => {
  cleanup();
  Object.assign(identifierFieldDependencies, REAL);
  vi.restoreAllMocks();
});

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Email or organization"), {
    target: { value },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("IdentifierField", () => {
  it("resolves a slug and offers the org's methods, first one primary", async () => {
    const lookupOrgTenant = vi.fn(async () => ACME);
    Object.assign(identifierFieldDependencies, { lookupOrgTenant });
    const onStartOrgMethod = vi.fn();

    render(<IdentifierField onStartOrgMethod={onStartOrgMethod} />);
    type("acme-corp");
    submit();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeTruthy();
    });
    expect(lookupOrgTenant).toHaveBeenCalledWith("acme-corp");
    const sso = screen.getByRole("button", { name: "Continue with SSO" });
    expect(sso.className).toContain("btn--primary");

    fireEvent.click(sso);
    expect(onStartOrgMethod).toHaveBeenCalledWith(ACME, ACME.authMethods[0]);
  });

  it("resolves a work email by its domain only", async () => {
    const lookupOrgByDomain = vi.fn(async () => ACME);
    Object.assign(identifierFieldDependencies, { lookupOrgByDomain });

    render(<IdentifierField onStartOrgMethod={vi.fn()} />);
    type("sam@acme.com");
    submit();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeTruthy();
    });
    expect(lookupOrgByDomain).toHaveBeenCalledWith("acme.com");
    expect(lookupOrgByDomain).not.toHaveBeenCalledWith("sam@acme.com");
  });

  it("offers the magic link when no organization uses the domain", async () => {
    const requestEmailMagicLink = vi.fn(async () => undefined);
    Object.assign(identifierFieldDependencies, {
      lookupOrgByDomain: vi.fn(async () => null),
      requestEmailMagicLink,
    });

    render(<IdentifierField onStartOrgMethod={vi.fn()} />);
    type("jordan@gmail.com");
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(/No organization uses that email domain/),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Check your inbox/)).toBeTruthy();
    });
    expect(requestEmailMagicLink).toHaveBeenCalledWith("jordan@gmail.com");
  });

  it("offers the hosted-page fallback with only the domain", async () => {
    Object.assign(identifierFieldDependencies, {
      lookupOrgByDomain: vi.fn(async () => null),
    });
    const onContinueWithDomain = vi.fn();

    render(
      <IdentifierField
        onStartOrgMethod={vi.fn()}
        onContinueWithDomain={onContinueWithDomain}
      />,
    );
    type("jordan@gmail.com");
    submit();

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Continue on the hosted sign-in page instead",
        }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Continue on the hosted sign-in page instead",
      }),
    );

    expect(onContinueWithDomain).toHaveBeenCalledWith("gmail.com");
  });

  it("explains junk input inline without any lookup", async () => {
    const lookupOrgTenant = vi.fn();
    const lookupOrgByDomain = vi.fn();
    Object.assign(identifierFieldDependencies, {
      lookupOrgTenant,
      lookupOrgByDomain,
    });

    render(<IdentifierField onStartOrgMethod={vi.fn()} />);
    type("two words");
    submit();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(lookupOrgTenant).not.toHaveBeenCalled();
    expect(lookupOrgByDomain).not.toHaveBeenCalled();
  });

  it("surfaces a lookup failure's message", async () => {
    Object.assign(identifierFieldDependencies, {
      lookupOrgTenant: vi.fn(async () => {
        throw new Error("Identity API unreachable");
      }),
    });

    render(<IdentifierField onStartOrgMethod={vi.fn()} />);
    type("acme-corp");
    submit();

    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("Identity API unreachable");
  });
});
