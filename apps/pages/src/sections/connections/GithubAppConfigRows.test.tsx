/** @vitest-environment jsdom */
import { rememberLocalGithubApp } from "@opensesame/app-core/lib/github-app-local.js";
import {
  forgetLocalGithubApp,
  readLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppForgetButton } from "./GithubAppConfigRows.js";

const REMOVE = "Remove GitHub App from this device";
const CONFIRM = "Confirm removing the GitHub App from this device";
const KEEP = "Keep the GitHub App";

beforeEach(() => {
  rememberLocalGithubApp({
    id: "42",
    key: "github-oauth",
    displayName: "Browser app",
    htmlUrl: "https://github.com/apps/browser-app",
    ownerLogin: "operator",
    ownerType: "User",
    installedByLogin: null,
    installations: [],
  });
});

afterEach(() => {
  cleanup();
  forgetLocalGithubApp();
  vi.unstubAllGlobals();
});

describe("GitHub App remove control", () => {
  it("arms on the first press and deletes nothing", async () => {
    render(<GithubAppForgetButton />);
    await userEvent.click(screen.getByRole("button", { name: REMOVE }));
    expect(readLocalGithubApp()).not.toBeNull();
    expect(screen.getByRole("button", { name: CONFIRM })).toBeTruthy();
    expect(screen.getByRole("button", { name: KEEP })).toBeTruthy();
  });

  it("forgets the local App on the second press", async () => {
    render(<GithubAppForgetButton />);
    await userEvent.click(screen.getByRole("button", { name: REMOVE }));
    await userEvent.click(screen.getByRole("button", { name: CONFIRM }));
    expect(readLocalGithubApp()).toBeNull();
  });

  it("keeps the App and hands focus back to the remove key", async () => {
    render(<GithubAppForgetButton />);
    await userEvent.click(screen.getByRole("button", { name: REMOVE }));
    await userEvent.click(screen.getByRole("button", { name: KEEP }));
    expect(readLocalGithubApp()).not.toBeNull();
    expect(screen.queryByRole("button", { name: KEEP })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: REMOVE }),
    );
  });

  it("asks in the page, never through a browser dialog", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<GithubAppForgetButton />);
    await userEvent.click(screen.getByRole("button", { name: REMOVE }));
    await userEvent.click(screen.getByRole("button", { name: CONFIRM }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
