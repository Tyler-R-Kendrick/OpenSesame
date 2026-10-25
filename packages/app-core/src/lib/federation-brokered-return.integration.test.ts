/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { processReturn } from "../screens/federation-return-model.js";
import { createTestHost } from "../test-host.js";
import { advanceAuthGeneration } from "./auth-generation.js";
import { readAuthOutcome } from "./auth-outcome.js";
import {
  callbackHost,
  exchangeIssuer,
} from "./federation-exchange.test-support.js";
import { federationSessionGeneration } from "./federation-native-session.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import {
  adoptBrokeredSession,
  clearSession,
  completeSignIn,
  loadSession,
} from "./federation.js";
import { clearSession as clearIdentity, currentSession } from "./identity.js";
import { kvDelete } from "./kv.js";
import { vaultStore } from "./vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "./vfs.js";

const closes: (() => Promise<void>)[] = [];
beforeEach(() => {
  callbackHost();
  vaultStore.lock();
  clearSession();
  clearIdentity();
});
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vaultStore.lock();
  clearSession();
  clearIdentity();
  await vfsFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
async function setup(mode: "public" | "brokered" = "brokered") {
  const page = callbackHost();
  const issuer = await exchangeIssuer("none", mode);
  closes.push(issuer.close);
  // Explicit legacy broker interoperability policy in this core fixture, never the public PWA default.
  if (mode === "brokered")
    configureHost({
      ...host(),
      securityProfile: {
        version: 1,
        profile: "dedicated_origin",
        canonicalOrigin: "https://app.example.test",
        headerSecurity: true,
      },
    });
  return { page, issuer };
}
it("the real default return completes signed HTTP verification, crosses only its own saved generation, and adopts the same principal", async () => {
  const { issuer } = await setup();
  const initial = federationSessionGeneration();
  const vault = vaultStore.getSnapshot();
  expect(await processReturn()).toEqual({ returnTo: "/vault?keep=1" });
  expect(currentSession()).toMatchObject({
    principalId: "principal-signed-operator",
    accessToken: "adopted-opaque-session",
    issuerOrigin: issuer.issuer,
  });
  expect(loadSession()?.idToken).toBe(issuer.token);
  expect(federationSessionGeneration()).not.toBe(initial);
  expect(issuer.requests).toEqual([
    "POST /token",
    "GET /jwks",
    "POST /v1/principals/federated-session",
  ]);
  expect(vaultStore.getSnapshot().status).toBe(vault.status);
  expect(vaultStore.getSnapshot().tomb).toBe(vault.tomb);
  expect(readAuthOutcome()).toMatchObject({
    kind: "linked",
    who: "Signed operator",
  });
  expect(issuer.errors).toEqual([]);
});
it("the backendless public return never treats an ordinary IdP access token as brokered authority", async () => {
  const { issuer } = await setup("public");
  const generation = federationSessionGeneration();
  const result = await completeSignIn();
  expect(result?.identity.pairwiseSub).toBe("signed-operator");
  expect(result?.accessToken).toBeUndefined();
  await expect(
    adoptBrokeredSession(issuer.accessToken, generation),
  ).rejects.toMatchObject({ code: "sign_in_cancelled" });
  expect(issuer.settings.identityApi).toBe("");
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(currentSession()).toBeNull();
});
it("consumes the exact handoff once and rejects another use of its initiating generation before HTTP", async () => {
  const { issuer } = await setup();
  const generation = federationSessionGeneration();
  const result = await completeSignIn();
  expect(result?.accessToken).toBe(issuer.accessToken);
  await adoptBrokeredSession(issuer.accessToken, generation);
  clearIdentity();
  await expect(
    adoptBrokeredSession(issuer.accessToken, generation),
  ).rejects.toMatchObject({ code: "sign_in_cancelled" });
  expect(
    issuer.requests.filter((url) => url.includes("federated-session")),
  ).toHaveLength(1);
  expect(currentSession()).toBeNull();
});
it("a foreign token cannot consume or retarget the original completion receipt", async () => {
  const { issuer } = await setup();
  const generation = federationSessionGeneration();
  await completeSignIn();
  await expect(
    adoptBrokeredSession(`${issuer.accessToken}-foreign`, generation),
  ).rejects.toMatchObject({ code: "sign_in_cancelled" });
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  await adoptBrokeredSession(issuer.accessToken, generation);
  expect(currentSession()?.principalId).toBe("principal-signed-operator");
  expect(issuer.errors).toEqual([]);
});
it("configuration replacement after publication rejects its receipt before HTTP adoption", async () => {
  const { issuer } = await setup();
  const generation = federationSessionGeneration();
  await completeSignIn();
  issuer.settings.signIn.providers.splice(0);
  await expect(
    adoptBrokeredSession(issuer.accessToken, generation),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(currentSession()).toBeNull();
});
it("a real invalidly signed broker response cannot reach adoption through the default return", async () => {
  callbackHost();
  const issuer = await exchangeIssuer("signature", "brokered");
  closes.push(issuer.close);
  configureHost({
    ...host(),
    securityProfile: {
      version: 1,
      profile: "dedicated_origin",
      canonicalOrigin: "https://app.example.test",
      headerSecurity: true,
    },
  });
  await expect(processReturn()).rejects.toMatchObject({
    code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  });
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(readFederationSessionJson()).toBeNull();
  expect(currentSession()).toBeNull();
});
it.each([
  "signout",
  "lock",
  "configuration",
  "auth-generation",
  "route",
  "host",
  "fetch",
] as const)(
  "refuses %s during the actual held adoption response without restoring a session",
  async (withdrawal) => {
    const { issuer, page } = await setup();
    const held = issuer.holdAdoption();
    const returning = processReturn();
    await held.arrived;
    expect(currentSession()).toBeNull();
    if (withdrawal === "signout") {
      clearSession();
      clearIdentity();
    }
    if (withdrawal === "lock") vaultStore.lock();
    if (withdrawal === "configuration")
      issuer.settings.signIn.providers.splice(0);
    if (withdrawal === "auth-generation") advanceAuthGeneration();
    if (withdrawal === "route") page.navigate("/different-ceremony");
    if (withdrawal === "host") configureHost({ ...host() });
    if (withdrawal === "fetch")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.reject(new Error("Replacement carrier must not run")),
        ),
      );
    held.release();
    await expect(returning).rejects.toMatchObject({
      code: ["signout", "lock", "auth-generation"].includes(withdrawal)
        ? "sign_in_cancelled"
        : "invalid_request",
    });
    expect(currentSession()).toBeNull();
    expect(readAuthOutcome()).toBeNull();
    expect(issuer.requests).toEqual([
      "POST /token",
      "GET /jwks",
      "POST /v1/principals/federated-session",
    ]);
    expect(issuer.errors).toEqual([]);
  },
);
it("a later real signed authentication survives an older held brokered adoption", async () => {
  const first = await setup();
  const held = first.issuer.holdAdoption();
  const returning = processReturn();
  await held.arrived;
  const second = await exchangeIssuer();
  closes.push(second.close);
  first.page.navigate("/?code=one-use-code&state=state-original-callback");
  const replacement = await completeSignIn();
  expect(replacement?.identity.issuer).toBe(second.issuer);
  held.release();
  await expect(returning).rejects.toMatchObject({ code: "sign_in_cancelled" });
  expect(loadSession()?.issuer).toBe(second.issuer);
  expect(currentSession()).toBeNull();
  expect(second.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(first.issuer.errors).toEqual([]);
  expect(second.errors).toEqual([]);
});
it("actual brokered return preserves an existing guest vault without linking or inventing another principal", async () => {
  const { issuer } = await setup();
  await vaultStore.createGuest();
  const guest = vaultStore.getSnapshot();
  expect(guest.guest).toBe(true);
  expect(await processReturn()).toEqual({ returnTo: "/vault?keep=1" });
  expect(vaultStore.getSnapshot().tomb).toBe(guest.tomb);
  expect(vaultStore.getSnapshot().status).toBe("unlocked");
  expect(issuer.requests).toEqual([
    "POST /token",
    "GET /jwks",
    "POST /v1/principals/federated-session",
  ]);
});
it("actual signed brokered return leaves a genuinely created and locked vault locked", async () => {
  const { issuer } = await setup();
  await vfsFlush();
  for (const path of [HEADER_PATH, BODY_PATH, INDEX_PATH])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin("48291037");
  vaultStore.lock();
  expect(vaultStore.getSnapshot().status).toBe("locked");
  const tomb = vaultStore.getSnapshot().tomb;
  expect(await processReturn()).toEqual({ returnTo: "/vault?keep=1" });
  expect(vaultStore.getSnapshot().status).toBe("locked");
  expect(vaultStore.getSnapshot().tomb).toBe(tomb);
  expect(currentSession()?.principalId).toBe("principal-signed-operator");
  expect(readFederationSessionJson()).not.toBeNull();
  expect(issuer.errors).toEqual([]);
});
