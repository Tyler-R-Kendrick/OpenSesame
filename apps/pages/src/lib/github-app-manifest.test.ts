/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "./connect-callback.js";
import {
  buildGithubAppRegistration,
  githubAppRedirectUrl,
  githubAppRelayBase,
  refreshGithubAppInstallations,
} from "./github-app-manifest.js";
import { vaultStore } from "./vault/store.js";

describe("github app redirect url", () => {
  it("uses the Vite origin on loopback so listing does not need Connect", () => {
    applyConnectCallbackBase("https://relay.example");
    try {
      expect(githubAppRelayBase("http://localhost:5180")).toBe(
        "http://localhost:5180",
      );
      expect(
        githubAppRedirectUrl(
          "http://localhost:5180/OpenSesame/connections/github",
          "http://localhost:5180",
        ),
      ).toBe(
        "http://localhost:5180/api/github-app/callback?return_to=http%3A%2F%2Flocalhost%3A5180%2FOpenSesame%2Fconnections%2Fgithub",
      );
    } finally {
      applyConnectCallbackBase("");
    }
  });

  it("uses the Connect relay base on deployed origins", () => {
    applyConnectCallbackBase("https://relay.example");
    try {
      expect(githubAppRelayBase("https://tyler-r-kendrick.github.io")).toBe(
        "https://relay.example",
      );
    } finally {
      applyConnectCallbackBase("");
    }
  });

  it("builds one redirect shape for the active relay base", () => {
    applyConnectCallbackBase("");
    const origin = "http://localhost:5180";
    const returnTo = `${origin}/OpenSesame/connections/github`;
    const registration = buildGithubAppRegistration({
      returnTo,
      displayName: "OpenSesame GitHub",
      origin,
    });
    const base = githubAppRelayBase(origin);
    expect(registration.redirectUrl).toBe(
      `${base}/api/github-app/callback?return_to=${encodeURIComponent(returnTo)}`,
    );
    expect(registration.manifest.redirect_url).toBe(registration.redirectUrl);
    expect(registration.manifest.callback_urls).toEqual([returnTo]);
    expect(registration.manifest.setup_url).toBe(
      `${returnTo}?github_app=installed`,
    );
    expect(sessionStorage.getItem("opensesame.github-app.state")).toBe(
      registration.state,
    );
  });

  it("works for GitHub Pages and Vercel origins without branching", () => {
    for (const origin of [
      "https://tyler-r-kendrick.github.io",
      "https://opensesame.vercel.app",
    ]) {
      const returnTo = `${origin}/OpenSesame/connections/github`;
      applyConnectCallbackBase("https://relay.example");
      try {
        expect(githubAppRedirectUrl(returnTo, origin)).toBe(
          `https://relay.example/api/github-app/callback?return_to=${encodeURIComponent(returnTo)}`,
        );
      } finally {
        applyConnectCallbackBase("");
      }
    }
  });

  it("does not invent a Host-specific callback", () => {
    const spy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    try {
      const registration = buildGithubAppRegistration({
        returnTo: "https://app.example/connections/github",
        origin: "https://app.example",
      });
      expect(String(registration.manifest.redirect_url)).not.toContain(
        "/api/v1/oauth/",
      );
      expect(registration.state).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    } finally {
      spy.mockRestore();
    }
  });
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("github app pending PEM on guest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not drop pending PEM for a guest once the registrant is known", async () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    store.setItem(
      "opensesame.github-app.public",
      JSON.stringify({
        id: "4997182",
        key: "github-oauth",
        displayName: "OpenSesame Local",
        htmlUrl: "https://github.com/apps/opensesame-local",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [],
      }),
    );
    store.setItem("opensesame.github-app.pending-pem", pem);
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "unlocked",
      tomb: "guest",
      guest: true,
      header: null,
      items: [],
      folders: [],
      prefs: {
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        theme: "system",
      },
      lockedOutUntil: null,
      failedAttempts: 0,
      awaitingSecondStep: false,
      durable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ownerLogin: "Tyler-R-Kendrick",
          ownerType: "User",
          installations: [
            { id: "1", accountLogin: "Tyler-R-Kendrick", accountType: "User" },
          ],
        }),
      ),
    );
    await refreshGithubAppInstallations();
    expect(store.getItem("opensesame.github-app.pending-pem")).toContain(
      "PRIVATE KEY",
    );
  });

  it("forgets the local App when GitHub says the credentials are gone", async () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    store.setItem(
      "opensesame.github-app.public",
      JSON.stringify({
        id: "4997182",
        key: "github-oauth",
        displayName: "OpenSesame Local",
        htmlUrl: "https://github.com/apps/opensesame-local",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [],
      }),
    );
    store.setItem("opensesame.github-app.pending-pem", pem);
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "unlocked",
      tomb: "guest",
      guest: true,
      header: null,
      items: [],
      folders: [],
      prefs: {
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        theme: "system",
      },
      lockedOutUntil: null,
      failedAttempts: 0,
      awaitingSecondStep: false,
      durable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "list_failed" }, { status: 401 }),
      ),
    );
    await expect(refreshGithubAppInstallations()).resolves.not.toBeNull();
    expect(store.getItem("opensesame.github-app.public")).not.toBeNull();
    expect(store.getItem("opensesame.github-app.pending-pem")).toBe(pem);
  });
});
