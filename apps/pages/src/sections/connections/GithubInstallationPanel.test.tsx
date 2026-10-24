/** @vitest-environment jsdom */
import {
  EMPTY_GITHUB_SNAPSHOT,
  type GithubInstallationSnapshot,
} from "@opensesame/app-core/lib/github-installation-access.js";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  GithubCardDetails,
  githubInstallationSeams,
} from "./GithubInstallationPanel.js";
import { makeConnection } from "./section-fixtures.test-support.js";

const access = {
  load: vi.fn(),
  ensure: vi.fn(),
  should: vi.fn(),
};
const seams = { ...githubInstallationSeams };
const vaultHooks = { ...vaultHooksSeams };

beforeEach(() => {
  Object.assign(githubInstallationSeams, access);
  // SAFETY: the card reads only `tomb` from the vault state, which this fixture state carries.
  vaultHooksSeams.useVault = () => ({ tomb: "tomb" }) as never;
});

afterEach(() => {
  cleanup();
  Object.assign(githubInstallationSeams, seams);
  Object.assign(vaultHooksSeams, vaultHooks);
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

  it("reports a snapshot failure through the card flash instead of rejecting", async () => {
    access.load.mockRejectedValue(new Error("vault locked"));
    const onFlash = vi.fn();
    render(
      <GithubCardDetails connection={makeConnection()} onFlash={onFlash} />,
    );
    await vi.waitFor(() =>
      expect(onFlash).toHaveBeenCalledWith({
        tone: "err",
        text: "vault locked",
      }),
    );
  });

  it("does not mint a grant after the card unmounts while loading", async () => {
    let finish: (value: GithubInstallationSnapshot) => void = () => {};
    access.load.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    access.should.mockReturnValue(true);
    const view = render(<GithubCardDetails connection={makeConnection()} />);
    view.unmount();
    finish({ ...EMPTY_GITHUB_SNAPSHOT, ownerId: "owner" });
    await Promise.resolve();
    expect(access.ensure).not.toHaveBeenCalled();
  });
});
