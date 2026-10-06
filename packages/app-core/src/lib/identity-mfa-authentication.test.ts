import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionSeams, listConnections } from "./connections.js";
import { requiresFreshOwnerAuthentication } from "./decoy-session.js";
import { deviceIdentitySeams } from "./device-identity.js";
import {
  currentSession,
  hostFetch,
  identityFetch,
  identitySeams,
} from "./identity.js";
import { resolveCurrentAccessRole } from "./local-rbac.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "./vault/protection/protector-enrollment.test-support.js";
import { sendCode } from "./vault/remote-code.js";
import { VaultStore } from "./vault/store.js";

let store: VaultStore;
let challenge = 0;
let requests: Array<{ url: string; init: RequestInit }>;
const remote = deviceIdentitySeams.remoteIdentityApi;
beforeEach(async () => {
  await clearVaultSurface();
  deviceIdentitySeams.remoteIdentityApi = () => "https://identity.example.test";
  requests = [];
  challenge = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/send"))
      return Response.json({
        challengeId: `code-${++challenge}`,
        to: "o•••@example.test",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
    const body = JSON.parse(String(init.body));
    return body.code === "123456"
      ? new Response(null, { status: 204 })
      : Response.json({ error: "invalid_code" }, { status: 401 });
  });
  vi.spyOn(identitySeams, "currentSession").mockReturnValue(
    overlapCast({
      accessToken: "owner-session-fixture",
      cookieOnly: false,
      adopted: false,
    }),
  );
  store = new VaultStore();
  await store.create(PASSWORD);
  await store.beginCodeEnrollment("email", "owner@example.test");
  await store.confirmCodeEnrollment("123456");
  store.lock();
  await store.createGuest({ decoy: true, resume: false });
  store.lock();
  requests = [];
});
afterEach(() => {
  store.lock();
  deviceIdentitySeams.remoteIdentityApi = remote;
  vi.restoreAllMocks();
});

it("admits only connected second-factor operations after an actual fresh primary proof", async () => {
  const host = vi.spyOn(identitySeams, "hostFetch");
  const normal = vi.spyOn(identitySeams, "identityFetch");
  const connections = vi
    .spyOn(connectionSeams, "listConnections")
    .mockResolvedValue([]);
  expect(currentSession()).toBeNull();
  await expect(listConnections()).resolves.toEqual([]);
  await expect(resolveCurrentAccessRole("guest")).resolves.toBe("guest");
  await expect(sendCode("email", "owner@example.test")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(store.requestSecondStepCode("email")).rejects.toThrow(/primary/);
  expect(requests).toHaveLength(0);
  await store.unlock(PASSWORD);
  expect(store.getSnapshot().awaitingSecondStep).toBe(true);
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await expect(hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(identityFetch("/v1/principals/me")).rejects.toThrow(
    /authenticate again/,
  );
  expect(host).not.toHaveBeenCalled();
  expect(normal).not.toHaveBeenCalled();
  expect(connections).not.toHaveBeenCalled();
  await store.requestSecondStepCode("email");
  await expect(store.confirmRemoteCode("000000")).rejects.toThrow(
    /did not match/,
  );
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await store.confirmRemoteCode("123456");
  expect(requiresFreshOwnerAuthentication()).toBe(false);
  expect(store.getSnapshot().status).toBe("unlocked");
  expect(currentSession()).not.toBeNull();
  await listConnections();
  expect(connections).toHaveBeenCalledTimes(1);
  expect(requests.map((request) => request.url)).toEqual([
    "https://identity.example.test/v1/mfa/code/send",
    "https://identity.example.test/v1/mfa/code/verify",
    "https://identity.example.test/v1/mfa/code/verify",
  ]);
  expect(requests.every((request) => request.init.method === "POST")).toBe(
    true,
  );
});

it("withholds a stale connected challenge and refuses oversized verification input before egress", async () => {
  await store.unlock(PASSWORD);
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.requestSecondStepCode("email");
  for (let n = 0; n < 20 && !finish; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  store.lock();
  finish(Response.json({ challengeId: "stale-code", to: "o•••@example.test" }));
  await expect(pending).rejects.toThrow(/authenticate again|changed/);
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await store.unlock(PASSWORD);
  await store.requestSecondStepCode("email");
  const count = requests.length;
  await expect(store.confirmRemoteCode("1".repeat(1024))).rejects.toThrow(
    /Invalid second-factor code/,
  );
  expect(requests).toHaveLength(count);
  expect(requiresFreshOwnerAuthentication()).toBe(true);
});
