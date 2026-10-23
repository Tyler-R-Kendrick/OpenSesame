/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConnection } from "./section-fixtures.test-support.js";

const access = vi.hoisted(() => ({
  load: vi.fn(),
  ensure: vi.fn(),
  should: vi.fn(),
}));

vi.mock("@opensesame/app-core/lib/github-installation-access.js", () => ({
  loadGithubInstallationSnapshot: access.load,
  ensureGithubAccessGrant: access.ensure,
  shouldEnsureGithubAccessGrant: access.should,
}));
vi.mock("../../lib/vault/hooks.js", () => ({
  useVault: () => ({ tomb: "tomb" }),
}));

const { GithubCardDetails } = await import("./GithubInstallationPanel.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitHub installation snapshot", () => {
  it("contains a rejected snapshot instead of leaking an unhandled rejection", async () => {
    access.load.mockRejectedValue(new Error("vault locked"));
    const view = render(<GithubCardDetails connection={makeConnection()} />);
    await vi.waitFor(() => expect(access.load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    // The failed snapshot draws no rows and raises no unhandled rejection.
    expect(view.container.textContent).toBe("");
  });

  it("does not mint a grant after the card unmounts while loading", async () => {
    let finish: (value: unknown) => void = () => {};
    access.load.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    access.should.mockReturnValue(true);
    const view = render(<GithubCardDetails connection={makeConnection()} />);
    view.unmount();
    finish({ installations: [], shares: [], ownerId: "owner" });
    await Promise.resolve();
    expect(access.ensure).not.toHaveBeenCalled();
  });
});
