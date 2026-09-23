/** @vitest-environment jsdom */
import { type SecretItem, createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshGithubAppInstallations } from "./github-app-claim.js";
import { forgetLocalGithubApp } from "./github-app-local.js";
import {
  extractGithubAppPem,
  pemFromVault,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { vaultStore } from "./vault/store.js";

const APP = { id: "4997182", displayName: "OpenSesame Local" };
const APP_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEapp\n-----END RSA PRIVATE KEY-----";
const SSH_RSA =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEssh\n-----END RSA PRIVATE KEY-----";
const SSH_OPENSSH =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----";

function secret(name: string, value: string): SecretItem {
  const item = createItem("secret", name);
  item.value = value;
  return item;
}

function openVault(items: SecretItem[], status: "unlocked" | "locked") {
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    status,
    tomb: "personal",
    guest: false,
    items,
  });
}

function rememberApp(): void {
  localStorage.setItem(
    "opensesame.github-app.public",
    JSON.stringify({
      ...APP,
      key: "github-oauth",
      htmlUrl: "https://github.com/apps/opensesame-local",
      ownerLogin: "Tyler-R-Kendrick",
      ownerType: "User",
      installedByLogin: null,
      installations: [],
    }),
  );
}

describe("github app PEM lookup", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    forgetLocalGithubApp();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("never posts an unrelated SSH key to the relay", async () => {
    rememberApp();
    const gitSecret = secret(
      "Git · origin",
      JSON.stringify({ ssh_private_key: SSH_OPENSSH, passphrase: "hunter2" }),
    );
    const rsaKey = secret("id_rsa", `${SSH_RSA}\npassphrase: hunter2`);
    openVault([gitSecret, rsaKey], "unlocked");
    const fetchMock = vi.fn(
      async (_input: RequestInfo, _init?: RequestInit) =>
        new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await refreshGithubAppInstallations();
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body ?? "")).not.toContain("PRIVATE KEY");
      expect(String(init?.body ?? "")).not.toContain("hunter2");
    }
    expect(pemFromVault(APP)).toBeNull();
  });

  it("reads only the item bound to this App, and nothing once it is gone", () => {
    const bound = secret("renamed", `client-secret\n${APP_PEM}`);
    const namedDecoy = secret(APP.displayName, SSH_RSA);
    localStorage.setItem(
      "opensesame.github-app.secret-item",
      JSON.stringify({ appId: APP.id, itemId: bound.id }),
    );
    openVault([namedDecoy, bound], "unlocked");
    expect(pemFromVault(APP)).toBe(APP_PEM);

    vi.restoreAllMocks();
    openVault([namedDecoy], "unlocked");
    expect(pemFromVault(APP)).toBeNull();
  });

  it("finds a pre-binding record by its exact App name only", () => {
    openVault(
      [secret("Other", SSH_RSA), secret(APP.displayName, APP_PEM)],
      "unlocked",
    );
    expect(pemFromVault(APP)).toBe(APP_PEM);
  });

  it("gives nothing, not even a pending claim, while the vault is locked", () => {
    openVault([secret(APP.displayName, APP_PEM)], "locked");
    stashPendingGithubAppSecret(APP, APP_PEM);
    expect(pemFromVault(APP)).toBeNull();
  });

  it("stops the PEM at its END line", () => {
    expect(
      extractGithubAppPem(`client-secret\n${APP_PEM}\n{"passphrase":"x"}`),
    ).toBe(APP_PEM);
    expect(extractGithubAppPem(SSH_OPENSSH)).toBeNull();
    expect(
      extractGithubAppPem("-----BEGIN RSA PRIVATE KEY-----\nMIIE"),
    ).toBeNull();
  });
});
