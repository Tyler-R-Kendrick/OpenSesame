import { afterEach, expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { catalogProvider } from "./connector-catalog.js";
import { readDeviceRows } from "./device-connector-records.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  assertNativeOAuthClientPolicy,
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import {
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

function accountInput(input: NativeDriverInput): NativeDriverInput {
  const oauth = connectPlan("google-drive")?.methods.find(
    (method) => method.kind === "oauth",
  );
  if (oauth?.kind !== "oauth" || !oauth.preset?.userinfoEndpoint)
    throw new Error("Expected the account-only OIDC contract");
  const preset = oauth.preset;
  const resource = preset.userinfoEndpoint;
  if (!resource) throw new Error("Expected the OIDC user-info endpoint");
  return {
    ...input,
    providerId: "google-drive",
    parameters: {
      ...input.parameters,
      issuer: preset.serverUrl,
      authorization_endpoint: preset.authorizationEndpoint,
      token_endpoint: preset.tokenEndpoint,
      resource,
    },
    requestedScopes: { user: ["openid", "email"] },
  };
}

async function setup(method?: Parameters<typeof nativeOAuthClientFixture>[0]) {
  const fixture = await nativeOAuthClientFixture(method);
  closes.push(fixture.close);
  return { ...fixture, input: accountInput(fixture.input) };
}

it("pins Google Drive to account-only OIDC scopes and user-info", async () => {
  const fixture = await setup();
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  expect(saved.configuration.requestedScopes).toEqual({
    user: ["openid", "email"],
  });
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
    "openid",
    "email",
  ]);
  expect(fixture.requests).toHaveLength(0);
  const configuration = requireNativeOAuthRecord(
    saved.connectionId,
  ).configuration;
  expect(() =>
    assertNativeOAuthClientPolicy(
      {
        ...configuration,
        parameters: {
          ...configuration.parameters,
          resource: "https://www.googleapis.com/drive/v3/files",
        },
      },
      fixture.owner,
    ),
  ).toThrowError(expect.objectContaining({ code: "scope" }));
});

it("compiles only account identity operations and user-info egress", () => {
  const provider = catalogProvider("google-drive");
  if (!provider) throw new Error("Expected Google Drive");
  expect(provider.operations).toEqual(["account.read"]);
  expect(provider.scopes.map((scope) => scope.name)).toEqual([
    "openid",
    "email",
  ]);
  expect(provider.egress.pathPrefixes).toEqual(["/oauth2/v3/userinfo"]);
});

it("retains a broader granted scope only for cleanup without activating it", async () => {
  const fixture = await setup();
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  const calls: string[] = [];
  const reply = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init).url);
    return Response.json({
      access_token: "synthetic-account-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email https://www.googleapis.com/auth/drive.readonly",
    });
  };
  fixture.owner.transport.fetch = reply;
  fixture.owner.transport.settleCredentialMutation = reply;
  await expect(
    exchangeNativeOAuthClient(
      new URLSearchParams({
        native_state: authorization.searchParams.get("state") ?? "",
        native_code: "one-use-code",
      }).toString(),
      fixture.owner,
    ),
  ).rejects.toThrow();
  expect(calls).toEqual(["https://oauth2.googleapis.com/token"]);
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
  expect(record.privateState.grants).toEqual({});
  expect(
    record.privateState.recovery.some(
      (entry) =>
        entry.credentials?.protocol_valid === "false" &&
        entry.grant?.scopes === null,
    ),
  ).toBe(true);
});

it("allows legacy Drive-scoped records to be removed without authorizing use", async () => {
  const fixture = await setup("client_secret_post");
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const legacy = await updateNativeConnector(
    saved.connectionId,
    saved,
    nativeOAuthClientClassification(),
    (current) => {
      current.configuration.requestedScopes = {
        user: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/drive.readonly",
        ],
      };
      return current;
    },
  );
  expect(() => nativeOAuthClientTarget(legacy.configuration)).not.toThrow();
  expect(() =>
    assertNativeOAuthClientPolicy(legacy.configuration, fixture.owner),
  ).toThrowError(expect.objectContaining({ code: "scope" }));
  const stored = requireNativeOAuthRecord(saved.connectionId);
  const reference =
    stored.privateState.credentials.oauth_client_reference ?? "";
  const fingerprint = stored.configuration.fingerprint;
  expect(
    readVaultCredentialsForWithdrawal(
      reference,
      fingerprint,
      ["clientSecret"],
      fixture.owner.tomb,
    )?.fields.get("clientSecret"),
  ).toBe(CLIENT_SECRET);
  const driver = createNativeOAuthResourceDriver({
    supports: (id) => id === "google-drive",
    capture: () => ({ ...fixture.owner, close: () => {} }),
  });
  const unregister = registerNativeProviderCleanup(
    "google-drive",
    driver.cleanup,
  );
  closes.push(async () => unregister());
  expect(await removeNativeConnectorWithCleanup(saved.connectionId)).toBe(true);
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(
    readVaultCredentialsForWithdrawal(
      reference,
      fingerprint,
      ["clientSecret"],
      fixture.owner.tomb,
    ),
  ).toBeNull();
  expect(fixture.requests).toHaveLength(0);
});

async function accountAuthorization(
  fixture: Awaited<ReturnType<typeof setup>>,
  saved: Awaited<ReturnType<typeof configureNativeOAuthClient>>,
) {
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  fixture.state.challenge =
    authorization.searchParams.get("code_challenge") ?? "";
  fixture.state.resource = fixture.input.parameters.resource ?? "";
  return new URLSearchParams({
    native_state: authorization.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
}

function accountAuthority(fixture: Awaited<ReturnType<typeof setup>>) {
  const calls: string[] = [];
  const reply = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.url);
    if (request.url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-account-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email",
      });
    if (request.url === "https://www.googleapis.com/oauth2/v3/userinfo")
      return Response.json({
        sub: "synthetic-account",
        email: "operator@example.test",
      });
    throw new Error("Unexpected provider request");
  };
  fixture.owner.transport.fetch = reply;
  fixture.owner.transport.settleCredentialMutation = reply;
  return calls;
}

it("refuses a legacy Drive-scoped pending authorization before token exchange", async () => {
  const fixture = await setup();
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const callback = await accountAuthorization(fixture, saved);
  const calls = accountAuthority(fixture);
  const view = readNativeConnector(saved.connectionId);
  if (!view) throw new Error("Expected the pending account configuration");
  await updateNativeConnector(
    saved.connectionId,
    view,
    nativeOAuthClientClassification(),
    (current) => {
      const pending = current.privateState.pending.user;
      if (!pending) throw new Error("Expected a pending authorization");
      pending.scopes = [
        "openid",
        "email",
        "https://www.googleapis.com/auth/drive.readonly",
      ];
      return current;
    },
  );
  await expect(
    exchangeNativeOAuthClient(callback, fixture.owner),
  ).rejects.toMatchObject({ code: "scope" });
  expect(calls).toEqual([]);
  expect(fixture.requests).toHaveLength(0);
});

it.each(["active", "recovery"] as const)(
  "refuses a legacy Drive-scoped %s grant before using it",
  async (location) => {
    const fixture = await setup();
    const saved = await configureNativeOAuthClient(
      fixture.input,
      fixture.owner,
    );
    const callback = await accountAuthorization(fixture, saved);
    const calls = accountAuthority(fixture);
    await exchangeNativeOAuthClient(callback, fixture.owner);
    const driver = createNativeOAuthResourceDriver({
      supports: (id) => id === "google-drive",
      capture: () => ({ ...fixture.owner, close: () => {} }),
    });
    if (location === "active") await driver.verify(saved.connectionId);
    const current = readNativeConnector(saved.connectionId);
    if (!current) throw new Error("Expected the saved account configuration");
    await updateNativeConnector(
      saved.connectionId,
      current,
      nativeOAuthClientClassification(),
      (record) => {
        const grant =
          location === "active"
            ? record.privateState.grants.user
            : record.privateState.recovery[0]?.grant;
        if (!grant) throw new Error("Expected a retained grant");
        grant.scopes = [
          "openid",
          "email",
          "https://www.googleapis.com/auth/drive.readonly",
        ];
        return record;
      },
    );
    if (location === "active") {
      const legacy = requireNativeOAuthRecord(saved.connectionId);
      await updateNativeConnector(
        saved.connectionId,
        {
          revision: legacy.revision,
          fingerprint: legacy.configuration.fingerprint,
        },
        nativeOAuthClientClassification(),
        (record) => {
          record.privateState.verification = {
            fingerprint: record.configuration.fingerprint,
            verifiedAt: current.verifiedAt ?? Date.now(),
            kind: "provider",
          };
          record.runtime.verifiedAt = current.verifiedAt ?? Date.now();
          return record;
        },
      );
    }
    await expect(driver.verify(saved.connectionId)).rejects.toMatchObject({
      code: "scope",
    });
    expect(calls).toEqual(
      location === "active"
        ? [
            "https://oauth2.googleapis.com/token",
            "https://www.googleapis.com/oauth2/v3/userinfo",
          ]
        : ["https://oauth2.googleapis.com/token"],
    );
  },
);

const forbidden: readonly [
  string,
  string,
  (input: NativeDriverInput) => void,
][] = [
  [
    "a Drive scope",
    "scope",
    (input) => {
      input.requestedScopes.user = [
        "openid",
        "email",
        "https://www.googleapis.com/auth/drive.readonly",
      ];
    },
  ],
  [
    "a Drive resource",
    "scope",
    (input) => {
      input.parameters.resource = "https://www.googleapis.com/drive/v3/files";
    },
  ],
  [
    "a Drive token relay",
    "scope",
    (input) => {
      input.parameters.token_relay_url =
        "https://www.googleapis.com/drive/v3/files";
    },
  ],
  [
    "a non-account actor",
    "callback",
    (input) => {
      input.requestedScopes.app = [
        "https://www.googleapis.com/auth/drive.readonly",
      ];
    },
  ],
];

it.each(forbidden)(
  "refuses %s before saving or making a request",
  async (_, code, change) => {
    const fixture = await setup();
    change(fixture.input);
    await expect(
      configureNativeOAuthClient(fixture.input, fixture.owner),
    ).rejects.toMatchObject({ code });
    expect(fixture.requests).toHaveLength(0);
    expect(
      readDeviceRows().some((row) => row.providerId === "google-drive"),
    ).toBe(false);
  },
);
