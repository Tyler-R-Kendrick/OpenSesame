/** @vitest-environment jsdom */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { type PropsWithChildren, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  githubAppReturnSeams,
  useGithubAppReturn,
} from "./useGithubAppReturn.js";

const app = {
  id: "12",
  key: "github-oauth",
  displayName: "Fixture",
  htmlUrl: null,
  ownerLogin: "owner",
  ownerType: "User",
  installedByLogin: null,
  installations: [{ id: "77", accountLogin: "owner", accountType: "User" }],
};
const api = {
  claim: vi.spyOn(githubAppReturnSeams, "claimGithubAppCode"),
  verify: vi.spyOn(githubAppReturnSeams, "verifyGithubAppInstallations"),
  refresh: vi.spyOn(githubAppReturnSeams, "refreshGithubAppInstallations"),
  read: vi.spyOn(githubAppReturnSeams, "readLocalGithubApp"),
  pending: vi.spyOn(githubAppReturnSeams, "hasPendingGithubAppSecret"),
  capture: vi.spyOn(githubAppReturnSeams, "captureGithubAuthority"),
};
const authorities: AbortController[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  api.read.mockReturnValue(app);
  api.pending.mockReturnValue(false);
  api.refresh.mockResolvedValue(app);
  authorities.length = 0;
  api.capture.mockImplementation(() => {
    const controller = new AbortController();
    authorities.push(controller);
    return {
      tomb: "owned",
      transport: {
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
        fetch: globalThis.fetch,
      },
      close: () => controller.abort(),
    };
  });
});

it.each(["Remove", "lock"])(
  "does not emit verified green when %s is queued before the UI continuation",
  async (change) => {
    window.history.replaceState(
      {},
      "",
      "/settings/connections/github?github_app=installed",
    );
    let finish: (value: typeof app) => void = () => {};
    const pending = new Promise<typeof app>((resolve) => {
      finish = resolve;
    });
    api.verify.mockReturnValue(pending);
    const flash = vi.fn();
    renderHook(() => useGithubAppReturn("github", flash));
    finish(app);
    if (change === "Remove") api.read.mockReturnValue(null);
    authorities[0]?.abort();
    await pending;
    expect(flash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
  },
);

it("coalesces a deferred conversion across StrictMode replay and callback changes", async () => {
  window.history.replaceState(
    {},
    "",
    "/settings/connections/github?github_app=claim&code=code-once&state=state-once",
  );
  let finish: (value: "registered") => void = () => {};
  const pending = new Promise<"registered">((resolve) => {
    finish = resolve;
  });
  api.claim.mockReturnValue(pending);
  const first = vi.fn();
  const latest = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <StrictMode>{children}</StrictMode>
  );
  const view = renderHook(({ flash }) => useGithubAppReturn("github", flash), {
    initialProps: { flash: first },
    wrapper,
  });
  expect(api.claim).toHaveBeenCalledTimes(1);
  expect(window.location.search).toContain("code=code-once");
  view.rerender({ flash: latest });
  finish("registered");
  await waitFor(() =>
    expect(latest).toHaveBeenCalledWith({
      tone: "ok",
      text: "GitHub App registered.",
    }),
  );
  expect(latest).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

it.each(["registered", "installed"])(
  "does not trust a forged %s marker or cached App when native verification fails",
  async (marker) => {
    window.history.replaceState(
      {},
      "",
      `/settings/connections/github?github_app=${marker}`,
    );
    api.verify.mockRejectedValue(
      new Error("Missing key or GitHub denied access"),
    );
    const flash = vi.fn();
    renderHook(() => useGithubAppReturn("github", flash));
    await waitFor(() =>
      expect(flash).toHaveBeenCalledWith({
        tone: "err",
        text: expect.stringContaining("could not be verified"),
      }),
    );
    expect(flash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
    expect(window.location.search).toBe("");
  },
);

it("announces an installation only after strict native verification confirms a real installation", async () => {
  window.history.replaceState(
    {},
    "",
    "/settings/connections/github?keep=yes&github_app=installed",
  );
  api.verify.mockResolvedValue(app);
  const flash = vi.fn();
  renderHook(() => useGithubAppReturn("github", flash));
  await waitFor(() =>
    expect(flash).toHaveBeenCalledWith({
      tone: "ok",
      text: "GitHub App installation verified.",
    }),
  );
  expect(api.verify).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe("?keep=yes");
});

it("does not claim installation success when the verified App has no installations", async () => {
  window.history.replaceState(
    {},
    "",
    "/settings/connections/github?github_app=installed",
  );
  const uninstalled = { ...app, installations: [] };
  api.verify.mockResolvedValue(uninstalled);
  api.read.mockReturnValue(uninstalled);
  const flash = vi.fn();
  renderHook(() => useGithubAppReturn("github", flash));
  await waitFor(() =>
    expect(flash).toHaveBeenCalledWith({
      tone: "err",
      text: "GitHub has not confirmed an App installation.",
    }),
  );
});

it("reports a genuine converted guest claim and its pending key custody accurately", async () => {
  window.history.replaceState(
    {},
    "",
    "/settings/connections/github?github_app=claim&code=one-time-code&state=checked-state",
  );
  api.claim.mockResolvedValue("registered");
  api.pending.mockReturnValue(true);
  const flash = vi.fn();
  renderHook(() => useGithubAppReturn("github", flash));
  await waitFor(() =>
    expect(flash).toHaveBeenCalledWith({
      tone: "ok",
      text: "GitHub App registered. Unlock your vault to save its key.",
    }),
  );
  expect(api.claim).toHaveBeenCalledWith("one-time-code", "checked-state");
});

it.each(["navigation", "unmount"])(
  "does not rewrite the current route or emit a late toast after %s",
  async (change) => {
    window.history.replaceState(
      {},
      "",
      "/settings/connections/github?github_app=installed",
    );
    let finish: (value: typeof app) => void = () => {};
    const pending = new Promise<typeof app>((resolve) => {
      finish = resolve;
    });
    api.verify.mockReturnValue(pending);
    const flash = vi.fn();
    const view = renderHook(() => useGithubAppReturn("github", flash));
    if (change === "unmount") view.unmount();
    window.history.replaceState({}, "", "/settings/features?keep=other-route");
    finish(app);
    await pending;
    expect(window.location.pathname + window.location.search).toBe(
      "/settings/features?keep=other-route",
    );
    expect(flash).not.toHaveBeenCalled();
  },
);
