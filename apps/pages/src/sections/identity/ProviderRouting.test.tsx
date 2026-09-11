/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { federationSeams } from "../../lib/federation.js";
import { identitySeams } from "../../lib/identity.js";
import {
  idpRegistrySeams,
  listIdpRegistrations,
  registerIdp,
} from "../../lib/idp-registry.js";
import { providersSeams } from "../../lib/providers.js";
import { IdentitySection } from "../IdentitySection.js";

beforeEach(() => {
  let stored: string | null = null;
  vi.spyOn(idpRegistrySeams, "read").mockImplementation(() => stored);
  vi.spyOn(idpRegistrySeams, "write").mockImplementation((value) => {
    stored = value;
  });
  vi.spyOn(identitySeams, "identityBase").mockReturnValue("");
  vi.spyOn(identitySeams, "useIdentitySession").mockReturnValue(null);
  vi.spyOn(providersSeams, "listFederatedProviders").mockResolvedValue([]);
  vi.spyOn(federationSeams, "beginSignIn").mockResolvedValue();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected network call"))),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderProviders() {
  return render(
    <MemoryRouter initialEntries={["/identity?view=providers"]}>
      <IdentitySection />
    </MemoryRouter>,
  );
}

async function chooseDefault() {
  renderProviders();
  const add = screen.getByRole("button", { name: "Register an IdP" });
  expect(add.textContent).toBe("");
  expect(add.className).toContain("icon-btn--sm");
  await userEvent.click(add);
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue with Shoo" }),
  );
}

it("registers the compiled browser provider without an Identity endpoint", async () => {
  await chooseDefault();
  await waitFor(() =>
    expect(federationSeams.beginSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "shoo",
        issuer: "https://shoo.dev",
        protocol: "shoo",
      }),
      { providerHint: "shoo" },
    ),
  );
  expect(listIdpRegistrations()).toEqual([
    expect.objectContaining({ id: "shoo", issuer: "https://shoo.dev" }),
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("reuses the compiled route when signing in from the saved provider row", async () => {
  registerIdp({
    id: "shoo",
    issuer: "https://shoo.dev",
    label: "Shoo",
    kind: "first-class",
    registeredAt: "2026-09-10T00:00:00Z",
  });
  renderProviders();
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(federationSeams.beginSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "shoo",
        issuer: "https://shoo.dev",
        protocol: "shoo",
      }),
      { providerHint: "shoo" },
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves an existing provider when a registration retry cannot start", async () => {
  const previous = {
    id: "shoo",
    issuer: "https://shoo.dev",
    label: "Existing provider",
    kind: "first-class" as const,
    registeredAt: "2026-09-01T00:00:00Z",
  };
  registerIdp(previous);
  vi.mocked(federationSeams.beginSignIn).mockRejectedValue(
    new Error("Sign-in unavailable"),
  );
  await chooseDefault();
  await screen.findByText("Sign-in unavailable");
  expect(listIdpRegistrations()).toEqual([previous]);
});

it("removes only the new record when initial registration cannot start", async () => {
  vi.mocked(federationSeams.beginSignIn).mockRejectedValue(
    new Error("Sign-in unavailable"),
  );
  await chooseDefault();
  await screen.findByText("Sign-in unavailable");
  expect(listIdpRegistrations()).toEqual([]);
});
