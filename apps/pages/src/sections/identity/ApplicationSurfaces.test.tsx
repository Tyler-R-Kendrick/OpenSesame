/** @vitest-environment jsdom */
import type { LocalScopeRoles } from "@opensesame/app-core/lib/local-application-policy.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { recipePanelSeams } from "@opensesame/app-core/sections/identity/application-recipe-panel-model.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectInTray, inTray } from "../../components/tray.test-support.js";
import { ApplicationDiagnostics } from "./ApplicationDiagnostics.js";
import { ApplicationRecipePanel } from "./ApplicationRecipePanel.js";
import { ApplicationSetupCard } from "./ApplicationSetupCard.js";

const registration = {
  applicationId: "app-1",
  organizationId: "org-1",
  redirectUris: ["https://rp.example/callback"],
  scopes: ["openid", "profile"],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("repeats an import from the revision its own write made", async () => {
    // A store that, like the real one, accepts a write only at its revision.
    let stored = 4;
    const seen: number[] = [];
    vi.spyOn(recipePanelSeams, "configure").mockImplementation(
      async (_tomb, revision) => {
        seen.push(revision);
        if (revision !== stored) throw new Error("stale revision");
        stored += 1;
        return { version: 2, revision: stored, applications: [] };
      },
    );
    const onApplied = vi.fn();
    render(
      <ApplicationRecipePanel
        registration={registration}
        tomb="tomb-1"
        revision={4}
        onApplied={onApplied}
      />,
    );
    await userEvent.type(
      screen.getByLabelText("Organization binding"),
      "org-2",
    );
    const exported = screen.getByRole("textbox", { name: "Exported recipe" });
    await userEvent.click(screen.getByLabelText("Import recipe JSON"));
    await userEvent.paste(exported.textContent ?? "");
    for (const _ of [1, 2]) {
      await userEvent.click(
        screen.getByRole("button", { name: "Apply import" }),
      );
      await screen.findByText(/Applied app-1 to org-2/);
    }
    expect(seen).toEqual([4, 5]);
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("trays an import that is not JSON instead of drawing it", async () => {
    render(
      <ApplicationRecipePanel
        registration={registration}
        tomb="tomb-1"
        revision={4}
      />,
    );
    await userEvent.click(screen.getByLabelText("Import recipe JSON"));
    await userEvent.paste("not json");
    await userEvent.click(screen.getByRole("button", { name: "Apply import" }));
    await expectInTray("Imported recipe is not JSON.");
    expect(
      screen.getByLabelText("Import recipe JSON").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.getByRole("img", { name: "Imported recipe is not JSON." }),
    ).toBeTruthy();
  });

  it("keeps the ask to unlock in the page, not the tray", async () => {
    render(<ApplicationRecipePanel registration={registration} />);
    const exported = screen.getByRole("textbox", { name: "Exported recipe" });
    await userEvent.type(
      screen.getByLabelText("Organization binding"),
      "org-2",
    );
    await userEvent.click(screen.getByLabelText("Import recipe JSON"));
    await userEvent.paste(exported.textContent ?? "");
    await userEvent.click(screen.getByRole("button", { name: "Apply import" }));
    expect(
      await screen.findByText("Unlock the vault before applying a recipe."),
    ).toBeTruthy();
    expect(inTray("Unlock the vault")).toBe(false);
    expect(screen.queryByRole("img", { name: /Unlock the vault/ })).toBeNull();
    expect(
      screen.getByLabelText("Import recipe JSON").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("saves a simulation as a policy test without issuing a token", async () => {
    render(
      <ApplicationDiagnostics
        applicationId="app-1"
        policy={[{ scope: "openid", roles: ["owner", "admin", "member"] }]}
        policyRevision="1"
      />,
    );
    expect(screen.getByText(/Decision:/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Save as policy test" }),
    );
    expect(screen.getByRole("img", { name: "Passed" })).toBeTruthy();
    expect(screen.queryByText(/access_token/)).toBeNull();
  });

  it("raises a failed policy test notice per application, not one shared by all", async () => {
    const openid: LocalScopeRoles[] = [
      { scope: "openid", roles: ["owner", "admin", "member"] },
    ];
    render(
      <>
        <section aria-label="first">
          <ApplicationDiagnostics
            applicationId="app-a"
            policy={openid}
            policyRevision="1"
          />
        </section>
        <section aria-label="second">
          <ApplicationDiagnostics
            applicationId="app-b"
            policy={openid}
            policyRevision="1"
          />
        </section>
      </>,
    );
    const ids = () =>
      listNotices()
        .map((notice) => notice.id)
        .sort();
    for (const name of ["first", "second"]) {
      const panel = within(screen.getByRole("region", { name }));
      await userEvent.selectOptions(
        panel.getByLabelText("Expected decision"),
        "deny",
      );
      await userEvent.click(
        panel.getByRole("button", { name: "Save as policy test" }),
      );
    }
    expect(ids()).toEqual([
      "identity:application-tests:app-a",
      "identity:application-tests:app-b",
    ]);
  });

  it("marks a saved test that disagrees and trays the blocked publication", async () => {
    render(
      <ApplicationDiagnostics
        applicationId="app-a"
        policy={[{ scope: "openid", roles: ["owner", "admin", "member"] }]}
        policyRevision="1"
      />,
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Expected decision"),
      "deny",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save as policy test" }),
    );
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Passed" })).toBeNull();
    await expectInTray("A saved test failed.");
  });
});
