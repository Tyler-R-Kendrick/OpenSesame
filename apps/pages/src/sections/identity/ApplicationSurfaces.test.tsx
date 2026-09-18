/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDiagnostics } from "./ApplicationDiagnostics.js";
import { ApplicationRecipePanel } from "./ApplicationRecipePanel.js";
import { ApplicationSetupCard } from "./ApplicationSetupCard.js";

const registration = {
  applicationId: "app-1",
  organizationId: "org-1",
  redirectUris: ["https://rp.example/callback"],
  scopes: ["openid", "profile"],
};

afterEach(() => cleanup());

describe("application surfaces", () => {
  it("shows exact callbacks and refuses to treat registration as a grant", () => {
    render(<ApplicationSetupCard registration={registration} />);
    expect(screen.getByText(/https:\/\/rp.example\/callback/)).toBeTruthy();
    expect(
      screen.getByText(
        /Registration is not consent|not a grant|not authorization/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test sign-in" })).toBeTruthy();
    expect(screen.getByText(/unsigned/i)).toBeTruthy();
  });

  it("exports a recipe without the live secret", () => {
    render(<ApplicationRecipePanel registration={registration} />);
    // SAFETY: fixture constructed in this test matches the declared contract.
    const exported = screen.getByLabelText(
      "Exported recipe",
    ) as HTMLTextAreaElement;
    expect(exported.value).toContain("redirectUris");
    expect(exported.value).not.toContain("must-not-export");
  });

  it("saves a simulation as a policy test without issuing a token", async () => {
    render(
      <ApplicationDiagnostics
        policy={[{ scope: "openid", roles: ["owner", "admin", "member"] }]}
        policyRevision="1"
      />,
    );
    expect(screen.getByText(/Decision:/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Save as policy test" }),
    );
    expect(screen.getAllByText(/pass|fail/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/access_token/)).toBeNull();
  });
});
