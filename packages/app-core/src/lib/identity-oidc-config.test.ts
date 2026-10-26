import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { consumeNativeOidcProof } from "../browser/oidc/claims.js";
import {
  assertOidcConfigurationSnapshot,
  assertOriginalOidcAuthority,
  tlsOracle,
} from "../browser/oidc/tls.test-support.js";
import { prepareConfiguredOidc } from "../browser/oidc/transaction.js";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  IdentityConnectionDraftSchema,
  identityConnectionUsesBroker,
  normalizeIdentityConnectionDraft,
  publicIdentityDraft,
} from "./identity-connections-schema.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  readIdentityConnection,
  resolveIdentityConnectionSecrets,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import { identityConnectionProblems } from "./identity-connections-validation.js";
import {
  isNativeOidcConfiguration,
  nativeOidcCallbackUri,
} from "./identity-oidc-config.js";
import { kvFlush, kvForgetAll } from "./kv.js";

let disk = makeOpfs();
beforeEach(async () => {
  await kvFlush();
  kvForgetAll();
  disk = makeOpfs();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  configureHost(
    createTestHost({
      originFiles: async () => overlapCast(disk),
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function draft() {
  return {
    ...identityConnectionDraft("byo-identity"),
    issuer: "https://idp.example.test",
    clientId: "registered",
    clientSecret: "synthetic sealed secret",
  };
}
it("old shared drafts receive public-client and exact organization binding defaults", () => {
  const legacy = { ...identityConnectionDraft("byo-identity") };
  Reflect.deleteProperty(legacy, "oidcClientType");
  Reflect.deleteProperty(legacy, "oidcOrganizationParameter");
  Reflect.deleteProperty(legacy, "oidcOrganizationClaim");
  expect(IdentityConnectionDraftSchema.parse(legacy)).toMatchObject({
    oidcClientType: "public",
    oidcOrganizationParameter: "organization",
    oidcOrganizationClaim: "org_id",
  });
});
it("normalization keeps a write-only confidential discriminator while public OIDC stays public", () => {
  const confidential = normalizeIdentityConnectionDraft(draft());
  expect(confidential.oidcClientType).toBe("confidential");
  const edit = publicIdentityDraft(confidential);
  expect(edit.clientSecret).toBe("");
  expect(isNativeOidcConfiguration(edit)).toBe(true);
  expect(identityConnectionUsesBroker(confidential)).toBe(false);
  const publicClient = { ...draft(), clientSecret: "" };
  expect(isNativeOidcConfiguration(publicClient)).toBe(false);
  expect(identityConnectionUsesBroker(publicClient)).toBe(false);
  expect(
    nativeOidcCallbackUri("https://pwa.example.test", "/OpenSesame/"),
  ).toBe("https://pwa.example.test/OpenSesame/auth/native-connector.html");
});
it.each(["scope", "nonce", "client_id", "__proto__"])(
  "rejects reserved organization authorization parameter %s without remote ownership APIs",
  (parameter) => {
    const input = {
      ...draft(),
      organizationId: "org_original",
      oidcOrganizationParameter: parameter,
    };
    expect(identityConnectionProblems(input)).toContain(
      "Enter a valid OIDC organization ID, authorization parameter and signed claim",
    );
  },
);
it("requires a secret for explicitly confidential configuration", () => {
  const input = {
    ...draft(),
    oidcClientType: "confidential" as const,
    clientSecret: "",
  };
  expect(identityConnectionProblems(input)).toContain(
    "Enter the confidential OIDC client secret",
  );
});
it.each([
  "issuer",
  "clientId",
  "organizationId",
  "oidcClientType",
  "oidcOrganizationParameter",
  "oidcOrganizationClaim",
] as const)(
  "a changed %s retires sealed secret retention while unchanged blank edits retain it",
  async (field) => {
    const input = normalizeIdentityConnectionDraft({
      ...draft(),
      organizationId: "org_original",
    });
    const saved = await writeIdentityConnection(input);
    const edit = readIdentityConnection(saved.connectionId);
    if (!edit) throw new Error("Saved configuration missing");
    expect(
      resolveIdentityConnectionSecrets(edit, saved.connectionId).clientSecret,
    ).toBe(input.clientSecret);
    expect(
      resolveIdentityConnectionSecrets(
        {
          ...edit,
          [field]: field === "oidcClientType" ? "public" : "different_binding",
        },
        saved.connectionId,
      ).clientSecret,
    ).toBe("");
  },
);

it("cold device hydration reopens actual sealed custody without rendering its secret", async () => {
  const input = normalizeIdentityConnectionDraft(draft());
  const saved = await writeIdentityConnection(input);
  await kvFlush();
  const opaque = [...disk.files.values()].join("\n");
  expect(disk.files.size).toBeGreaterThan(0);
  expect(opaque).not.toContain(input.clientSecret);
  kvForgetAll();
  await hydrateIdentityConnections();
  expect(readIdentityConnection(saved.connectionId)?.clientSecret).toBe("");
  expect(getIdentityConnectionRuntime(saved.connectionId)?.clientSecret).toBe(
    input.clientSecret,
  );
});

const callback =
  "https://pwa.example.test/OpenSesame/auth/native-connector.html";
it.each(["client_secret_basic", "client_secret_post", "none"])(
  "exchanges actual independently signed OIDC over verified TLS with advertised %s",
  async (method) => {
    const idp = await tlsOracle(method);
    const attempt = await prepareConfiguredOidc(
      idp.config,
      callback,
      idp.transport,
      idp.owner,
    );
    idp.authorize(attempt.authorizationUrl);
    expect(attempt.authorizationUrl).not.toContain("client_secret");
    const proof = await attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    });
    expect(consumeNativeOidcProof(proof).claims).toMatchObject({
      issuer: idp.config.issuer,
      audience: idp.config.clientId,
      subject: "owned-person",
      organizationId: "org_actual",
    });
    expect(() => consumeNativeOidcProof(proof)).toThrow(/already consumed/);
    await expect(
      attempt.complete({
        state: attempt.state,
        code: "independent-once",
        error: false,
      }),
    ).rejects.toThrow(/already consumed/);
    expect(idp.requests.map((row) => row.path)).toEqual([
      "/issuer/.well-known/openid-configuration",
      "/issuer/token",
      "/issuer/jwks",
    ]);
    expect(idp.errors).toEqual([]);
  },
);
it("refuses a public exchange when discovery advertises only confidential authentication", async () => {
  const idp = await tlsOracle("client_secret_basic");
  await expect(
    prepareConfiguredOidc(
      { ...idp.config, clientSecret: "" },
      callback,
      idp.transport,
      idp.owner,
    ),
  ).rejects.toThrow(/public-client authentication/);
  expect(idp.requests).toHaveLength(1);
  expect(idp.errors).toEqual([]);
});

const response = (state: string) => ({
  state,
  code: "independent-once",
  error: false,
});
it.each(["token", "jwks", "both"] as const)(
  "accepts independently signed TLS discovery delegating %s to an explicitly approved different host",
  async (split) => {
    const idp = await tlsOracle("client_secret_basic", split);
    expect(
      new URL(idp.tokenBase).hostname !== new URL(idp.config.issuer).hostname ||
        new URL(idp.jwksBase).hostname !== new URL(idp.config.issuer).hostname,
    ).toBe(true);
    const attempt = await prepareConfiguredOidc(
      idp.config,
      callback,
      idp.transport,
      idp.owner,
    );
    expect(new URL(attempt.authorizationUrl).origin).toBe(
      new URL(idp.tokenBase).origin,
    );
    idp.authorize(attempt.authorizationUrl);
    const proof = await attempt.complete(response(attempt.state));
    expect(consumeNativeOidcProof(proof).claims).toMatchObject({
      issuer: idp.config.issuer,
      subject: "owned-person",
      organizationId: "org_actual",
    });
    expect(idp.requests.map((row) => row.host)).toEqual([
      new URL(idp.config.issuer).host,
      new URL(idp.tokenBase).host,
      new URL(idp.jwksBase).host,
    ]);
    expect(idp.errors).toEqual([]);
  },
);
it.each(["token", "jwks"] as const)(
  "refuses a discovered unsupported %s origin before any credential or delegated network I/O",
  async (split) => {
    const idp = await tlsOracle("client_secret_basic", split);
    const origin = new URL(split === "token" ? idp.tokenBase : idp.jwksBase)
      .origin;
    idp.withdraw(origin);
    await expect(
      prepareConfiguredOidc(idp.config, callback, idp.transport, idp.owner),
    ).rejects.toThrow(/original native route/);
    expect(idp.requests.map((row) => row.path)).toEqual([
      "/issuer/.well-known/openid-configuration",
    ]);
    expect(
      idp.requests.every((row) => row.body === "" && row.basic === ""),
    ).toBe(true);
    expect(idp.errors).toEqual([]);
  },
);
it.each([
  "before exchange",
  "token response",
  "JWKS response",
  "proof consumption",
])(
  "refuses original split-host route withdrawal at %s without adopting renewed approval",
  async (phase) => {
    const idp = await tlsOracle("client_secret_basic", "both");
    const origin = new URL(idp.tokenBase).origin;
    const attempt = await prepareConfiguredOidc(
      idp.config,
      callback,
      idp.transport,
      idp.owner,
    );
    idp.authorize(attempt.authorizationUrl);
    if (phase === "before exchange") idp.withdraw(origin);
    else if (phase !== "proof consumption")
      idp.observe((path) => {
        if (
          path ===
          (phase === "token response" ? "/issuer/token" : "/issuer/jwks")
        )
          idp.withdraw(origin);
      });
    if (phase === "proof consumption") {
      const proof = await attempt.complete(response(attempt.state));
      idp.withdraw(origin);
      expect(() => consumeNativeOidcProof(proof)).toThrow(
        /original native route/,
      );
      idp.approve(origin);
      expect(() => consumeNativeOidcProof(proof)).toThrow(/already consumed/);
    } else {
      await expect(attempt.complete(response(attempt.state))).rejects.toThrow(
        /original native route/,
      );
      idp.approve(origin);
      await expect(attempt.complete(response(attempt.state))).rejects.toThrow(
        /already consumed/,
      );
    }
    expect(idp.requests).toHaveLength(
      phase === "before exchange" ? 1 : phase === "token response" ? 2 : 3,
    );
    expect(idp.errors).toEqual([]);
  },
);
it("retains the originally captured support method instead of adopting a replacement", async () => {
  const idp = await tlsOracle("client_secret_basic", "both");
  const attempt = await prepareConfiguredOidc(
    idp.config,
    callback,
    idp.transport,
    idp.owner,
  );
  idp.transport.supportsNativeOrigin = () => true;
  await expect(attempt.complete(response(attempt.state))).rejects.toThrow(
    /route changed/,
  );
  expect(idp.requests).toHaveLength(1);
});
it("an absent native origin approval cannot delegate I/O to the captured base transport", async () => {
  const idp = await tlsOracle("client_secret_basic", "both");
  const { supportsNativeOrigin, ...base } = idp.transport;
  expect(supportsNativeOrigin(new URL(idp.tokenBase).origin)).toBe(true);
  await expect(
    prepareConfiguredOidc(idp.config, callback, base, idp.owner),
  ).rejects.toThrow(/original native route/);
  expect(idp.requests).toHaveLength(1);
});

it.each(
  [
    "transport fetch",
    "transport assertion",
    "transport signal",
    "owner assertion",
    "owner signal",
  ].flatMap((field) =>
    ["discovery", "token", "jwks", "proof consumption", "support reentry"].map(
      (phase) => [field, phase],
    ),
  ),
)("rejects replacement of original %s during %s", assertOriginalOidcAuthority);
it(
  "snapshots configured secret and organization before authority callbacks",
  assertOidcConfigurationSnapshot,
);
