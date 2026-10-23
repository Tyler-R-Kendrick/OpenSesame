/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const forget = vi.hoisted(() => vi.fn());

vi.mock("@opensesame/app-core/lib/github-app-manifest.js", () => ({
  forgetLocalGithubApp: forget,
}));

const { GithubAppForgetButton } = await import("./GithubAppConfigRows.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub App remove control", () => {
  it("does not delete the sealed key when confirmation is declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<GithubAppForgetButton />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove GitHub App from this device",
      }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(forget).not.toHaveBeenCalled();
  });

  it("forgets the local App after explicit confirmation", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    render(<GithubAppForgetButton />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove GitHub App from this device",
      }),
    );
    expect(forget).toHaveBeenCalledTimes(1);
  });
});
