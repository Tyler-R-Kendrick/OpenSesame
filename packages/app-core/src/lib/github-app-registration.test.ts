/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { localStore, maybePage, sessionStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { allowGithub } from "./github-app-authority.test-support.js";
import {
  claimGithubAppCode,
  verifyGithubAppInstallations,
} from "./github-app-claim.js";
import { credentials } from "./github-app-direct.test-support.js";
import {
  type LocalGithubApp,
  forgetLocalGithubApp,
  readLocalGithubApp,
  refreshGithubAppOwner,
  rememberLocalGithubApp,
} from "./github-app-local.js";
import {
  hasPendingGithubAppSecret,
  pemFromVault,
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import {
  captureGithubAuthority,
  startGithubRegistration,
} from "./github-app-vault-transport.js";
import { vaultStore } from "./vault/store.js";

const APP: LocalGithubApp = {
  id: "12",
  key: "github-oauth",
  displayName: "Fixture App",
  htmlUrl: "https://github.com/apps/fixture",
  ownerLogin: null,
  ownerType: null,
  installedByLogin: null,
  installations: [],
};
const conversion = {
  id: 12,
  slug: "fixture",
  name: APP.displayName,
  client_id: "Iv1.fixture",
  client_secret: "conversion-private",
  pem: credentials.privateKey,
  html_url: APP.htmlUrl,
  owner: { login: "fixture-owner", type: "Organization" },
};

function vault(tomb = "owner-A", guest = false) {
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...vaultStore.getSnapshot(),
    tomb,
    guest,
    status: "unlocked",
    awaitingSecondStep: false,
    items: [],
  });
}
function ceremony() {
  startGithubRegistration(
    "state-once",
    maybePage()?.location.href ??
      "https://app.example/settings/connections/github",
  );
}

beforeEach(() => {
  configureHost(createTestHost());
  allowGithub();
  vi.stubGlobal("crypto", webcrypto);
  vault();
});
afterEach(() => {
  forgetLocalGithubApp();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("rejects a callback in a different vault, stale transaction, bare legacy state, wrong state and replay before any request", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(conversion),
  );
  vi.stubGlobal("fetch", fetch);
  ceremony();
  vault("owner-B");
  expect(await claimGithubAppCode("one-time-code", "state-once")).toBe(
    "ignored",
  );
  vault();
  ceremony();
  sessionStore().setItem(
    "opensesame.github-app.registration",
    JSON.stringify({
      state: "state-once",
      ownerTomb: "owner-A",
      returnUrl:
        maybePage()?.location.href ??
        "https://app.example/settings/connections/github",
      createdAt: Date.now() - 3600001,
    }),
  );
  expect(await claimGithubAppCode("code", "state-once")).toBe("ignored");
  sessionStore().setItem("opensesame.github-app.state", "state-once");
  expect(await claimGithubAppCode("code", "state-once")).toBe("ignored");
  ceremony();
  expect(await claimGithubAppCode("code", "wrong-state")).toBe("ignored");
  expect(await claimGithubAppCode("code", "wrong-state")).toBe("ignored");
  expect(fetch).not.toHaveBeenCalled();
});

it("converts directly with one-time state and seals only the API secret into the captured vault", async () => {
  const save = vi.spyOn(vaultStore, "saveItems").mockResolvedValue();
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(conversion),
  );
  vi.stubGlobal("fetch", fetch);
  ceremony();
  expect(await claimGithubAppCode("manifest-code", "state-once")).toBe(
    "registered",
  );
  expect(await claimGithubAppCode("manifest-code", "state-once")).toBe(
    "ignored",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/app-manifests/manifest-code/conversions",
  );
  expect(save.mock.calls[0]?.[0][0]).toMatchObject({
    kind: "secret",
    value: `conversion-private\n${credentials.privateKey}`,
  });
  expect(readLocalGithubApp()).toMatchObject({
    id: "12",
    ownerLogin: "fixture-owner",
  });
  expect(
    JSON.stringify([
      ...Array.from({ length: localStore().length }, (_, i) =>
        localStore().getItem(localStore().key(i) ?? ""),
      ),
    ]),
  ).not.toContain("PRIVATE KEY");
});

it.each(["forget", "lease", "vault", "policy"])(
  "does not resurrect a claim after %s during conversion",
  async (change) => {
    let reply: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      reply = resolve;
    });
    const policy = allowGithub();
    const fetch = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetch);
    ceremony();
    const result = claimGithubAppCode("code", "state-once");
    if (change === "forget") forgetLocalGithubApp();
    if (change === "lease") policy.revoke();
    if (change === "vault") vault("owner-B");
    if (change === "policy")
      policy.network.mockReturnValue({
        externalServices: "allow",
        allowedServiceOrigins: ["https://other.example"],
      });
    reply(Response.json(conversion));
    expect(await result).toBe("failed");
    expect(readLocalGithubApp()).toBeNull();
    expect(hasPendingGithubAppSecret(APP.id)).toBe(false);
  },
);

it("reads App ownership and installation accounts directly and distinguishes refusal from cached presence", async () => {
  rememberLocalGithubApp(APP);
  stashPendingGithubAppSecret(APP, credentials.privateKey);
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).includes("installations")
      ? Response.json([
          {
            id: 77,
            account: { login: "fixture-org", type: "Organization" },
            repository_selection: "selected",
          },
        ])
      : Response.json(conversion),
  );
  vi.stubGlobal("fetch", fetch);
  const owned = await refreshGithubAppOwner();
  expect(owned?.ownerLogin).toBe("fixture-owner");
  expect((await verifyGithubAppInstallations()).installations).toEqual([
    { id: "77", accountLogin: "fixture-org", accountType: "Organization" },
  ]);
  for (const [input, init] of fetch.mock.calls) {
    expect(String(input)).toMatch(/^https:\/\/api.github.com\/app/);
    expect(String(init?.body)).not.toContain("PRIVATE KEY");
  }
  fetch.mockImplementation(
    async () => new Response("reflected-secret", { status: 403 }),
  );
  await expect(verifyGithubAppInstallations()).rejects.toThrow(
    "did not authorize",
  );
  expect(readLocalGithubApp()?.id).toBe(APP.id);
});

it("invalidates an owned operation on lock even after the same vault is unlocked again", () => {
  let locked = () => {};
  vi.spyOn(vaultStore, "onLock").mockImplementation((listener) => {
    locked = listener;
    return () => {};
  });
  const operation = captureGithubAuthority();
  locked();
  vault();
  expect(operation.transport.signal.aborted).toBe(true);
  expect(() => operation.transport.assertCurrent()).toThrow();
  operation.close();
});

it("binds a guest's pending secret once and never publishes a binding after Remove during sealing", async () => {
  vault("guest", true);
  stashPendingGithubAppSecret(APP, credentials.privateKey);
  vault("owner-A");
  const save = vi
    .spyOn(vaultStore, "saveItems")
    .mockRejectedValue(new Error("storage refused"));
  await sealPendingGithubAppSecret();
  vault("owner-B");
  await sealPendingGithubAppSecret();
  expect(pemFromVault(APP)).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
  vault("owner-A");
  let finish = () => {};
  const queued = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const writes: string[] = [];
  save.mockImplementation(async (items, _folder, check) => {
    await queued;
    check?.();
    writes.push(...items.map((item) => item.id));
  });
  const sealing = sealPendingGithubAppSecret();
  forgetLocalGithubApp();
  finish();
  await sealing;
  expect(localStore().getItem("opensesame.github-app.secret-item")).toBeNull();
  expect(hasPendingGithubAppSecret(APP.id)).toBe(false);
  expect(writes).toEqual([]);
});

it.each(["origin", "pathname"])(
  "rejects a callback outside its registered %s before conversion",
  async (part) => {
    const callback = new URL(
      maybePage()?.location.href ??
        "https://app.example/settings/connections/github",
    );
    if (part === "origin") callback.hostname = "other.example";
    else callback.pathname = "/another-callback";
    startGithubRegistration("state-once", callback.toString());
    const fetch = vi.fn(async () => Response.json(conversion));
    vi.stubGlobal("fetch", fetch);
    expect(await claimGithubAppCode("code", "state-once")).toBe("ignored");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("binds an unsealed guest key on its first durable PEM read", () => {
  vault("guest", true);
  stashPendingGithubAppSecret(APP, credentials.privateKey);
  vault("owner-A");
  expect(pemFromVault(APP)).toBe(credentials.privateKey.trim());
  vault("owner-B");
  expect(pemFromVault(APP)).toBeNull();
});

it("refuses a PIN session still awaiting its second factor", () => {
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...vaultStore.getSnapshot(),
    awaitingSecondStep: true,
  });
  stashPendingGithubAppSecret(APP, credentials.privateKey);
  expect(() => captureGithubAuthority()).toThrow("Unlock");
  expect(pemFromVault(APP)).toBeNull();
});

it("does not expose a refused conversion response or persist its reflected secrets", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(`reflected conversion-private ${credentials.privateKey}`, {
          status: 403,
        }),
    ),
  );
  ceremony();
  expect(await claimGithubAppCode("code", "state-once")).toBe("failed");
  expect(readLocalGithubApp()).toBeNull();
  expect(hasPendingGithubAppSecret(APP.id)).toBe(false);
  expect(
    sessionStore().getItem("opensesame.github-app.registration"),
  ).toBeNull();
});
