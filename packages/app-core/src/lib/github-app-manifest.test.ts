/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyConnectCallbackBase } from "./connect-callback.js";
import {
  buildGithubAppRegistration,
  claimGithubAppCode,
  forgetLocalGithubApp,
  githubAppRedirectUrl,
  githubAppRelayBase,
  readLocalGithubApp,
  refreshGithubAppInstallations,
} from "./github-app-manifest.js";
import {
  hasPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { type VaultState, vaultStore } from "./vault/store.js";

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

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
const PUBLIC_RECORD = JSON.stringify({
  id: "4997182",
  key: "github-oauth",
  displayName: "OpenSesame Local",
  htmlUrl: "https://github.com/apps/opensesame-local",
  ownerLogin: "Tyler-R-Kendrick",
  ownerType: "User",
  installedByLogin: null,
  installations: [],
});

function vaultAs(overrides: Partial<VaultState>): void {
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    items: [],
    folders: [],
    ...overrides,
  });
}

function relay() {
  const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/github-app/convert")) {
      return Response.json({
        id: 4997182,
        client_id: "Iv1.example",
        name: "OpenSesame Local",
        html_url: "https://github.com/apps/opensesame-local",
        client_secret: "client-secret",
        pem: PEM,
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
      });
    }
    return Response.json({
      ownerLogin: "Tyler-R-Kendrick",
      ownerType: "User",
      installations: [
        { id: "1", accountLogin: "Tyler-R-Kendrick", accountType: "User" },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function storedValues(...stores: Storage[]): string[] {
  const out: string[] = [];
  for (const store of stores) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null) out.push(store.getItem(key) ?? "");
    }
  }
  return out;
}

describe("github app secret never rests in web storage", () => {
  let local: Storage;
  let session: Storage;

  beforeEach(() => {
    local = memoryStorage();
    session = memoryStorage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    session.setItem("opensesame.github-app.state", "claim-state");
  });

  afterEach(() => {
    forgetLocalGithubApp();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a guest's claimed key out of every storage key", async () => {
    vaultAs({ status: "unlocked", tomb: "guest", guest: true });
    relay();
    await expect(claimGithubAppCode("gh-code", "claim-state")).resolves.toBe(
      "registered",
    );
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
    expect(hasPendingGithubAppSecret("4997182")).toBe(true);
  });

  it("keeps a locked device's claimed key out of every storage key", async () => {
    vaultAs({ status: "locked", tomb: "personal", guest: false });
    const fetchMock = relay();
    await expect(claimGithubAppCode("gh-code", "claim-state")).resolves.toBe(
      "registered",
    );
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
    // Locked: nothing posts the key anywhere.
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
    }
  });

  it("seals into an open vault and drops the memory copy at once", async () => {
    vaultAs({ status: "unlocked", tomb: "personal", guest: false });
    const addItems = vi
      .spyOn(vaultStore, "addItems")
      .mockResolvedValue(undefined);
    relay();
    await claimGithubAppCode("gh-code", "claim-state");
    expect(addItems).toHaveBeenCalledTimes(1);
    const [sealed] = addItems.mock.calls[0]?.[0] ?? [];
    expect(sealed?.kind).toBe("secret");
    expect(sealed?.kind === "secret" ? sealed.value : "").toContain(PEM);
    expect(hasPendingGithubAppSecret("4997182")).toBe(false);
    expect(
      JSON.parse(local.getItem("opensesame.github-app.secret-item") ?? "{}"),
    ).toEqual({ appId: "4997182", itemId: sealed?.id });
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
  });

  it("removes the legacy cleartext key on first read", () => {
    local.setItem("opensesame.github-app.public", PUBLIC_RECORD);
    local.setItem("opensesame.github-app.pending-pem", PEM);
    session.setItem("opensesame.github-app.pending-pem", PEM);
    expect(readLocalGithubApp()?.id).toBe("4997182");
    expect(local.getItem("opensesame.github-app.pending-pem")).toBeNull();
    expect(session.getItem("opensesame.github-app.pending-pem")).toBeNull();
    expect(hasPendingGithubAppSecret("4997182")).toBe(true);
  });

  it("keeps the local App when the relay rejects a just-claimed key", async () => {
    local.setItem("opensesame.github-app.public", PUBLIC_RECORD);
    vaultAs({ status: "unlocked", tomb: "personal", guest: false });
    stashPendingGithubAppSecret(
      { id: "4997182", displayName: "OpenSesame Local" },
      PEM,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "list_failed" }, { status: 401 }),
      ),
    );
    await expect(refreshGithubAppInstallations()).resolves.not.toBeNull();
    expect(local.getItem("opensesame.github-app.public")).not.toBeNull();
    expect(storedValues(local, session).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
  });
});
