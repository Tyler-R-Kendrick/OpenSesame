import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
} from "./linear-connectors.js";
import {
  installLinearProvider,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import { linearPublicRecord, updateLinearRecord } from "./linear-store.js";

export function recoveryResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export function recoveryRequest(init?: RequestInit) {
  const body: BoundaryValue = JSON.parse(String(init?.body));
  if (!isJsonObject(body) || !isString(body.query))
    throw new Error("GraphQL request required");
  return body.query;
}
export const recoveryOptions = {
  ...linearOptions,
  workspace: "",
  appScopes: ["read", "admin"],
  webhookEnabled: true,
  webhookUrl: "https://hooks.example.org/linear",
  webhookResourceTypes: ["Issue"],
};

export async function oauthWebhookFixture(pendingHook = false) {
  const saved = await configureLinearConnector(linearDraft("oauth"), {
    ...recoveryOptions,
    webhookEnabled: false,
  });
  const pending = pendingLinear(saved.connectionId);
  linearAnswers(
    { body: { ...linearToken, scope: "read admin" } },
    { body: { data: linearAccount } },
  );
  await finishLinearAuthorization(
    `?linear_state=${pending.state}&linear_code=initial`,
  );
  const provider = installLinearProvider();
  if (pendingHook)
    provider.onCreate = () => {
      vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
        new Error("Webhook completion could not be stored"),
      );
    };
  const configure = configureLinearConnector(
    linearDraft("oauth"),
    recoveryOptions,
    saved.connectionId,
  );
  if (pendingHook) {
    await configure.catch(() => undefined);
    if (!readDeviceSecrets()[saved.connectionId]?.linear_webhook_intent)
      throw new Error("Webhook intent required");
  } else await configure;
  provider.onCreate = () => {};
  await updateLinearRecord(saved.connectionId, async (record, runtime) => {
    if (!runtime.app) throw new Error("App authorization required");
    return linearPublicRecord(record, {
      ...runtime,
      app: { ...runtime.app, needsReauth: true, expiresAt: Date.now() - 1000 },
    });
  });
  return { id: saved.connectionId, provider };
}

type RecoveryProvider = {
  revoked: string[];
  issued: string[];
  failDelete: boolean;
  failCreate: boolean;
  failNetwork: boolean;
  wrongWorkspace: boolean;
};
function recoveryOAuthResponse(
  destination: string,
  form: URLSearchParams,
  fixture: RecoveryProvider,
): Response | null {
  if (destination.endsWith("/oauth/revoke")) {
    const token = form.get("token") ?? "";
    fixture.revoked.push(token);
    return token.startsWith("private-")
      ? recoveryResponse({ error: "invalid_grant" }, 400)
      : recoveryResponse({});
  }
  if (!destination.endsWith("/oauth/token")) return null;
  if (form.get("grant_type") === "refresh_token")
    return recoveryResponse({ error: "invalid_grant" }, 400);
  const code = form.get("code") ?? "";
  fixture.issued.push(code);
  return recoveryResponse({
    ...linearToken,
    access_token: `fresh-${code}`,
    refresh_token: `fresh-refresh-${code}`,
    scope: code === "desired" ? "read" : "read admin",
  });
}
/** Old tokens are proven invalid; replacement codes bind to a selectable test workspace. */
export function installRecoveryProvider() {
  const providerFetch = linearApiSeams.fetch;
  const fixture: RecoveryProvider = {
    revoked: [],
    issued: [],
    failDelete: false,
    failCreate: false,
    failNetwork: false,
    wrongWorkspace: false,
  };
  linearApiSeams.fetch = vi.fn(async (url, init) => {
    const destination = String(url);
    const form = new URLSearchParams(String(init?.body));
    const oauthReply = recoveryOAuthResponse(destination, form, fixture);
    if (oauthReply) return oauthReply;
    const query = recoveryRequest(init);
    const authorization = new Headers(init?.headers).get("authorization");
    if (fixture.failNetwork) throw new Error("Transport unavailable");
    if (authorization === "Bearer private-access")
      return recoveryResponse({ errors: [] }, 401);
    if (query.includes("OpenSesameDeleteWebhook") && fixture.failDelete)
      return recoveryResponse({}, 503);
    if (query.includes("OpenSesameWebhook(") && fixture.failCreate)
      return recoveryResponse({}, 503);
    if (query.includes("OpenSesameAccount") && fixture.wrongWorkspace)
      return recoveryResponse({
        data: {
          ...linearAccount,
          organization: {
            id: "other-workspace",
            name: "Other workspace",
            urlKey: "other",
          },
        },
      });
    return providerFetch(url, init);
  });
  return fixture;
}

export async function finishRecoveryConsent(id: string, code = "cleanup") {
  const pending = pendingLinear(id);
  return finishLinearAuthorization(
    `?linear_state=${pending.state}&linear_code=${code}`,
  );
}
