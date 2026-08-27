import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type PasswordlessSignin,
  createAuthenticationClient,
} from "@opensesame/sdk-browser";
import { currentSession, identityBase, identityJson } from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";

export type AuthenticationApplicationView = {
  id: string;
  ownerPrincipalId: string;
  organizationId: string | null;
  displayName: string;
  rpId: string;
  origins: string[];
  secretPrefix: string;
  apiKeys: Array<{
    id: string;
    secretPrefix: string;
    state: "active" | "locked";
    createdAt: string;
  }>;
  configurations: Array<{
    purpose: string;
    timeToLiveSeconds: number;
    userVerification: "discouraged" | "preferred" | "required";
    hints: Array<"client-device" | "hybrid" | "security-key">;
  }>;
  manualTokensEnabled: boolean;
  magicLinksEnabled: boolean;
  state: "active" | "suspended" | "revoked";
  createdAt: string;
  updatedAt: string;
};

export type AuthenticationUserView = {
  applicationId: string;
  userId: string;
  userName: string;
  displayName: string;
  aliases: string[];
  credentials: Array<{
    credentialId: string;
    name: string | null;
    transports: string[];
    createdAt: string;
    lastUsedAt: string | null;
  }>;
};

export type AuthenticationEventView = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
};

export async function listAuthenticationApplications() {
  return (
    await identityJson<{ applications: AuthenticationApplicationView[] }>(
      "/v1/authentication/applications",
    )
  ).applications;
}

export async function createAuthenticationApplication(input: {
  displayName: string;
  rpId: string;
  origins: string[];
  organizationId?: string;
}) {
  return identityJson<{
    application: AuthenticationApplicationView;
    apiSecret: string;
  }>("/v1/authentication/applications", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function rotateAuthenticationApplicationSecret(
  applicationId: string,
) {
  return identityJson<{
    application: AuthenticationApplicationView;
    apiSecret: string;
  }>(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}/rotate-secret`,
    {
      method: "POST",
    },
  );
}

export async function updateAuthenticationApplication(
  applicationId: string,
  patch: Partial<
    Pick<
      AuthenticationApplicationView,
      | "configurations"
      | "displayName"
      | "magicLinksEnabled"
      | "manualTokensEnabled"
      | "state"
    >
  >,
) {
  return identityJson<{ application: AuthenticationApplicationView }>(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export async function createAuthenticationApiKey(applicationId: string) {
  return identityJson<{
    application: AuthenticationApplicationView;
    apiKey: { id: string; secret: string };
  }>(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}/api-keys`,
    {
      method: "POST",
    },
  );
}

export async function updateAuthenticationApiKey(
  applicationId: string,
  keyId: string,
  state: "active" | "locked",
) {
  return identityJson<{ application: AuthenticationApplicationView }>(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}/api-keys/${encodeURIComponent(keyId)}`,
    { method: "PATCH", body: JSON.stringify({ state }) },
  );
}

export async function deleteAuthenticationApiKey(
  applicationId: string,
  keyId: string,
) {
  return identityJson<{ application: AuthenticationApplicationView }>(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}/api-keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
  );
}

export async function listAuthenticationUsers(applicationId: string) {
  return (
    await identityJson<{ users: AuthenticationUserView[] }>(
      `/v1/authentication/applications/${encodeURIComponent(applicationId)}/users`,
    )
  ).users;
}

export async function listAuthenticationEvents(applicationId: string) {
  return (
    await identityJson<{ events: AuthenticationEventView[] }>(
      `/v1/authentication/applications/${encodeURIComponent(applicationId)}/events`,
    )
  ).events;
}

export async function listAuthenticationOrganizationEvents(
  organizationId: string,
) {
  return (
    await identityJson<{ events: AuthenticationEventView[] }>(
      `/v1/authentication/organizations/${encodeURIComponent(organizationId)}/events`,
    )
  ).events;
}

export async function removeAuthenticationCredential(
  applicationId: string,
  credentialId: string,
): Promise<void> {
  await identityJson(
    `/v1/authentication/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

async function createOwnRegistrationToken(
  applicationId: string,
  userName: string,
  alias: string,
) {
  const session = currentSession();
  if (!session)
    throw new Error("Connect Identity before registering a passkey.");
  return identityJson<{ token: string }>(
    "/v1/authentication/backend/registration-tokens",
    {
      method: "POST",
      body: JSON.stringify({
        applicationId,
        userId: session.principalId,
        userName,
        displayName: userName,
        aliases: alias ? [alias] : [],
      }),
    },
  );
}

function client(applicationId: string) {
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    return localNetworkFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: request.credentials,
      signal: request.signal,
    });
  };
  return createAuthenticationClient({
    apiBase: identityBase(),
    applicationId,
    fetchImpl,
  });
}

export async function registerPwaPasskey(input: {
  applicationId: string;
  userName: string;
  alias: string;
  credentialName?: string;
}) {
  const registration = await createOwnRegistrationToken(
    input.applicationId,
    input.userName,
    input.alias,
  );
  return client(input.applicationId).register(
    registration.token,
    input.credentialName,
  );
}

export async function signinWithAuthenticationService(
  applicationId: string,
  input: PasswordlessSignin,
) {
  return client(applicationId).signin(input);
}

export async function exchangeAuthenticationToken(
  applicationId: string,
  apiSecret: string,
  token: string,
) {
  const response = await localNetworkFetch(
    `${identityBase()}/v1/authentication/backend/signin/verify-token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiSecret}`,
        "content-type": "application/json",
      },
      credentials: "omit",
      body: JSON.stringify({ applicationId, token }),
    },
  );
  if (!response.ok)
    throw new Error(`Token exchange failed (${response.status}).`);
  const body: BoundaryValue = await response.json();
  if (
    !isJsonObject(body) ||
    body.success !== true ||
    !isString(body.userId) ||
    !Array.isArray(body.aliases) ||
    !body.aliases.every(isString)
  ) {
    throw new Error("Token exchange returned an invalid response.");
  }
  return { success: true as const, userId: body.userId, aliases: body.aliases };
}
