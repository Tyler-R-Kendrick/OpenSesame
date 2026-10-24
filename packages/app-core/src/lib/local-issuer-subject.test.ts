import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { createPkcePair } from "@opensesame/sdk-browser";
import { localMessage } from "@opensesame/static-auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureLocalApplication } from "./local-applications.js";
import { origin } from "./local-authenticator.fixture.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { LocalIssuerChannel } from "./local-issuer-channel.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { signInLocalIdentity } from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, readFile, unlockTomb, vfsSeams } from "./vfs.js";

type IssuerRpcFields = { code?: string; verifier?: string; scope?: string };
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
let unbind: () => void;
const channels: { issuer: LocalIssuerChannel; pipe: MessageChannel }[] = [];
beforeEach(async () => {
  unbind = bindLocalIamLockResets();
  fixture = await localRequestFixture();
});
afterEach(() => {
  for (const { issuer, pipe } of channels.splice(0)) {
    issuer.close();
    pipe.port1.close();
    pipe.port2.close();
  }
  unbind();
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connect(applicationId = fixture.applicationId) {
  const pkce = await createPkcePair();
  const request = {
    applicationId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256" as const,
  };
  const opener = { closed: false, postMessage: vi.fn() };
  const browser = Object.assign(new EventTarget(), { opener });
  vi.stubGlobal("window", browser);
  const issuer = new LocalIssuerChannel(fixture.tomb, request, vi.fn());
  const pipe = new MessageChannel();
  channels.push({ issuer, pipe });
  const inbox: NonNullable<ReturnType<typeof localMessage>>[] = [];
  pipe.port1.onmessage = (event: MessageEvent<BoundaryValue>) => {
    const message = localMessage(event.data, request.state);
    if (message) inbox.push(message);
  };
  browser.dispatchEvent(
    Object.assign(new Event("message"), {
      source: opener,
      origin: "https://rp.example.test",
      data: { type: "opensesame:local:connect", state: request.state },
      ports: [pipe.port2],
    }),
  );
  async function take(type: string) {
    await vi.waitFor(() =>
      expect(inbox.some((row) => row.type === type)).toBe(true),
    );
    const message = inbox.splice(
      inbox.findIndex((row) => row.type === type),
      1,
    )[0];
    if (!message) throw new Error("Missing response");
    return message;
  }
  let id = 0;
  function send(type: string, extra: IssuerRpcFields = {}) {
    pipe.port1.postMessage({
      type,
      id: String(++id),
      state: request.state,
      ...extra,
    });
  }
  await issuer.approve(fixture.session);
  const code = await take("code");
  const value = code.code;
  if (!isString(value)) throw new Error("Missing code");
  return {
    take,
    send,
    redeem: () =>
      send("redeem", {
        code: value,
        verifier: pkce.codeVerifier,
      }),
    identity: async () => {
      const reply = await take("identity");
      expect(reply).toMatchObject({
        issuer: origin,
        audience: applicationId,
        nonce: request.nonce,
        scope: "openid",
      });
      if (!isString(reply.sub)) throw new Error("Missing subject");
      return { subject: reply.sub };
    },
  };
}

it("emits different opaque subjects for two approved apps, stable on userinfo and fresh consent", async () => {
  const next = await fixture.change({
    action: "create",
    kind: "application",
    name: "Second app",
  });
  const app = next.entries.find((row) => row.name === "Second app");
  if (!app) throw new Error("Missing second app");
  fixture.session = await signInLocalIdentity(fixture.tomb, fixture.personId);
  await configureLocalApplication(fixture.tomb, 1, app.id, {
    applicationId: app.id,
    organizationId: fixture.organizationId,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid"],
  });
  // A directory edit requires a fresh authenticated session.
  fixture.session = await signInLocalIdentity(fixture.tomb, fixture.personId);
  const first = await connect();
  first.redeem();
  const identity = await first.identity();
  expect(identity.subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(identity.subject).not.toBe(fixture.personId);
  first.send("userinfo", { scope: "openid" });
  expect((await first.identity()).subject).toBe(identity.subject);
  const second = await connect(app.id);
  second.redeem();
  expect((await second.identity()).subject).not.toBe(identity.subject);
  first.send("revoke");
  await first.take("revoked");
  // Simulate a fresh vault session: mappings persist, presentation handles do not.
  lockAllTombs();
  unlockTomb(fixture.tomb, fixture.vaultKey);
  fixture.session = await signInLocalIdentity(fixture.tomb, fixture.personId);
  const fresh = await connect();
  fresh.redeem();
  expect((await fresh.identity()).subject).toBe(identity.subject);
  expect(
    new TextDecoder().decode(
      await readFile(fixture.tomb, "config/identity-grants"),
    ),
  ).toContain(fixture.personId);
});

it("does not emit an identity when persisting its pairwise subject fails", async () => {
  const channel = await connect();
  const write = vfsSeams.writeRaw;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (name, ...args) => {
    if (name.includes("identity-subjects")) throw new Error("Storage failed");
    return write(name, ...args);
  });
  channel.redeem();
  expect(await channel.take("error")).toHaveProperty(
    "error",
    "authorization_unavailable",
  );
});

it("does not release claims if the vault locks during subject persistence", async () => {
  const channel = await connect();
  const write = vfsSeams.writeRaw;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (name, ...args) => {
    await write(name, ...args);
    if (name.includes("identity-subjects")) vaultStore.lock();
  });
  channel.redeem();
  await channel.take("closed");
  await expect(channel.identity()).rejects.toThrow();
});
